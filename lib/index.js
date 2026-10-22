/**
 * dsh-memory: layered persistent memory for DeepSeek Harness.
 *
 * Reads two markdown layers (user + project), renders them into the system
 * prompt, and exposes four tools that write them back. Storage is plain files:
 * the memory directory stays readable, greppable and hand-editable.
 *
 * Host-only by design — no settings page, no client bundle, no HTTP route.
 *
 * @module dsh-memory
 */
import { existsSync } from 'node:fs'
import { hostImport, hostRequire } from './host.js'
import { resolveProject, scopeDir } from './paths.js'
import { loadEntries } from './store.js'
import { renderMemory } from './render.js'
import { protocolText } from './protocol.js'
import { forgetMemory, listMemory, recallMemory, saveMemory, MAX_ENTRY_BYTES } from './handlers.js'
import { TYPES } from './store.js'

const z = hostRequire('@deepseek-ai/schemastery')
const { defineTool } = await hostImport('@deepseek-ai/dsh-tools')

/** Loader entry id (also the id Settings would address). */
export const name = 'memory'

/** Host services consumed by this plugin. */
export const inject = ['systemPrompt', 'tools']

/** Section orders: after tool guidance, before harness/delivery bookkeeping. */
const PROTOCOL_ORDER = 9400
const CONTEXT_ORDER = 9500

/** Volatile so a future Settings page can change them without a restart. */
const volatile = (schema) => (typeof schema.volatile === 'function' ? schema.volatile() : schema)

export const Config = z.object({
  enabled: volatile(z.boolean().default(true)),
  memoryHome: volatile(z.string().default('')),
  userMaxChars: volatile(z.number().default(1500)),
  projectMaxChars: volatile(z.number().default(2500)),
  pinnedMaxChars: volatile(z.number().default(400)),
  injectIntoSubagents: volatile(z.boolean().default(false)),
  autoMemorize: volatile(z.boolean().default(true)),
  log: volatile(z.boolean().default(true)),
})

/** Volatile fields may arrive as `{ get() }` references. */
function unwrap(node) {
  return node !== null && typeof node === 'object' && typeof node.get === 'function' ? node.get() : node
}

/** Default memory home: `$DSH_HOME/memory`. */
function defaultMemoryHome() {
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.trim() !== '') return `${home.replace(/[\\/]+$/, '')}/memory`
  return `${process.env.HOME ?? process.env.USERPROFILE ?? '.'}/.dsh/memory`
}

/** Immutable view of the live configuration. */
function snapshot(config) {
  const number = (value, fallback) => {
    const parsed = Number(unwrap(value))
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
  }
  const rawHome = String(unwrap(config?.memoryHome) ?? '').trim()
  return {
    enabled: unwrap(config?.enabled) !== false,
    memoryHome: rawHome === '' ? defaultMemoryHome() : rawHome.replace(/[\\/]+$/, ''),
    userMaxChars: number(config?.userMaxChars, 1500),
    projectMaxChars: number(config?.projectMaxChars, 2500),
    pinnedMaxChars: number(config?.pinnedMaxChars, 400),
    injectIntoSubagents: unwrap(config?.injectIntoSubagents) === true,
    autoMemorize: unwrap(config?.autoMemorize) !== false,
    log: unwrap(config?.log) !== false,
  }
}

/** Incremented on every write so render caches refresh on the next assembly. */
let writeEpoch = 0

/** TTL cache of loaded entries; assemblies are synchronous so reads are cached. */
const cache = { key: '', at: 0, user: [], project: [], label: '', omitted: 0 }

/**
 * Load both layers for one project, reusing the cache when nothing changed.
 * @param {object} settings - configuration snapshot.
 * @param {object} project - resolved project identity.
 * @param {boolean} includeUser - whether the user layer participates.
 * @returns {{ user: object[], project: object[], label: string }} loaded entries.
 */
function loadLayers(settings, project, includeUser) {
  const key = [writeEpoch, settings.memoryHome, project.key, includeUser, settings.userMaxChars, settings.projectMaxChars, settings.pinnedMaxChars].join('|')
  const now = Date.now()
  if (key === cache.key && now - cache.at < 2000) return cache
  cache.key = key
  cache.at = now
  cache.user = includeUser ? loadEntries(scopeDir(settings.memoryHome, 'user', null)) : []
  cache.project = loadEntries(scopeDir(settings.memoryHome, 'project', project))
  cache.label = project.label
  return cache
}

/**
 * Render the memory section for one assembly. Must never throw: a failing
 * section would break every model request.
 * @param {object | undefined} agent - assembly agent, when the assembly belongs to one.
 * @param {object} settings - configuration snapshot.
 * @returns {string} rendered memory text, possibly empty.
 */
function renderFor(agent, settings) {
  try {
    if (!settings.enabled) return ''
    const header = agent?.session?.header
    const cwd = typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : null
    if (cwd === null) return ''
    const isSubagent = header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0
    const includeUser = settings.injectIntoSubagents || !isSubagent
    const project = resolveProject(cwd)
    const layers = loadLayers(settings, project, includeUser)
    return renderMemory({
      userEntries: layers.user,
      projectEntries: layers.project,
      projectLabel: layers.label,
      includeUser,
      limits: { userMaxChars: settings.userMaxChars, projectMaxChars: settings.projectMaxChars, pinnedMaxChars: settings.pinnedMaxChars },
    })
  } catch {
    return ''
  }
}

/** Call environment for the memory handlers. */
function execEnv(exec, settings) {
  const header = exec?.agent?.session?.header
  return {
    cwd: typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : process.cwd(),
    memoryHome: settings.memoryHome,
    sessionId: header?.id === undefined ? '' : String(header.id),
  }
}

/** Canonical tool output schema shared by all four memory tools. */
const OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    scope: { type: 'string' },
    slug: { type: 'string' },
    path: { type: 'string' },
    count: { type: 'number' },
    message: { type: 'string' },
  },
}

/** Project a handler result onto the declared output schema. */
function project(result) {
  const output = { ok: result.ok === true, scope: String(result.scope ?? 'project'), message: String(result.message ?? '') }
  if (typeof result.slug === 'string' && result.slug !== '') output.slug = result.slug
  if (typeof result.path === 'string' && result.path !== '') output.path = result.path
  if (typeof result.count === 'number') output.count = result.count
  return output
}

/** Model-facing renderer for one memory result. */
const renderResult = (_args, value) => [{ type: 'text', text: value.message }]

/**
 * Build the four memory tools against the live configuration.
 * @param {() => object} settingsOf - reads the current configuration.
 * @returns {object[]} tool definitions.
 */
function buildTools(settingsOf) {
  return [
    defineTool({
      name: 'memory_save',
      description:
        '把一条信息写入跨 session 的持久记忆。用户说「记一下/记忆一下/记住/别忘了」时用 scope="project"（默认）；用户说「在顶层记忆/用户级记忆/全局记忆/跨项目记住」时用 scope="user"。自己提炼成「结论/为什么/怎么用」，不要贴对话原文。写前先用 memory_recall 查重，已有相关条目就传 replace 更新。不要记录项目规范（写 AGENTS.md）、方法论（写 skill）、进度（写 HANDOVER）、临时状态或大段代码。',
      parameters: {
        title: { type: 'string', required: true, description: '一句话标题，中文，不超过 40 字' },
        content: { type: 'string', required: true, description: '记忆正文：结论 / 为什么 / 怎么用。只记结论和指针，不要贴整篇文档' },
        scope: { type: 'string', enum: ['project', 'user'], description: '默认 project（当前项目）。顶层/用户级/全局记忆用 user' },
        type: { type: 'string', enum: TYPES, description: 'constraint=硬约束/红线，preference=偏好，decision=已定决策，pitfall=踩过的坑，fact=事实，glossary=项目术语' },
        tags: { type: 'array', items: { type: 'string' }, description: '检索标签，2-4 个' },
        pinned: { type: 'boolean', description: 'true = 每次会话都注入全文（用于硬规则，慎用）' },
        replace: { type: 'string', description: '要替换的旧 slug（纠错时用），旧条目停止注入但保留可追溯' },
      },
      output: { schema: OUTPUT, render: renderResult },
      async execute(args, exec) {
        const settings = settingsOf()
        const result = saveMemory(execEnv(exec, settings), args)
        writeEpoch += 1
        return project(result)
      },
    }),
    defineTool({
      name: 'memory_recall',
      description: '读取一条记忆全文（传 slug），或按关键词检索两层记忆（传 query）。找「我之前说过什么」时用。',
      parameters: {
        slug: { type: 'string', description: '精确 slug；省略则按 query 检索' },
        query: { type: 'string', description: '关键词，大小写不敏感，匹配标题/正文/标签' },
        scope: { type: 'string', enum: ['project', 'user'], description: '省略则先查项目层再查用户层' },
      },
      output: { schema: OUTPUT, render: renderResult },
      async execute(args, exec) {
        return project(recallMemory(execEnv(exec, settingsOf()), args))
      },
    }),
    defineTool({
      name: 'memory_list',
      description: '列出项目层和用户层的记忆索引（slug + 类型 + 标题）。不确定记住了什么时先调它。',
      parameters: {
        scope: { type: 'string', enum: ['project', 'user'], description: '省略则两层都列' },
      },
      output: { schema: OUTPUT, render: renderResult },
      async execute(args, exec) {
        return project(listMemory(execEnv(exec, settingsOf()), args))
      },
    }),
    defineTool({
      name: 'memory_forget',
      description: '归档一条记忆（移到 archive/，不真删）。只在用户明确要求删除/忘记某条记忆时调用，不能自行清理。',
      parameters: {
        slug: { type: 'string', required: true, description: '要归档的 slug（先用 memory_list 查）' },
        scope: { type: 'string', enum: ['project', 'user'], description: '省略则先找项目层再找用户层' },
        reason: { type: 'string', description: '为什么归档，写进归档文件的头一行' },
      },
      output: { schema: OUTPUT, render: renderResult },
      async execute(args, exec) {
        const settings = settingsOf()
        const result = forgetMemory(execEnv(exec, settings), args)
        writeEpoch += 1
        return project(result)
      },
    }),
  ]
}

/**
 * Install the memory sections and tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} config - plugin configuration.
 */
export function apply(ctx, config) {
  const settingsOf = () => snapshot(config)
  const settings = settingsOf()
  if (settings.log) ctx.logger.info('dsh-memory: home=%s', settings.memoryHome)
  if (!existsSync(settings.memoryHome) && settings.log) {
    ctx.logger.info('dsh-memory: %s does not exist yet; it is created on the first write', settings.memoryHome)
  }
  ctx.effect(() => {
    const disposers = [
      ctx.systemPrompt.section({
        name: 'memory:protocol',
        order: PROTOCOL_ORDER,
        interpolate: false,
        text: () => {
          const live = settingsOf()
          return live.enabled ? protocolText({ autoMemorize: live.autoMemorize }) : ''
        },
      }),
      ctx.systemPrompt.section({
        name: 'memory:context',
        order: CONTEXT_ORDER,
        interpolate: false,
        text: (context) => renderFor(context?.agent, settingsOf()),
      }),
    ]
    for (const tool of buildTools(settingsOf)) disposers.push(ctx.tools.register(tool))
    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch {
          // Disposal must not mask the original failure.
        }
      }
    }
  }, 'memory.install')
  // Volatile settings changes must invalidate the render cache.
  ctx.on('loader/volatile-update', () => {
    writeEpoch += 1
  })
}

export { MAX_ENTRY_BYTES }
