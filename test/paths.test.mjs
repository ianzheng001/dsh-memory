import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MARKER_FILE, clearProjectCache, findProjectRoot, projectRelativeDir, resolveProject, sanitizeName, scopeDir } from '../lib/paths.js'

/** Create a throwaway directory tree. */
function sandbox() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-paths-'))
}

test('selects the repository root as the project root', () => {
  const root = sandbox()
  mkdirSync(join(root, '.git'))
  const deep = join(root, 'pkg', 'src')
  mkdirSync(deep, { recursive: true })
  clearProjectCache()
  const found = findProjectRoot(deep)
  assert.equal(found.kind, 'git')
  assert.equal(found.root, root)
})

test('a marker overrides the repository root', () => {
  const root = sandbox()
  mkdirSync(join(root, '.git'))
  const sub = join(root, 'tool_a')
  mkdirSync(sub, { recursive: true })
  writeFileSync(join(sub, MARKER_FILE), '{"key":"tool-a"}\n')
  clearProjectCache()
  const project = resolveProject(sub)
  assert.equal(project.kind, 'marker')
  assert.equal(project.root, sub)
  assert.equal(project.key, 'tool-a')
})

test('falls back to the working directory outside any repository', () => {
  const root = sandbox()
  clearProjectCache()
  const found = findProjectRoot(root)
  assert.equal(found.kind, 'cwd')
  assert.equal(found.root, root)
})

test('keys are readable and disambiguated by path hash', () => {
  clearProjectCache()
  const left = sandbox()
  const right = sandbox()
  mkdirSync(join(left, '.git'))
  mkdirSync(join(right, '.git'))
  const a = resolveProject(left)
  const b = resolveProject(right)
  assert.match(a.key, /^dsh-memory-paths-[A-Za-z0-9]+-[0-9a-f]{6}$/)
  assert.notEqual(a.key, b.key)
})

test('scope directories separate user and project layers', () => {
  const home = '/tmp/memory-home'
  assert.equal(scopeDir(home, 'user', null), join(home, 'user'))
  assert.equal(scopeDir(home, 'project', { key: 'proj-abc123' }), join(home, 'projects', 'proj-abc123'))
  assert.throws(() => scopeDir(home, 'project', null))
})

test('project-relative directory is dot at the root', () => {
  assert.equal(projectRelativeDir('/a/b', '/a/b'), '.')
  assert.equal(projectRelativeDir('/a/b', '/a/b/c/d'), 'c/d')
})

test('sanitizeName never returns an empty segment', () => {
  assert.equal(sanitizeName('中文目录'), 'root')
  assert.equal(sanitizeName('a b/c'), 'a-b-c')
})
