import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

/** The plugin resolves Host packages through the running dsh install. */
async function loadPlugin() {
  try {
    return await import('../lib/index.js')
  } catch (error) {
    return { error }
  }
}

/** Minimal Cordis-like context capturing registrations. */
function fakeContext() {
  const sections = []
  const tools = []
  const effects = []
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(factory) {
      effects.push(factory())
      return () => {}
    },
    on() {},
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
  }
  return { ctx, sections, tools, effects }
}

/** Fake agent/session pair. */
function fakeAgent(cwd, extra = {}) {
  return { session: { header: { cwd, id: 'sess-test', ...extra } } }
}

/** Render one section by name. */
function sectionText(sections, name, agent) {
  const section = sections.find((candidate) => candidate.name === name)
  assert.ok(section !== undefined, `missing section ${name}`)
  return typeof section.text === 'function' ? section.text({ agent }) : section.text
}

test('registers two prompt sections and four memory tools', async (t) => {
  const plugin = await loadPlugin()
  if (plugin.error !== undefined) {
    t.skip(`Host packages unavailable: ${plugin.error.message}`)
    return
  }
  const { ctx, sections, tools } = fakeContext()
  plugin.apply(ctx, { enabled: true, memoryHome: mkdtempSync(join(tmpdir(), 'dsh-memory-plugin-')) })
  assert.deepEqual(sections.map((section) => section.name), ['memory:protocol', 'memory:context'])
  assert.equal(sections[0].order, 9400)
  assert.equal(sections[1].order, 9500)
  assert.equal(sections[0].interpolate, false)
  assert.match(sectionText(sections, 'memory:protocol', undefined), /记忆协议/)
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['memory_forget', 'memory_list', 'memory_recall', 'memory_save'])
})

test('memory context starts empty and reflects a saved entry immediately', async (t) => {
  const plugin = await loadPlugin()
  if (plugin.error !== undefined) {
    t.skip(`Host packages unavailable: ${plugin.error.message}`)
    return
  }
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-plugin-'))
  const project = join(root, 'claude_projects')
  mkdirSync(join(project, '.git'), { recursive: true })
  const memoryHome = join(root, 'memory')
  const { ctx, sections, tools } = fakeContext()
  plugin.apply(ctx, { enabled: true, memoryHome })
  const agent = fakeAgent(project)
  assert.equal(sectionText(sections, 'memory:context', agent), '')

  const save = tools.find((tool) => tool.name === 'memory_save')
  const saved = await save.execute({ title: 'Zero runtime dependencies', content: '**结论**：不写 dependencies', type: 'constraint' }, { agent, signal: AbortSignal.timeout(2000) })
  assert.equal(saved.ok, true)
  assert.equal(saved.scope, 'project')

  const rendered = sectionText(sections, 'memory:context', agent)
  assert.match(rendered, /项目记忆 · claude_projects/)
  assert.match(rendered, /插件零运行时依赖|Zero runtime dependencies|零运行时依赖/)
})

test('user layer is hidden from subagent sessions by default', async (t) => {
  const plugin = await loadPlugin()
  if (plugin.error !== undefined) {
    t.skip(`Host packages unavailable: ${plugin.error.message}`)
    return
  }
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-plugin-'))
  const project = join(root, 'claude_projects')
  mkdirSync(join(project, '.git'), { recursive: true })
  const { ctx, sections, tools } = fakeContext()
  plugin.apply(ctx, { enabled: true, memoryHome: join(root, 'memory') })
  const agent = fakeAgent(project)
  await tools.find((tool) => tool.name === 'memory_save').execute(
    { title: 'User level rule', content: 'u', scope: 'user', type: 'preference' },
    { agent, signal: AbortSignal.timeout(2000) },
  )
  await tools.find((tool) => tool.name === 'memory_save').execute(
    { title: 'Project level rule', content: 'p', type: 'decision' },
    { agent, signal: AbortSignal.timeout(2000) },
  )
  const parent = sectionText(sections, 'memory:context', agent)
  assert.match(parent, /User level rule/)
  assert.match(parent, /Project level rule/)
  const child = sectionText(sections, 'memory:context', fakeAgent(project, { origin: 'subagent', delegationDepth: 1 }))
  assert.doesNotMatch(child, /User level rule/)
  assert.match(child, /Project level rule/)
})

test('disabled plugin contributes nothing', async (t) => {
  const plugin = await loadPlugin()
  if (plugin.error !== undefined) {
    t.skip(`Host packages unavailable: ${plugin.error.message}`)
    return
  }
  const { ctx, sections } = fakeContext()
  plugin.apply(ctx, { enabled: false, memoryHome: mkdtempSync(join(tmpdir(), 'dsh-memory-plugin-')) })
  assert.equal(sectionText(sections, 'memory:protocol', undefined), '')
  assert.equal(sectionText(sections, 'memory:context', fakeAgent(tmpdir())), '')
})

test('a memory written by one session is visible to another session', async (t) => {
  const plugin = await loadPlugin()
  if (plugin.error !== undefined) {
    t.skip(`Host packages unavailable: ${plugin.error.message}`)
    return
  }
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-plugin-'))
  const project = join(root, 'claude_projects')
  mkdirSync(join(project, '.git'), { recursive: true })
  const memoryHome = join(root, 'memory')

  const first = fakeContext()
  plugin.apply(first.ctx, { enabled: true, memoryHome })
  await first.tools.find((tool) => tool.name === 'memory_save').execute(
    { title: 'Package manager is pnpm', content: '**结论**：用 pnpm，不用 npm', type: 'decision' },
    { agent: fakeAgent(project), signal: AbortSignal.timeout(2000) },
  )

  const second = fakeContext()
  plugin.apply(second.ctx, { enabled: true, memoryHome })
  const rendered = sectionText(second.sections, 'memory:context', fakeAgent(project))
  assert.match(rendered, /Package manager is pnpm/)
})
