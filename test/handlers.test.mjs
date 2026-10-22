import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MAX_ENTRY_BYTES, forgetMemory, listMemory, recallMemory, saveMemory } from '../lib/handlers.js'
import { clearProjectCache } from '../lib/paths.js'

/** Build one isolated memory home plus project checkout. */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-handlers-'))
  const project = join(root, 'claude_projects')
  mkdirSync(join(project, '.git'), { recursive: true })
  const sub = join(project, 'tool_a')
  mkdirSync(sub, { recursive: true })
  const memoryHome = join(root, 'memory')
  clearProjectCache()
  return { memoryHome, project, sub, env: { cwd: sub, memoryHome, sessionId: 'sess-1' } }
}

test('saves a project-scope memory and lands it under the project key', () => {
  const { env } = sandbox()
  const result = saveMemory(env, { title: 'Zero runtime dependencies', content: '**结论**：不写 dependencies', type: 'constraint', tags: ['dsh'] })
  assert.equal(result.ok, true)
  assert.equal(result.action, 'created')
  assert.equal(result.scope, 'project')
  assert.match(result.path, /projects\/claude_projects-[0-9a-f]{6}\/entries\/zero-runtime-dependencies\.md$/)
})

test('project identity is shared by all subdirectories of one repository', () => {
  const { env, project } = sandbox()
  saveMemory(env, { title: 'Shared decision', content: 'a' })
  const fromRoot = saveMemory({ ...env, cwd: project }, { title: 'Second decision', content: 'b' })
  assert.equal(fromRoot.ok, true)
  assert.match(fromRoot.path, /claude_projects-[0-9a-f]{6}/)
})

test('user scope lands in the user layer', () => {
  const { env } = sandbox()
  const result = saveMemory(env, { title: 'Lead with the conclusion', content: '结论先行', scope: 'user', type: 'preference' })
  assert.equal(result.scope, 'user')
  assert.match(result.path, /\/memory\/user\/entries\/lead-with-the-conclusion\.md$/)
})

test('re-saving the same title updates instead of duplicating', () => {
  const { env } = sandbox()
  const first = saveMemory(env, { title: 'Package manager', content: 'pnpm' })
  const second = saveMemory(env, { title: 'Package manager', content: 'npm' })
  assert.equal(second.action, 'updated')
  assert.equal(second.slug, first.slug)
  const listed = recallMemory(env, { slug: first.slug })
  assert.match(listed.message, /npm/)
  assert.doesNotMatch(listed.message, /pnpm/)
})

test('updating without optional fields preserves type, tags and pinned', () => {
  const { env } = sandbox()
  const first = saveMemory(env, { title: 'Sticky metadata', content: 'v1', type: 'constraint', tags: ['a', 'b'], pinned: true })
  assert.equal(first.ok, true)
  const second = saveMemory(env, { title: 'Sticky metadata', content: 'v2' })
  assert.equal(second.action, 'updated')
  const listed = listMemory(env, { scope: 'project' })
  assert.match(listed.message, /\[constraint·pinned\]/)
  const recalled = recallMemory(env, { slug: second.slug })
  assert.match(recalled.message, /v2/)
})

test('replace retires the previous slug', () => {
  const { env } = sandbox()
  const first = saveMemory(env, { title: 'Old plan', content: 'A' })
  const second = saveMemory(env, { title: 'New plan', content: 'B', replace: first.slug })
  assert.equal(second.ok, true)
  assert.equal(recallMemory(env, { slug: first.slug }).ok, true, 'the retired entry stays readable by slug')
  const listed = listMemory(env, { scope: 'project' })
  assert.equal(listed.count, 1, 'only the live entry is listed')
  assert.match(listed.message, new RegExp(second.slug))
  assert.doesNotMatch(listed.message, new RegExp(`- ${first.slug} `))
})

test('recall finds by slug across both layers and by keyword', () => {
  const { env } = sandbox()
  saveMemory(env, { title: 'User level rule', content: '只写中文', scope: 'user', type: 'constraint' })
  saveMemory(env, { title: 'Project level rule', content: '走 sin 代理' })
  const userHit = recallMemory(env, { slug: 'user-level-rule' })
  assert.match(userHit.message, /只写中文/)
  const both = recallMemory(env, { query: 'rule' })
  assert.equal(both.count, 2)
  assert.equal(recallMemory(env, { query: '不存在的词' }).count, 0)
})

test('list reports both layers', () => {
  const { env } = sandbox()
  saveMemory(env, { title: 'Alpha', content: 'a', scope: 'user' })
  saveMemory(env, { title: 'Beta', content: 'b' })
  const listed = listMemory(env, {})
  assert.match(listed.message, /用户层（1 条）/)
  assert.match(listed.message, /项目层 claude_projects（1 条）/)
  assert.equal(listed.count, 2)
})

test('forget archives and then stops appearing', () => {
  const { env, memoryHome } = sandbox()
  const saved = saveMemory(env, { title: 'Temporary', content: 'x' })
  const removed = forgetMemory(env, { slug: saved.slug, reason: '用户说不用记' })
  assert.equal(removed.ok, true)
  assert.match(removed.path, new RegExp(`${memoryHome.replaceAll('/', '\\/')}\\/archive\\/`))
  assert.equal(recallMemory(env, { slug: saved.slug }).ok, false)
  assert.equal(forgetMemory(env, { slug: saved.slug }).ok, false)
})

test('validation rejects empty and oversized content', () => {
  const { env } = sandbox()
  assert.equal(saveMemory(env, { title: '', content: 'x' }).ok, false)
  assert.equal(saveMemory(env, { title: 't', content: '   ' }).ok, false)
  assert.equal(saveMemory(env, { title: 't', content: 'x'.repeat(MAX_ENTRY_BYTES + 1) }).ok, false)
  assert.equal(saveMemory(env, { title: 't', content: 'x', scope: 'galaxy' }).ok, false)
})
