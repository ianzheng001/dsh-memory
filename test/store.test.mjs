import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { archiveEntry, entriesDir, fingerprint, indexPath, loadEntries, readEntry, rebuildIndex, slugify, sortEntries, writeEntry } from '../lib/store.js'

/** Create a throwaway scope directory. */
function sandbox() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-store-'))
}

test('slug from ASCII titles, hash from CJK titles', () => {
  assert.equal(slugify('Zero runtime dependencies'), 'zero-runtime-dependencies')
  assert.match(slugify('dsh 插件必须零运行时依赖'), /^mem-[0-9a-f]{8}$/)
  assert.equal(slugify('Zero runtime dependencies'), slugify('zero   runtime dependencies'))
})

test('writes an entry, then updates it in place', () => {
  const directory = sandbox()
  const first = writeEntry(directory, { title: 'Zero runtime deps', content: 'v1', type: 'constraint', scope: 'project' })
  assert.equal(first.replaced, false)
  assert.ok(existsSync(first.entry.path))
  assert.equal(first.entry.scope, 'project')
  const second = writeEntry(directory, { title: 'Zero runtime deps', content: 'v2', scope: 'project' })
  assert.equal(second.replaced, true)
  assert.equal(second.entry.slug, first.entry.slug)
  assert.equal(second.entry.created, first.entry.created)
  assert.equal(loadEntries(directory).length, 1)
  assert.equal(readEntry(directory, first.entry.slug).body, 'v2')
})

test('frontmatter never contains derived fields or a duplicated body', () => {
  const directory = sandbox()
  const written = writeEntry(directory, { title: 'No leaked fields', content: 'ONLY-ONCE-BODY', scope: 'project' })
  const text = readFileSync(written.entry.path, 'utf8')
  const frontmatter = text.slice(0, text.indexOf('\n---', 3))
  assert.doesNotMatch(frontmatter, /^body:/m)
  assert.doesNotMatch(frontmatter, /^path:/m)
  assert.equal(text.split('ONLY-ONCE-BODY').length - 1, 1)
})

test('index is rebuilt from entries', () => {
  const directory = sandbox()
  writeEntry(directory, { title: 'Alpha rule', content: 'a', type: 'constraint', scope: 'project' })
  writeEntry(directory, { title: 'Beta note', content: 'b', type: 'fact', scope: 'project' })
  const index = readFileSync(indexPath(directory), 'utf8')
  assert.match(index, /（2 条）/)
  assert.match(index, /alpha-rule/)
  assert.match(index, /beta-note/)
})

test('supersede keeps the old entry but hides it from the live set', () => {
  const directory = sandbox()
  const old = writeEntry(directory, { title: 'Old decision', content: 'old', type: 'decision', scope: 'project' })
  writeEntry(directory, { title: 'New decision', content: 'new', type: 'decision', scope: 'project', replace: old.entry.slug })
  const entries = loadEntries(directory)
  const replaced = entries.find((entry) => entry.slug === old.entry.slug)
  assert.equal(replaced.supersededBy, 'new-decision')
  assert.equal(entries.filter((entry) => entry.supersededBy === null).length, 1)
  assert.match(readFileSync(indexPath(directory), 'utf8'), /已废弃 1 条/)
})

test('archive moves the file instead of deleting it', () => {
  const directory = sandbox()
  const archive = join(directory, 'archive')
  const written = writeEntry(directory, { title: 'Temporary note', content: 'x', scope: 'project' })
  const moved = archiveEntry(directory, archive, written.entry.slug, '用户要求删除')
  assert.ok(moved !== null)
  assert.ok(existsSync(moved.path))
  assert.equal(existsSync(written.entry.path), false)
  assert.equal(readdirSync(entriesDir(directory)).includes(`${written.entry.slug}.md`), false)
  assert.match(readFileSync(moved.path, 'utf8'), /archived .*用户要求删除/)
})

test('missing entries are ignored rather than fatal', () => {
  const directory = sandbox()
  assert.deepEqual(loadEntries(directory), [])
  assert.equal(fingerprint(directory), 'absent')
  assert.equal(readEntry(directory, 'nope'), null)
})

test('fingerprint changes when an entry changes', () => {
  const directory = sandbox()
  const written = writeEntry(directory, { title: 'Fact one', content: 'a', scope: 'project' })
  const before = fingerprint(directory)
  writeFileSync(written.entry.path, readFileSync(written.entry.path, 'utf8').replace('a', 'b'))
  assert.notEqual(fingerprint(directory), before)
})

test('sorting puts pinned and hard constraints first', () => {
  const sorted = sortEntries([
    { slug: 'f', type: 'fact', pinned: false, updated: '2026-01-01' },
    { slug: 'c', type: 'constraint', pinned: false, updated: '2026-01-01' },
    { slug: 'p', type: 'glossary', pinned: true, updated: '2026-01-01' },
  ])
  assert.deepEqual(sorted.map((entry) => entry.slug), ['p', 'c', 'f'])
})

test('corrupt entries do not break the layer', () => {
  const directory = sandbox()
  writeEntry(directory, { title: 'Good one', content: 'ok', scope: 'project' })
  writeFileSync(join(entriesDir(directory), 'broken.md'), '---\nslug: broken\n---\n\nbody\n')
  assert.doesNotThrow(() => rebuildIndex(directory, {}))
  assert.equal(loadEntries(directory).length, 2)
})
