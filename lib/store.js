/**
 * Entry persistence: one markdown file per memory, plus a derived index.
 *
 * The index is never authoritative — it is rebuilt from the entry files on
 * every write, so a hand-edited entry can never desynchronize it. Writes are
 * atomic (temp file + rename) because the same memory home is shared by the
 * Desktop app, the CLI and any scratch instance.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parseDocument, serializeDocument } from './frontmatter.js'

/** Recognized memory kinds, ordered from strongest to weakest for rendering. */
export const TYPES = ['constraint', 'preference', 'decision', 'pitfall', 'fact', 'glossary']

/** Rendering weight per type; lower wins. */
export const TYPE_WEIGHT = Object.fromEntries(TYPES.map((type, index) => [type, index]))

/** Filesystem-safe slug for a title, hashing titles that are not mostly ASCII. */
export function slugify(title) {
  const text = String(title).trim()
  const ascii = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const letters = text.replace(/\s+/g, '')
  const asciiLetters = (text.match(/[A-Za-z]/g) ?? []).length
  const ratio = letters.length === 0 ? 0 : asciiLetters / letters.length
  if (ratio >= 0.8 && ascii.length >= 6) return ascii.slice(0, 64)
  return `mem-${createHash('sha1').update(text).digest('hex').slice(0, 8)}`
}

/** Current time as an ISO 8601 string with a local offset. */
export function nowIso() {
  const now = new Date()
  const offset = -now.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const pad = (value) => String(Math.trunc(Math.abs(value))).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${sign}${pad(offset / 60)}:${pad(offset % 60)}`
}

/** Entries directory for a scope directory. */
export function entriesDir(scopeDirectory) {
  return join(scopeDirectory, 'entries')
}

/** Index file path for a scope directory. */
export function indexPath(scopeDirectory) {
  return join(scopeDirectory, 'MEMORY.md')
}

/**
 * Normalize one parsed file into an entry.
 * @param {string} path - absolute file path.
 * @param {string} raw - file text.
 * @returns {object} entry.
 */
function toEntry(path, raw) {
  const { meta, body } = parseDocument(raw)
  const slug = typeof meta.slug === 'string' && meta.slug.length > 0 ? meta.slug : basename(path, '.md')
  const title = typeof meta.title === 'string' && meta.title.length > 0 ? meta.title : slug
  const type = TYPES.includes(meta.type) ? meta.type : 'fact'
  return {
    slug,
    title,
    type,
    scope: meta.scope === 'user' ? 'user' : 'project',
    created: typeof meta.created === 'string' ? meta.created : '',
    updated: typeof meta.updated === 'string' ? meta.updated : '',
    session: typeof meta.session === 'string' ? meta.session : '',
    dir: typeof meta.dir === 'string' ? meta.dir : '.',
    pinned: meta.pinned === true,
    tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
    supersedes: typeof meta.supersedes === 'string' && meta.supersedes.length > 0 ? meta.supersedes : null,
    supersededBy: typeof meta.supersededBy === 'string' && meta.supersededBy.length > 0 ? meta.supersededBy : null,
    body: body.trim(),
    path,
  }
}

/**
 * Sort entries the way rendering consumes them: pinned first, then by type
 * weight, then most recently updated.
 * @param {object[]} entries - entries to sort in place.
 * @returns {object[]} the same array.
 */
export function sortEntries(entries) {
  entries.sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
    const weight = (TYPE_WEIGHT[left.type] ?? 9) - (TYPE_WEIGHT[right.type] ?? 9)
    if (weight !== 0) return weight
    return String(right.updated).localeCompare(String(left.updated))
  })
  return entries
}

/**
 * Load every entry in a scope directory.
 * @param {string} scopeDirectory - scope root.
 * @returns {object[]} sorted entries; superseded entries are kept but flagged.
 */
export function loadEntries(scopeDirectory) {
  const directory = entriesDir(scopeDirectory)
  let names
  try {
    names = readdirSync(directory)
  } catch {
    return []
  }
  const entries = []
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const path = join(directory, name)
    try {
      entries.push(toEntry(path, readFileSync(path, 'utf8')))
    } catch {
      // A corrupt entry must not take the whole layer down.
    }
  }
  return sortEntries(entries)
}

/**
 * Cheap change fingerprint for a scope directory (name set + file mtimes).
 * @param {string} scopeDirectory - scope root.
 * @returns {string} fingerprint; changes whenever entries change.
 */
export function fingerprint(scopeDirectory) {
  const directory = entriesDir(scopeDirectory)
  let names
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.md')).sort()
  } catch {
    return 'absent'
  }
  const parts = []
  for (const name of names) {
    try {
      parts.push(`${name}:${statSync(join(directory, name)).mtimeMs}`)
    } catch {
      parts.push(`${name}:gone`)
    }
  }
  return parts.join('|')
}

/**
 * Read one entry by slug.
 * @param {string} scopeDirectory - scope root.
 * @param {string} slug - entry slug.
 * @returns {object | null} entry or null.
 */
export function readEntry(scopeDirectory, slug) {
  const path = join(entriesDir(scopeDirectory), `${slug}.md`)
  try {
    return toEntry(path, readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Frontmatter fields of one entry.
 *
 * Entry objects also carry `body` and `path` for callers; those are storage
 * details, and serializing them would duplicate the body into the frontmatter.
 * @param {object} entry - entry or partial entry.
 * @returns {object} only the fields that belong in frontmatter.
 */
function metaOf(entry) {
  return {
    slug: entry.slug,
    title: entry.title,
    type: entry.type,
    scope: entry.scope,
    created: entry.created,
    updated: entry.updated,
    session: entry.session,
    dir: entry.dir,
    pinned: entry.pinned === true,
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    supersedes: entry.supersedes ?? null,
    supersededBy: entry.supersededBy ?? null,
  }
}

/** Write text atomically inside a directory (temp file + rename). */
function atomicWrite(path, text) {
  const temporary = `${path}.tmp-${randomBytes(6).toString('hex')}`
  writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
}

/**
 * Create or update one entry and rebuild the scope index.
 * @param {string} scopeDirectory - scope root.
 * @param {object} input - entry fields.
 * @returns {{ entry: object, replaced: boolean }} written entry and whether it updated an existing one.
 */
export function writeEntry(scopeDirectory, input) {
  const directory = entriesDir(scopeDirectory)
  mkdirSync(directory, { recursive: true })
  const slug = input.slug ?? slugify(input.title)
  const path = join(directory, `${slug}.md`)
  const existing = existsSync(path) ? readEntry(scopeDirectory, slug) : null
  const now = nowIso()
  const entry = {
    slug,
    title: String(input.title).trim(),
    type: TYPES.includes(input.type) ? input.type : (existing?.type ?? 'fact'),
    scope: input.scope,
    created: existing?.created || now,
    updated: now,
    session: input.session ?? existing?.session ?? '',
    dir: input.dir ?? existing?.dir ?? '.',
    pinned: input.pinned ?? existing?.pinned ?? false,
    tags: input.tags ?? existing?.tags ?? [],
    supersedes: input.supersedes ?? existing?.supersedes ?? null,
    supersededBy: null,
    body: String(input.content ?? existing?.body ?? '').trim(),
    path,
  }
  if (input.replace !== undefined && input.replace !== null && input.replace !== slug) {
    markSuperseded(scopeDirectory, input.replace, slug)
    entry.supersedes = input.replace
  }
  atomicWrite(path, serializeDocument(metaOf(entry), entry.body))
  rebuildIndex(scopeDirectory, input.indexMeta ?? {})
  return { entry, replaced: existing !== null }
}

/**
 * Mark an entry as replaced by another one.
 * @param {string} scopeDirectory - scope root.
 * @param {string} slug - entry being replaced.
 * @param {string} bySlug - replacement entry.
 * @returns {boolean} whether the entry existed.
 */
export function markSuperseded(scopeDirectory, slug, bySlug) {
  const target = readEntry(scopeDirectory, slug)
  if (target === null) return false
  const updated = { ...target, supersededBy: bySlug, updated: nowIso() }
  atomicWrite(target.path, serializeDocument(metaOf(updated), updated.body))
  rebuildIndex(scopeDirectory, {})
  return true
}

/**
 * Move one entry into the archive (never unlink).
 * @param {string} scopeDirectory - scope root.
 * @param {string} archiveDirectory - destination directory.
 * @param {string} slug - entry slug.
 * @param {string} reason - why it was forgotten.
 * @returns {{ path: string } | null} archived path or null when absent.
 */
export function archiveEntry(scopeDirectory, archiveDirectory, slug, reason) {
  const entry = readEntry(scopeDirectory, slug)
  if (entry === null) return null
  mkdirSync(archiveDirectory, { recursive: true })
  const stamp = nowIso().replace(/[:+]/g, '-')
  const destination = join(archiveDirectory, `${slug}.${stamp}.md`)
  const header = reason === '' ? `> archived ${stamp}` : `> archived ${stamp} — ${reason}`
  writeFileSync(destination, `${header}\n\n${serializeDocument(metaOf(entry), entry.body)}`, { encoding: 'utf8', mode: 0o600 })
  unlinkSync(entry.path)
  rebuildIndex(scopeDirectory, {})
  return { path: destination }
}

/**
 * Short date shown in the index (MM-DD), tolerating hand-written values.
 * @param {string} value - ISO timestamp.
 * @returns {string} display date.
 */
function shortDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value))
  return match === null ? '' : `${match[2]}-${match[3]}`
}

/**
 * Rebuild the human-readable index for one scope directory.
 * @param {string} scopeDirectory - scope root.
 * @param {{ scope?: string, projectLabel?: string }} meta - display metadata.
 * @returns {string} index text.
 */
export function rebuildIndex(scopeDirectory, meta = {}) {
  const entries = loadEntries(scopeDirectory)
  const live = entries.filter((entry) => entry.supersededBy === null)
  const label = meta.scope === 'user' ? '用户层' : `项目层 · ${meta.projectLabel ?? basename(scopeDirectory)}`
  const lines = ['<!-- generated by dsh-memory; edit entries/*.md instead -->', `# ${label}（${live.length} 条）`, '']
  if (live.length === 0) {
    lines.push('（暂无记忆）', '')
  } else {
    lines.push('| slug | type | 标题 | 更新 |', '|---|---|---|---|')
    for (const entry of live) {
      const title = entry.title.replaceAll('|', '\\|')
      lines.push(`| [${entry.slug}](entries/${entry.slug}.md) | ${entry.type} | ${title} | ${shortDate(entry.updated)} |`)
    }
    lines.push('')
  }
  const superseded = entries.filter((entry) => entry.supersededBy !== null)
  if (superseded.length > 0) {
    lines.push(`已废弃 ${superseded.length} 条：${superseded.map((entry) => entry.slug).join(', ')}`, '')
  }
  const text = lines.join('\n')
  mkdirSync(scopeDirectory, { recursive: true })
  atomicWrite(indexPath(scopeDirectory), text)
  return text
}
