import assert from 'node:assert/strict'
import test from 'node:test'
import { renderMemory } from '../lib/render.js'

const limits = { userMaxChars: 1500, projectMaxChars: 2500, pinnedMaxChars: 400 }

/** Build one entry with defaults. */
function entry(overrides) {
  return {
    slug: 'slug',
    title: '标题',
    type: 'fact',
    pinned: false,
    updated: '2026-10-18T10:00:00+08:00',
    supersededBy: null,
    body: '正文',
    ...overrides,
  }
}

test('renders both layers with a summary line per entry', () => {
  const text = renderMemory({
    userEntries: [entry({ slug: 'language', title: '只允许中文简体和英文', type: 'constraint', pinned: true })],
    projectEntries: [entry({ slug: 'zero-deps', title: '插件零运行时依赖', type: 'decision' })],
    projectLabel: 'claude_projects',
    includeUser: true,
    limits,
  })
  assert.match(text, /## 持久记忆/)
  assert.match(text, /用户层记忆（跨所有项目）/)
  assert.match(text, /\[constraint·pinned\] 只允许中文简体和英文/)
  assert.match(text, /项目记忆 · claude_projects/)
  assert.match(text, /\[decision\] 插件零运行时依赖（10-18）/)
})

test('pinned entries carry their body, others do not', () => {
  const text = renderMemory({
    userEntries: [entry({ type: 'constraint', pinned: true, body: '结论：只写中文\n为什么：用户要求' })],
    projectEntries: [entry({ pinned: false, body: '不该出现的正文' })],
    projectLabel: 'p',
    includeUser: true,
    limits,
  })
  assert.match(text, /^ {2}结论：只写中文$/m)
  assert.doesNotMatch(text, /不该出现的正文/)
})

test('superseded entries never render', () => {
  const text = renderMemory({
    userEntries: [],
    projectEntries: [entry({ slug: 'old', title: '旧结论', supersededBy: 'new', pinned: true })],
    projectLabel: 'p',
    includeUser: false,
    limits,
  })
  assert.equal(text, '')
})

test('respects the project budget and announces omissions', () => {
  const entries = Array.from({ length: 40 }, (_, index) => entry({ slug: `s${index}`, title: `第 ${index} 条记忆标题` }))
  const text = renderMemory({ userEntries: [], projectEntries: entries, projectLabel: 'p', includeUser: false, limits: { ...limits, projectMaxChars: 300 } })
  assert.ok(text.length < 700, `rendered ${text.length} chars`)
  assert.match(text, /另有 \d+ 条未注入/)
  assert.match(text, /memory_list/)
})

test('includeUser=false hides the user layer entirely', () => {
  const text = renderMemory({
    userEntries: [entry({ title: '用户偏好' })],
    projectEntries: [entry({ title: '项目决策' })],
    projectLabel: 'p',
    includeUser: false,
    limits,
  })
  assert.doesNotMatch(text, /用户偏好/)
  assert.match(text, /项目决策/)
})

test('empty memory renders to an empty string', () => {
  assert.equal(renderMemory({ userEntries: [], projectEntries: [], projectLabel: 'p', includeUser: true, limits }), '')
})

test('pinned body is clipped to the pinned budget', () => {
  const text = renderMemory({
    userEntries: [],
    projectEntries: [entry({ pinned: true, body: 'x'.repeat(1000) })],
    projectLabel: 'p',
    includeUser: false,
    limits: { ...limits, pinnedMaxChars: 50 },
  })
  assert.match(text, /…/)
})
