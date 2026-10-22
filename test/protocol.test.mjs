import assert from 'node:assert/strict'
import test from 'node:test'
import { protocolText } from '../lib/protocol.js'

test('protocol states both layer triggers and the scope default', () => {
  const text = protocolText()
  assert.match(text, /记一下/)
  assert.match(text, /顶层记忆/)
  assert.match(text, /scope="project"/)
  assert.match(text, /scope="user"/)
})

test('protocol separates memory from AGENTS.md, skills and HANDOVER', () => {
  const text = protocolText()
  assert.match(text, /AGENTS\.md/)
  assert.match(text, /skill/)
  assert.match(text, /HANDOVER/)
})

test('autoMemorize=false disables proactive writing in the protocol', () => {
  const text = protocolText({ autoMemorize: false })
  assert.match(text, /关闭主动记忆/)
  assert.doesNotMatch(text, /一次会话最多 3 条/)
  assert.match(text, /用户明确要求时才写入/)
})

test('protocol stays within a sane prompt budget', () => {
  assert.ok(protocolText().length < 1200, `protocol is ${protocolText().length} chars`)
})
