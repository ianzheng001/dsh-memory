#!/usr/bin/env node
/**
 * One-shot import of Claude Code memory directories into dsh-memory.
 *
 * Claude Code stores memory per working directory as
 * `~/.claude/projects/<encoded-cwd>/memory/*.md` plus a user-global
 * `~/.claude/memory/*.md`. This script maps each encoded directory back to a
 * real path, resolves that path to a dsh project bucket, and writes the entries
 * through the same store the plugin uses, so frontmatter and the generated index
 * match what the plugin produces.
 *
 * Defaults to a dry run. Pass `--apply` to write, `--overwrite` to replace
 * entries that already exist.
 *
 *   node scripts/import-claude-memory.mjs
 *   node scripts/import-claude-memory.mjs --apply
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseDocument } from '../lib/frontmatter.js'
import { resolveProject, scopeDir } from '../lib/paths.js'
import { readEntry, slugify, writeEntry } from '../lib/store.js'

/** Claude Code's on-disk root for project-scoped memory. */
const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects')
/** Claude Code's user-global memory directory. */
const CLAUDE_USER = join(homedir(), '.claude', 'memory')

/** Type mapping from Claude's filename convention to a dsh memory type. */
const PREFIX_TYPES = { feedback: 'preference', project: 'fact', reference: 'fact', user: 'preference' }

/** Claude Code's path encoding: every non-alphanumeric character becomes a dash. */
export function encodePath(path) {
  return path.replace(/[^A-Za-z0-9]/g, '-')
}

/**
 * Decode Claude's flattened working-directory name back into a real path.
 *
 * The encoding is lossy: `/`, `_`, `.` and `-` all become `-`, so the name
 * cannot be split back into segments. Instead, walk the filesystem and compare
 * each directory's own encoding against the target — a child's encoding is its
 * parent's plus `-` plus its own encoded name, which makes prefix matching sound.
 * @param {string} encoded - directory name such as `-Users-me-git-claude-projects`.
 * @param {string} [root] - search root; defaults to `/Users` when the encoding matches it, else `/`.
 * @returns {string | null} an existing absolute path, or null when it is gone.
 */
export function decodeProjectDir(encoded, root) {
  const usersRoot = '/Users'
  const start = root ?? (encoded.startsWith(encodePath(usersRoot)) ? usersRoot : '/')
  const seen = new Set()
  const walk = (directory) => {
    if (seen.has(directory)) return null
    seen.add(directory)
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return null
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const candidate = join(directory, entry.name)
      const candidateEncoding = encodePath(candidate)
      if (candidateEncoding === encoded) return candidate
      if (encoded.startsWith(`${candidateEncoding}-`) && candidateEncoding.length < encoded.length) {
        const found = walk(candidate)
        if (found !== null) return found
      }
    }
    return null
  }
  return walk(start)
}

/**
 * Shorten a one-line description to a readable index title.
 * @param {string} text - description or file name.
 * @returns {string} at most one clause, capped at 48 characters.
 */
function firstClause(text) {
  const clause = text.split(/[。；;]|(?<=[a-zA-Z])\.\s|——|--/)[0].trim()
  const source = clause.length > 0 ? clause : text.trim()
  return source.length <= 48 ? source : `${source.slice(0, 47)}…`
}

/**
 * Turn one Claude memory file into dsh-memory entry input.
 * @param {string} path - absolute file path.
 * @param {'project' | 'user'} scope - target layer.
 * @param {string} projectLabel - project display name.
 * @returns {object} entry input.
 */
export function toEntryInput(path, scope, projectLabel) {
  const { meta, body } = parseDocument(readFileSync(path, 'utf8'))
  const file = basename(path, '.md')
  const prefix = file.split('_')[0]
  const type = PREFIX_TYPES[prefix] ?? 'fact'
  const description = typeof meta.description === 'string' ? meta.description.trim() : ''
  // The description is a sentence or two; the index only shows the title, so
  // keep the first clause as the title and preserve the rest as a body header.
  const title = firstClause(description !== '' ? description : file.replaceAll('_', ' '))
  const header = description === '' || description === title ? '' : `> ${description}\n\n`
  return {
    title,
    content: `${header}${body.trim()}`.trim(),
    type,
    tags: ['claude-import', projectLabel].filter((tag) => tag.length > 0),
    scope,
    dir: '.',
    source: file,
  }
}

/**
 * Collect every importable memory file and the bucket it belongs to.
 * @param {string} memoryHome - target memory home.
 * @returns {{ planned: object[], skipped: object[] }} plan.
 */
export function planImport(memoryHome) {
  const planned = []
  const skipped = []
  if (existsSync(CLAUDE_USER)) {
    for (const name of readdirSync(CLAUDE_USER)) {
      if (!name.endsWith('.md') || name === 'MEMORY.md') continue
      const path = join(CLAUDE_USER, name)
      planned.push({ file: name, scope: 'user', project: null, entry: toEntryInput(path, 'user', 'user') })
    }
  }
  if (existsSync(CLAUDE_PROJECTS)) {
    for (const encoded of readdirSync(CLAUDE_PROJECTS)) {
      const directory = join(CLAUDE_PROJECTS, encoded, 'memory')
      if (!existsSync(directory)) continue
      const names = readdirSync(directory).filter((name) => name.endsWith('.md') && name !== 'MEMORY.md')
      if (names.length === 0) continue
      const decoded = decodeProjectDir(encoded)
      if (decoded === null) {
        for (const name of names) skipped.push({ file: name, reason: `对应目录已不存在（${encoded}）` })
        continue
      }
      const project = resolveProject(decoded)
      for (const name of names) {
        const path = join(directory, name)
        planned.push({ file: name, scope: 'project', project, entry: toEntryInput(path, 'project', project.label) })
      }
    }
  }
  return { planned, skipped }
}

/** Persist project identity so an imported-only bucket still knows its root. */
function touchProject(directory, project) {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, '.project.json')
  if (existsSync(path)) return
  const now = new Date().toISOString()
  const meta = { root: project.root, base: project.label, key: project.key, firstSeen: now, lastSeen: now, sessions: [] }
  writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

/** Entry point. */
function main() {
  const argv = process.argv.slice(2)
  const apply = argv.includes('--apply')
  const overwrite = argv.includes('--overwrite')
  const memoryHome = process.env.DSH_HOME ? join(process.env.DSH_HOME, 'memory') : join(homedir(), '.dsh', 'memory')
  const { planned, skipped } = planImport(memoryHome)

  const groups = new Map()
  for (const item of planned) {
    const key = item.scope === 'user' ? '用户层' : `项目层 · ${item.project.label}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }
  console.log(`源：${CLAUDE_PROJECTS} + ${CLAUDE_USER}`)
  console.log(`目标：${memoryHome}`)
  console.log(`计划导入 ${planned.length} 条，跳过 ${skipped.length} 条\n`)
  for (const [group, items] of groups) {
    console.log(`## ${group}（${items.length} 条）`)
    for (const item of items) console.log(`  - [${item.entry.type}] ${item.entry.title}`)
    console.log('')
  }
  if (skipped.length > 0) {
    console.log('## 跳过')
    for (const item of skipped) console.log(`  - ${item.file}：${item.reason}`)
    console.log('')
  }
  if (!apply) {
    console.log('dry-run 结束。确认无误后加 --apply 写入。')
    return
  }

  let written = 0
  let existing = 0
  for (const item of planned) {
    const directory = item.scope === 'user' ? scopeDir(memoryHome, 'user', null) : scopeDir(memoryHome, 'project', item.project)
    if (readEntry(directory, slugify(item.entry.title)) !== null && !overwrite) {
      existing += 1
      continue
    }
    writeEntry(directory, {
      title: item.entry.title,
      content: item.entry.content,
      type: item.entry.type,
      tags: item.entry.tags,
      scope: item.scope,
      dir: item.entry.dir,
      indexMeta: item.scope === 'user' ? { scope: 'user' } : { scope: 'project', projectLabel: item.project.label },
    })
    if (item.scope === 'project') touchProject(directory, item.project)
    written += 1
  }
  console.log(`已写入 ${written} 条，跳过已存在 ${existing} 条。`)
}

// Only run when invoked directly; importing the module must have no side effects.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
