/**
 * YAML frontmatter subset for memory entries.
 *
 * Deliberately minimal: the plugin writes this format and humans may edit it by
 * hand. Supported values are scalars, quoted strings, inline arrays, null and
 * booleans. Block scalars and nested mappings are not part of the format — an
 * entry body carries prose, not structure.
 */

/** Canonical frontmatter field order; unknown fields keep insertion order after these. */
export const FIELD_ORDER = [
  'slug',
  'title',
  'type',
  'scope',
  'created',
  'updated',
  'session',
  'dir',
  'pinned',
  'tags',
  'supersedes',
  'supersededBy',
]

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/

/**
 * Unquote one scalar token.
 * @param {string} raw - trimmed token.
 * @returns {string} unquoted text.
 */
function unquote(raw) {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw)
    } catch {
      return raw.slice(1, -1)
    }
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replaceAll("''", "'")
  return raw
}

/**
 * Parse one scalar or inline-array value.
 * @param {string} raw - text after `key:`.
 * @returns {unknown} parsed value.
 */
export function parseValue(raw) {
  const text = raw.trim()
  if (text === '' || text === 'null' || text === '~') return text === '' ? '' : null
  if (text === 'true') return true
  if (text === 'false') return false
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim()
    if (inner === '') return []
    return inner.split(',').map((item) => {
      const value = unquote(item.trim())
      return value
    })
  }
  return unquote(text)
}

/**
 * Serialize one value for the frontmatter.
 * @param {unknown} value - scalar or string array.
 * @returns {string} a single-line YAML token.
 */
export function formatValue(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return `[${value.map((item) => JSON.stringify(String(item))).join(', ')}]`
  }
  return JSON.stringify(String(value))
}

/**
 * Split a document into frontmatter metadata and body.
 * @param {string} raw - complete file text.
 * @returns {{ meta: Record<string, unknown>, body: string }} parsed document.
 */
export function parseDocument(raw) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '')
  const match = FRONTMATTER.exec(text)
  if (match === null) return { meta: {}, body: text.trim() }
  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (pair === null) continue
    meta[pair[1]] = parseValue(pair[2])
  }
  return { meta, body: text.slice(match[0].length).trim() }
}

/**
 * Render a document with a deterministic field order.
 * @param {Record<string, unknown>} meta - frontmatter fields.
 * @param {string} body - markdown body.
 * @returns {string} complete file text.
 */
export function serializeDocument(meta, body) {
  const keys = [...FIELD_ORDER.filter((key) => meta[key] !== undefined), ...Object.keys(meta).filter((key) => !FIELD_ORDER.includes(key) && meta[key] !== undefined)]
  const lines = ['---']
  for (const key of keys) lines.push(`${key}: ${formatValue(meta[key])}`)
  lines.push('---', '', String(body ?? '').trim(), '')
  return lines.join('\n')
}
