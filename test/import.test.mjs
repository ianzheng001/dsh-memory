import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { decodeProjectDir, encodePath, toEntryInput } from '../scripts/import-claude-memory.mjs'

test('encoding flattens every non-alphanumeric character', () => {
  assert.equal(encodePath('/Users/me/git/claude_projects'), '-Users-me-git-claude-projects')
  assert.equal(encodePath('/a/b-c/d_e.f'), '-a-b-c-d-e-f')
})

test('decodes dashes and underscores back to the real directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-import-'))
  const target = join(root, 'git', 'claude_projects', 'test_abap')
  mkdirSync(target, { recursive: true })
  const decoded = decodeProjectDir(encodePath(target), root)
  assert.equal(decoded, target)
})

test('returns null for a directory that no longer exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-import-'))
  mkdirSync(join(root, 'git'), { recursive: true })
  assert.equal(decodeProjectDir(encodePath(join(root, 'git', 'gone')), root), null)
})

test('maps a Claude memory file to a title, body and type', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-memory-import-'))
  const path = join(directory, 'feedback_language.md')
  writeFileSync(path, ['---', 'name: feedback_language', 'description: "严格语言限制：只允许简体和英文。禁止其他语言"', 'metadata:', '  node_type: memory', '  type: feedback', '---', '', '正文结论'].join('\n'))
  const entry = toEntryInput(path, 'project', 'demo')
  assert.equal(entry.title, '严格语言限制：只允许简体和英文')
  assert.equal(entry.type, 'preference')
  assert.match(entry.content, /^> 严格语言限制/)
  assert.match(entry.content, /正文结论/)
  assert.deepEqual(entry.tags, ['claude-import', 'demo'])
})
