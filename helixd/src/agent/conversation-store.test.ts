import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DEFAULT_AGENT_CONVERSATION_ID } from '@helix/contracts/agent'
import type { UIMessage } from 'ai'

const testRoot = mkdtempSync(join(tmpdir(), 'helix-agent-conversation-'))
process.env.HELIX_DATABASE_PATH = join(testRoot, 'helix.sqlite')

function text(message: UIMessage) {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
}

function scene(message: UIMessage) {
  return (message.metadata as { helix?: { scene?: { symbol?: string; timeframe?: string } } })
    ?.helix?.scene
}

test('migrates scoped history into one ordered scene-aware conversation', async () => {
  const { agentDatabase } = await import('./story-store')
  const db = agentDatabase()
  db.exec(`
    CREATE TABLE agent_conversation_messages (
      scope_key TEXT NOT NULL,
      message_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      role TEXT NOT NULL,
      message_order INTEGER NOT NULL,
      message_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope_key, message_id)
    );
  `)
  const insertLegacy = db.prepare(`
    INSERT INTO agent_conversation_messages (
      scope_key, message_id, symbol, timeframe, role, message_order,
      message_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  insertLegacy.run(
    'BTC/USDT:15m',
    'user-1',
    'BTC/USDT',
    '15m',
    'user',
    1,
    JSON.stringify({ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'BTC 现在呢？' }] }),
    1_000,
    1_000,
  )
  insertLegacy.run(
    'BTC/USDT:15m',
    '',
    'BTC/USDT',
    '15m',
    'assistant',
    2,
    JSON.stringify({ id: '', role: 'assistant', parts: [{ type: 'text', text: '仍在等待。' }] }),
    2_000,
    2_000,
  )
  insertLegacy.run(
    'ETH/USDT:1h',
    'user-eth',
    'ETH/USDT',
    '1h',
    'user',
    1,
    JSON.stringify({ id: 'user-eth', role: 'user', parts: [{ type: 'text', text: '切到 ETH。' }] }),
    3_000,
    3_000,
  )

  const {
    contextualizeAgentMessages,
    messagesWithAgentSceneContext,
    readAgentConversation,
    writeAgentConversation,
  } = await import('./conversation-store')
  const migrated = readAgentConversation()

  assert.deepEqual(migrated.map(text), ['BTC 现在呢？', '仍在等待。', '切到 ETH。'])
  assert.equal(new Set(migrated.map((message) => message.id)).size, 3)
  assert.ok(migrated.every((message) => message.id.length > 0))
  assert.deepEqual(scene(migrated[0]), { symbol: 'BTC/USDT', timeframe: '15m' })
  assert.deepEqual(scene(migrated[2]), { symbol: 'ETH/USDT', timeframe: '1h' })

  const incoming = contextualizeAgentMessages(migrated, [
    { id: 'user-2', role: 'user', parts: [{ type: 'text', text: '这个级别呢？' }] },
  ], { symbol: 'sol/usdt', timeframe: '5M' })
  writeAgentConversation(
    DEFAULT_AGENT_CONVERSATION_ID,
    { symbol: 'sol/usdt', timeframe: '5M' },
    incoming,
  )

  const persisted = readAgentConversation()
  assert.deepEqual(persisted.map(text), [
    'BTC 现在呢？',
    '仍在等待。',
    '切到 ETH。',
    '这个级别呢？',
  ])
  assert.deepEqual(scene(persisted[3]), { symbol: 'SOL/USDT', timeframe: '5m' })
  assert.match(text(messagesWithAgentSceneContext([persisted[3]])[0]), /^\[发送场景：SOL\/USDT · 5m\]/)

  writeAgentConversation(
    DEFAULT_AGENT_CONVERSATION_ID,
    { symbol: 'ETH/USDT', timeframe: '1h' },
    [{ ...persisted[0], metadata: undefined, parts: [{ type: 'text', text: 'BTC 继续。' }] }],
  )
  const updated = readAgentConversation()
  assert.deepEqual(updated.map(text), ['BTC 继续。', '仍在等待。', '切到 ETH。', '这个级别呢？'])
  assert.deepEqual(scene(updated[0]), { symbol: 'BTC/USDT', timeframe: '15m' })

  const archiveBatch = Array.from({ length: 96 }, (_, index): UIMessage => ({
    id: `archive-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    parts: [{ type: 'text', text: `归档消息 ${index}` }],
  }))
  writeAgentConversation(DEFAULT_AGENT_CONVERSATION_ID, { symbol: 'BTC/USDT', timeframe: '15m' }, archiveBatch)
  const {
    commitAgentConversationCompaction,
    filterArchivedAgentMessages,
    readAgentConversationArchive,
    readAgentConversationCompactionCandidate,
    readVisibleAgentConversation,
  } = await import('./conversation-store')
  const candidate = readAgentConversationCompactionCandidate()!
  assert.equal(candidate.messages.length, 40)
  assert.equal(commitAgentConversationCompaction(candidate, '压缩后的历史摘要。'), 40)
  assert.equal(readAgentConversation().length, 60)
  assert.equal(readVisibleAgentConversation().length, 60)
  assert.equal(readAgentConversationArchive(), '压缩后的历史摘要。')
  assert.deepEqual(filterArchivedAgentMessages(DEFAULT_AGENT_CONVERSATION_ID, [candidate.messages[0].message]), [])

  writeAgentConversation(
    DEFAULT_AGENT_CONVERSATION_ID,
    { symbol: 'BTC/USDT', timeframe: '15m' },
    candidate.messages.map((item) => item.message),
  )
  assert.equal(readAgentConversation().length, 60)
})
