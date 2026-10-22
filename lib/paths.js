/**
 * Project identity: which memory bucket one working directory belongs to.
 *
 * Discovery order matters more than it looks. A marker wins over a repository
 * root so a monorepo can carve out subprojects, and the hash suffix keeps two
 * unrelated checkouts that share a directory name from sharing memory.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

/** Project-local marker; presence selects this directory as the memory root. */
export const MARKER_FILE = '.dsh-memory.json'

/** Cache of cwd → project, invalidated by directory mtime changes. */
const projectCache = new Map()

/**
 * Short stable digest of an absolute path.
 * @param {string} value - text to hash.
 * @param {number} length - hex characters to keep.
 * @returns {string} lowercase hex digest.
 */
function digest(value, length) {
  return createHash('sha1').update(value).digest('hex').slice(0, length)
}

/**
 * Make a directory basename safe for a memory directory name.
 * @param {string} value - basename.
 * @returns {string} `[A-Za-z0-9._-]` only, never empty.
 */
export function sanitizeName(value) {
  const cleaned = String(value).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  return cleaned === '' ? 'root' : cleaned
}

/**
 * Read an explicit key override from the marker file, when present.
 * @param {string} root - directory holding the marker.
 * @returns {string | null} override key, or null.
 */
function markerKey(root) {
  const file = join(root, MARKER_FILE)
  try {
    if (statSync(file).size > 4096) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const key = parsed?.key
    if (typeof key === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(key)) return key
  } catch {
    // Unreadable or malformed marker: fall back to the derived key.
  }
  return null
}

/**
 * Walk upward to find the memory root for a working directory.
 * @param {string} cwd - absolute session working directory.
 * @returns {{ root: string, kind: 'marker' | 'git' | 'cwd' }} resolved root.
 */
export function findProjectRoot(cwd) {
  const start = resolve(cwd)
  let gitRoot = null
  let dir = start
  for (;;) {
    if (existsSync(join(dir, MARKER_FILE))) return { root: dir, kind: 'marker' }
    if (gitRoot === null && existsSync(join(dir, '.git'))) gitRoot = dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (gitRoot !== null) return { root: gitRoot, kind: 'git' }
  return { root: start, kind: 'cwd' }
}

/**
 * Resolve the memory project for a working directory, cached by path.
 * @param {string} cwd - absolute session working directory.
 * @returns {{ root: string, kind: string, key: string, label: string, dir: string }} project identity.
 */
export function resolveProject(cwd) {
  const start = resolve(cwd)
  const cached = projectCache.get(start)
  if (cached !== undefined) return cached
  const found = findProjectRoot(start)
  const override = found.kind === 'marker' ? markerKey(found.root) : null
  const label = basename(found.root) || 'root'
  const key = override ?? `${sanitizeName(label)}-${digest(found.root, 6)}`
  const project = { root: found.root, kind: found.kind, key, label, dir: start }
  projectCache.set(start, project)
  return project
}

/**
 * Project-relative directory of the current working directory (`.` at the root).
 * @param {string} projectRoot - memory root.
 * @param {string} cwd - working directory.
 * @returns {string} relative path with `/` separators.
 */
export function projectRelativeDir(projectRoot, cwd) {
  const relative = resolve(cwd).slice(projectRoot.length).replaceAll(sep, '/').replace(/^\/+|\/+$/g, '')
  return relative === '' ? '.' : relative
}

/**
 * Directory holding one scope's entries.
 * @param {string} memoryHome - memory root (`$DSH_HOME/memory`).
 * @param {'user' | 'project'} scope - memory layer.
 * @param {{ key: string } | null} project - project identity for the project layer.
 * @returns {string} absolute scope directory.
 */
export function scopeDir(memoryHome, scope, project) {
  if (scope === 'user') return join(memoryHome, 'user')
  if (project === null || project === undefined) throw new Error('dsh-memory: project scope requires a project identity')
  return join(memoryHome, 'projects', project.key)
}

/** Forget the memoized project identity for one path (tests, marker changes). */
export function clearProjectCache() {
  projectCache.clear()
}
