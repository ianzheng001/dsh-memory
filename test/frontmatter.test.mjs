import assert from 'node:assert/strict'
import test from 'node:test'
import { formatValue, parseDocument, parseValue, serializeDocument } from '../lib/frontmatter.js'

test('parses frontmatter and body', () => {
  const raw = ['---', 'slug: demo', 'title: "带: 冒号的标题"', 'tags: ["a", "b"]', 'pinned: true', 'supersededBy: null', '---', '', '正文第一行', '正文第二行', ''].join('\n')
  const { meta, body } = parseDocument(raw)
  assert.equal(meta.slug, 'demo')
  assert.equal(meta.title, '带: 冒号的标题')
  assert.deepEqual(meta.tags, ['a', 'b'])
  assert.equal(meta.pinned, true)
  assert.equal(meta.supersededBy, null)
  assert.equal(body, '正文第一行\n正文第二行')
})

test('treats a document without frontmatter as body only', () => {
  const { meta, body } = parseDocument('just prose\n')
  assert.deepEqual(meta, {})
  assert.equal(body, 'just prose')
})

test('round-trips a serialized document', () => {
  const meta = { slug: 's', title: '标题 "引号" 与: 冒号', type: 'pitfall', tags: ['x'], pinned: false, supersededBy: null }
  const text = serializeDocument(meta, 'line1\nline2')
  const parsed = parseDocument(text)
  assert.equal(parsed.meta.title, meta.title)
  assert.deepEqual(parsed.meta.tags, ['x'])
  assert.equal(parsed.meta.pinned, false)
  assert.equal(parsed.meta.supersededBy, null)
  assert.equal(parsed.body, 'line1\nline2')
})

test('orders known fields before unknown ones', () => {
  const text = serializeDocument({ extra: 'z', title: 't', slug: 's' }, '')
  const lines = text.split('\n')
  assert.equal(lines[1], 'slug: "s"')
  assert.equal(lines[2], 'title: "t"')
  assert.equal(lines[3], 'extra: "z"')
})

test('parses scalar shapes', () => {
  assert.equal(parseValue(''), '')
  assert.equal(parseValue('null'), null)
  assert.equal(parseValue('true'), true)
  assert.deepEqual(parseValue('[]'), [])
  assert.equal(parseValue("'it''s'"), "it's")
  assert.equal(formatValue(['a']), '["a"]')
  assert.equal(formatValue(false), 'false')
})
