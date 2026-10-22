/**
 * Memory operations behind the four tools, kept free of Cordis so they can be
 * exercised directly by unit tests.
 */
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { projectRelativeDir, resolveProject, scopeDir } from './paths.js'
import { archiveEntry, entriesDir, loadEntries, readEntry, rebuildIndex, writeEntry } from './store.js'

/** Hard cap on one entry body; memory is not a document store. */
export const MAX_ENTRY_BYTES = 32 * 1024

/** Directory holding all memory layers. */
export function memoryHomeOf(settings) {
  return settings.memoryHome
}

/**
 * Resolve the directories and project identity for one call.
 * @param {{ cwd: string, memoryHome: string }} env - call environment.
 * @returns {{ project: object, userDir: string, projectDir: string }} paths.
 */
export function resolveEnv(env) {
  const project = resolveProject(env.cwd)
  return {
    project,
    userDir: scopeDir(env.memoryHome, 'user', null),
    projectDir: scopeDir(env.memoryHome, 'project', project),
  }
}

/**
 * Record project root and last use so a moved checkout can be reattached later.
 * @param {string} directory - project scope directory.
 * @param {object} project - resolved project identity.
 * @param {string} sessionId - session that touched it.
 */
function touchProjectMeta(directory, project, sessionId) {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, '.project.json')
  let meta = { root: project.root, base: project.label, key: project.key, firstSeen: '', lastSeen: '', sessions: [] }
  try {
    if (existsSync(path)) meta = { ...meta, ...JSON.parse(readFileSync(path, 'utf8')) }
  } catch {
    // Malformed metadata is not worth failing a write over.
  }
  meta.root = project.root
  meta.base = project.label
  meta.key = project.key
  meta.lastSeen = new Date().toISOString()
  if (meta.firstSeen === '') meta.firstSeen = meta.lastSeen
  if (sessionId !== '' && !meta.sessions.includes(sessionId)) meta.sessions = [...meta.sessions.slice(-49), sessionId]
  writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

/**
 * Validate a save request before touching the filesystem.
 * @param {object} args - tool arguments.
 * @returns {string | null} an error message, or null when valid.
 */
function validateSave(args) {
  if (typeof args.title !== 'string' || args.title.trim() === '') return 'title 不能为空'
  if (args.title.length > 120) return 'title 太长（上限 120 字）'
  if (typeof args.content !== 'string' || args.content.trim() === '') return 'content 不能为空'
  if (Buffer.byteLength(args.content, 'utf8') > MAX_ENTRY_BYTES) return `content 超过 ${MAX_ENTRY_BYTES} 字节上限；只记结论和指针，不要贴整篇文档`
  if (args.scope !== undefined && args.scope !== 'project' && args.scope !== 'user') return 'scope 只能是 project 或 user'
  return null
}

/**
 * `memory_save`: create or update one memory.
 * @param {{ cwd: string, memoryHome: string, sessionId: string }} env - call environment.
 * @param {object} args - validated tool arguments.
 * @returns {object} canonical tool result.
 */
export function saveMemory(env, args) {
  const invalid = validateSave(args)
  if (invalid !== null) return { ok: false, action: 'rejected', scope: args.scope ?? 'project', slug: '', path: '', message: invalid }
  const scope = args.scope ?? 'project'
  const resolved = resolveEnv(env)
  const directory = scope === 'user' ? resolved.userDir : resolved.projectDir
  const { entry, replaced } = writeEntry(directory, {
    title: args.title.trim(),
    content: args.content.trim(),
    type: args.type,
    tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
    pinned: typeof args.pinned === 'boolean' ? args.pinned : undefined,
    replace: args.replace ?? null,
    scope,
    session: env.sessionId,
    dir: scope === 'project' ? projectRelativeDir(resolved.project.root, env.cwd) : '.',
    indexMeta: scope === 'user' ? { scope: 'user' } : { scope: 'project', projectLabel: resolved.project.label },
  })
  if (scope === 'project') touchProjectMeta(directory, resolved.project, env.sessionId)
  const action = replaced ? 'updated' : 'created'
  return {
    ok: true,
    action,
    scope,
    slug: entry.slug,
    path: entry.path,
    message: `${action === 'created' ? '已记住' : '已更新'}（${scope === 'user' ? '用户层' : `项目层 ${resolved.project.label}`} · ${entry.slug}）：${entry.title}`,
  }
}

/**
 * Extract a readable snippet around the first match.
 * @param {string} text - haystack.
 * @param {string} needle - lowercased needle.
 * @param {number} radius - characters of context.
 * @returns {string} snippet.
 */
function snippet(text, needle, radius = 90) {
  const index = text.toLowerCase().indexOf(needle)
  if (index < 0) return text.slice(0, radius * 2).replaceAll('\n', ' ')
  const start = Math.max(0, index - radius)
  return `${start > 0 ? '…' : ''}${text.slice(start, index + needle.length + radius).replaceAll('\n', ' ')}${index + needle.length + radius < text.length ? '…' : ''}`
}

/** Decide which scope directories a call covers. */
function candidateScopes(resolved, scope) {
  if (scope === 'user') return [['user', resolved.userDir]]
  if (scope === 'project') return [['project', resolved.projectDir]]
  return [['project', resolved.projectDir], ['user', resolved.userDir]]
}

/**
 * `memory_recall`: read one entry by slug, or search both layers by keyword.
 * @param {{ cwd: string, memoryHome: string }} env - call environment.
 * @param {object} args - tool arguments.
 * @returns {object} canonical tool result.
 */
export function recallMemory(env, args) {
  const resolved = resolveEnv(env)
  if (typeof args.slug === 'string' && args.slug.trim() !== '') {
    const slug = args.slug.trim()
    for (const [scope, directory] of candidateScopes(resolved, args.scope)) {
      const entry = readEntry(directory, slug)
      if (entry !== null) {
        return { ok: true, scope, count: 1, message: `[${scope}] ${entry.title}\n\n${entry.body}`, entries: [{ slug: entry.slug, scope, title: entry.title, type: entry.type, updated: entry.updated }] }
      }
    }
    return { ok: false, scope: args.scope ?? 'project', count: 0, message: `没有找到 slug 为 ${slug} 的记忆`, entries: [] }
  }
  const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
  if (query === '') return { ok: false, scope: args.scope ?? 'project', count: 0, message: '需要提供 slug 或 query', entries: [] }
  const hits = []
  for (const [scope, directory] of candidateScopes(resolved, args.scope)) {
    for (const entry of loadEntries(directory)) {
      if (entry.supersededBy !== null) continue
      const haystack = `${entry.title}\n${entry.body}\n${entry.tags.join(' ')}`.toLowerCase()
      if (!haystack.includes(query)) continue
      hits.push({ slug: entry.slug, scope, title: entry.title, type: entry.type, updated: entry.updated, snippet: snippet(`${entry.title}\n${entry.body}`, query) })
    }
  }
  if (hits.length === 0) return { ok: true, scope: args.scope ?? 'project', count: 0, message: `没有匹配「${args.query}」的记忆`, entries: [] }
  const shown = hits.slice(0, 10)
  const lines = shown.map((hit) => `- [${hit.scope}·${hit.type}] ${hit.slug} — ${hit.title}${hit.snippet === '' ? '' : `\n  ${hit.snippet}`}`)
  return { ok: true, scope: args.scope ?? 'project', count: hits.length, message: `匹配 ${hits.length} 条：\n${lines.join('\n')}${hits.length > shown.length ? `\n（只显示前 ${shown.length} 条）` : ''}`, entries: shown }
}

/**
 * `memory_list`: index of one or both layers.
 * @param {{ cwd: string, memoryHome: string }} env - call environment.
 * @param {object} args - tool arguments.
 * @returns {object} canonical tool result.
 */
export function listMemory(env, args) {
  const resolved = resolveEnv(env)
  const blocks = []
  let total = 0
  for (const [scope, directory] of candidateScopes(resolved, args.scope)) {
    const live = loadEntries(directory).filter((entry) => entry.supersededBy === null)
    total += live.length
    const label = scope === 'user' ? '用户层' : `项目层 ${resolved.project.label}`
    if (live.length === 0) {
      blocks.push(`${label}：空`)
      continue
    }
    blocks.push(`${label}（${live.length} 条）：\n${live.map((entry) => `- ${entry.slug} [${entry.type}${entry.pinned ? '·pinned' : ''}] ${entry.title}`).join('\n')}`)
  }
  return { ok: true, scope: args.scope ?? 'project', count: total, message: blocks.join('\n\n'), entries: [] }
}

/**
 * `memory_forget`: move one entry to the archive. Never unlinks.
 * @param {{ cwd: string, memoryHome: string }} env - call environment.
 * @param {object} args - tool arguments.
 * @returns {object} canonical tool result.
 */
export function forgetMemory(env, args) {
  const slug = typeof args.slug === 'string' ? args.slug.trim() : ''
  if (slug === '') return { ok: false, scope: args.scope ?? 'project', slug: '', path: '', message: '需要提供 slug（先用 memory_list 查看）' }
  const resolved = resolveEnv(env)
  for (const [scope, directory] of candidateScopes(resolved, args.scope)) {
    const archived = archiveEntry(directory, join(env.memoryHome, 'archive', scope === 'user' ? 'user' : resolved.project.key), slug, args.reason ?? '')
    if (archived === null) continue
    return { ok: true, scope, slug, path: archived.path, message: `已归档（${scope}·${slug}）。文件保留在 archive/，可手工恢复。` }
  }
  return { ok: false, scope: args.scope ?? 'project', slug, path: '', message: `没有找到 slug 为 ${slug} 的记忆` }
}

/** Ensure a scope layout exists (used by tests and by first-run diagnostics). */
export function ensureScope(directory) {
  mkdirSync(entriesDir(directory), { recursive: true })
  rebuildIndex(directory, {})
}
