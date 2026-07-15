import { randomUUID } from 'node:crypto'
import type { AgentScope } from '@helix/contracts/agent'
import {
  AGENT_RECENT_MESSAGE_LIMIT,
  AGENT_VISIBLE_MESSAGE_LIMIT,
  DEFAULT_AGENT_CONVERSATION_ID,
} from '@helix/contracts/agent'
import type { UIMessage } from 'ai'
import { normalizeAgentScope } from './schemas'
import { agentDatabase } from './story-store'

const LEGACY_MIGRATION_ID = 'scoped-conversations-to-main-v1'

type StoredMessageRow = {
  message_order: number
  message_json: string
}

type LegacyMessageRow = StoredMessageRow & {
  symbol: string
  timeframe: string
  created_at: number
  updated_at: number
}

export type AgentConversationCompactionCandidate = {
  conversationId: string
  previousSummary: string | null
  messages: Array<{ messageOrder: number; message: UIMessage }>
  throughOrder: number
}

let schemaReady = false

function parseStoredMessage(raw: string): UIMessage {
  const value = JSON.parse(raw) as Partial<UIMessage>
  if (
    typeof value.id !== 'string'
    || !['system', 'user', 'assistant'].includes(value.role ?? '')
    || !Array.isArray(value.parts)
  ) {
    throw new Error('INVALID_STORED_AGENT_MESSAGE')
  }
  return value as UIMessage
}

function recordValue(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function messageScene(message: UIMessage): AgentScope | null {
  const metadata = recordValue(message.metadata)
  const helix = recordValue(metadata.helix)
  const scene = recordValue(helix.scene)
  return typeof scene.symbol === 'string' && typeof scene.timeframe === 'string'
    ? normalizeAgentScope({ symbol: scene.symbol, timeframe: scene.timeframe })
    : null
}

function messageWithScene<MESSAGE extends UIMessage>(
  message: MESSAGE,
  input: AgentScope,
  previous?: MESSAGE,
): MESSAGE {
  const scene = messageScene(message) ?? (previous ? messageScene(previous) : null) ?? normalizeAgentScope(input)
  const previousMetadata = recordValue(previous?.metadata)
  const metadata = { ...previousMetadata, ...recordValue(message.metadata) }
  return {
    ...message,
    id: message.id.trim() || randomUUID(),
    metadata: {
      ...metadata,
      helix: {
        ...recordValue(metadata.helix),
        scene,
      },
    },
  } as MESSAGE
}

function migrateLegacyMessages(db: ReturnType<typeof agentDatabase>) {
  const migrated = db.prepare(`
    SELECT 1 FROM agent_conversation_migrations WHERE id = ?
  `).get(LEGACY_MIGRATION_ID)
  if (migrated) return

  const legacyTable = db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'agent_conversation_messages'
  `).get()
  const rows = legacyTable
    ? db.prepare(`
        SELECT symbol, timeframe, message_order, message_json, created_at, updated_at
        FROM agent_conversation_messages
        ORDER BY created_at ASC, scope_key ASC, message_order ASC
      `).all() as LegacyMessageRow[]
    : []
  const insert = db.prepare(`
    INSERT INTO agent_session_messages (
      conversation_id, message_id, symbol, timeframe, role, message_order,
      message_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const seenIds = new Set<string>()

  db.exec('BEGIN IMMEDIATE')
  try {
    let messageOrder = 0
    for (const row of rows) {
      const parsed = parseStoredMessage(row.message_json)
      const originalId = parsed.id.trim()
      const messageId = originalId && !seenIds.has(originalId) ? originalId : randomUUID()
      seenIds.add(messageId)
      const message = messageWithScene({ ...parsed, id: messageId }, row)
      const scene = messageScene(message)!
      insert.run(
        DEFAULT_AGENT_CONVERSATION_ID,
        message.id,
        scene.symbol,
        scene.timeframe,
        message.role,
        ++messageOrder,
        JSON.stringify(message),
        row.created_at,
        row.updated_at,
      )
    }
    db.prepare(`
      INSERT INTO agent_conversation_migrations (id, applied_at) VALUES (?, ?)
    `).run(LEGACY_MIGRATION_ID, Date.now())
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function database() {
  const db = agentDatabase()
  if (schemaReady) return db

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_conversations (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_session_messages (
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      role TEXT NOT NULL,
      message_order INTEGER NOT NULL,
      message_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, message_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS agent_session_messages_order
      ON agent_session_messages (conversation_id, message_order ASC);
    CREATE TABLE IF NOT EXISTS agent_conversation_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_conversation_archive_state (
      conversation_id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      through_order INTEGER NOT NULL,
      archived_message_count INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_archived_session_messages (
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      message_order INTEGER NOT NULL,
      message_json TEXT NOT NULL,
      archived_at INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS agent_archived_session_messages_order
      ON agent_archived_session_messages (conversation_id, message_order ASC);
  `)
  const now = Date.now()
  db.prepare(`
    INSERT OR IGNORE INTO agent_conversations (id, created_at, updated_at) VALUES (?, ?, ?)
  `).run(DEFAULT_AGENT_CONVERSATION_ID, now, now)
  migrateLegacyMessages(db)
  schemaReady = true
  return db
}

export function readAgentConversation<MESSAGE extends UIMessage = UIMessage>(
  conversationId = DEFAULT_AGENT_CONVERSATION_ID,
): MESSAGE[] {
  const rows = database()
    .prepare(`
      SELECT message_json
      FROM agent_session_messages
      WHERE conversation_id = ?
      ORDER BY message_order ASC
    `)
    .all(conversationId) as Array<{ message_json: string }>

  return rows.map((row) => parseStoredMessage(row.message_json) as MESSAGE)
}

export function readVisibleAgentConversation<MESSAGE extends UIMessage = UIMessage>(
  conversationId = DEFAULT_AGENT_CONVERSATION_ID,
  requestedLimit = AGENT_VISIBLE_MESSAGE_LIMIT,
): MESSAGE[] {
  const limit = Math.max(1, Math.min(AGENT_VISIBLE_MESSAGE_LIMIT, Math.trunc(requestedLimit)))
  const rows = database().prepare(`
    SELECT message_json FROM (
      SELECT message_order, message_json
      FROM agent_session_messages
      WHERE conversation_id = ?
      ORDER BY message_order DESC
      LIMIT ?
    ) ORDER BY message_order ASC
  `).all(conversationId, limit) as Array<{ message_json: string }>
  return rows.map((row) => parseStoredMessage(row.message_json) as MESSAGE)
}

export function readAgentConversationArchive(conversationId = DEFAULT_AGENT_CONVERSATION_ID) {
  const row = database().prepare(`
    SELECT summary FROM agent_conversation_archive_state WHERE conversation_id = ?
  `).get(conversationId) as { summary: string } | undefined
  return row?.summary ?? null
}

export function readAgentConversationCompactionCandidate(
  conversationId = DEFAULT_AGENT_CONVERSATION_ID,
): AgentConversationCompactionCandidate | null {
  const count = Number((database().prepare(`
    SELECT COUNT(*) AS count FROM agent_session_messages WHERE conversation_id = ?
  `).get(conversationId) as { count: number }).count)
  if (count < AGENT_RECENT_MESSAGE_LIMIT) return null
  const archiveCount = count - AGENT_VISIBLE_MESSAGE_LIMIT
  if (archiveCount <= 0) return null
  const rows = database().prepare(`
    SELECT message_order, message_json
    FROM agent_session_messages
    WHERE conversation_id = ?
    ORDER BY message_order ASC
    LIMIT ?
  `).all(conversationId, archiveCount) as StoredMessageRow[]
  if (rows.length === 0) return null
  return {
    conversationId,
    previousSummary: readAgentConversationArchive(conversationId),
    messages: rows.map((row) => ({
      messageOrder: row.message_order,
      message: parseStoredMessage(row.message_json),
    })),
    throughOrder: rows.at(-1)!.message_order,
  }
}

export function commitAgentConversationCompaction(
  candidate: AgentConversationCompactionCandidate,
  summary: string,
) {
  const db = database()
  const now = Date.now()
  db.exec('BEGIN IMMEDIATE')
  try {
    const archived = db.prepare(`
      INSERT OR IGNORE INTO agent_archived_session_messages (
        conversation_id, message_id, message_order, message_json, archived_at
      )
      SELECT conversation_id, message_id, message_order, message_json, ?
      FROM agent_session_messages
      WHERE conversation_id = ? AND message_order <= ?
    `).run(now, candidate.conversationId, candidate.throughOrder)
    db.prepare(`
      INSERT INTO agent_conversation_archive_state (
        conversation_id, summary, through_order, archived_message_count, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        summary = excluded.summary,
        through_order = excluded.through_order,
        archived_message_count = agent_conversation_archive_state.archived_message_count
          + excluded.archived_message_count,
        updated_at = excluded.updated_at
    `).run(candidate.conversationId, summary, candidate.throughOrder, Number(archived.changes), now)
    db.prepare(`
      DELETE FROM agent_session_messages
      WHERE conversation_id = ? AND message_order <= ?
    `).run(candidate.conversationId, candidate.throughOrder)
    db.exec('COMMIT')
    return Number(archived.changes)
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function filterArchivedAgentMessages<MESSAGE extends UIMessage>(
  conversationId: string,
  messages: MESSAGE[],
) {
  const archived = database().prepare(`
    SELECT 1 FROM agent_archived_session_messages
    WHERE conversation_id = ? AND message_id = ?
  `)
  return messages.filter((message) => !archived.get(conversationId, message.id))
}

export function listRecentAgentConversationScopes(limit = 20): AgentScope[] {
  return database().prepare(`
    SELECT symbol, timeframe, MAX(updated_at) AS last_seen
    FROM agent_session_messages
    GROUP BY symbol, timeframe
    ORDER BY last_seen DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(100, Math.trunc(limit)))) as AgentScope[]
}

export function contextualizeAgentMessages<MESSAGE extends UIMessage>(
  existing: MESSAGE[],
  incoming: MESSAGE[],
  scope: AgentScope,
) {
  const previousById = new Map(existing.map((message) => [message.id, message]))
  return incoming.map((message) => messageWithScene(message, scope, previousById.get(message.id)))
}

export function mergeAgentConversation<MESSAGE extends UIMessage>(existing: MESSAGE[], incoming: MESSAGE[]) {
  const messages = new Map(existing.map((message) => [message.id, message]))
  for (const message of incoming) messages.set(message.id, message)
  return [...messages.values()]
}

export function messagesWithAgentSceneContext<MESSAGE extends UIMessage>(messages: MESSAGE[]): MESSAGE[] {
  return messages.map((message) => {
    const scene = messageScene(message)
    if (message.role !== 'user' || !scene) return message

    let annotated = false
    return {
      ...message,
      parts: message.parts.map((part) => {
        if (annotated || part.type !== 'text') return part
        annotated = true
        return { ...part, text: `[发送场景：${scene.symbol} · ${scene.timeframe}]\n${part.text}` }
      }),
    } as MESSAGE
  })
}

export function writeAgentConversation(
  conversationId: string,
  input: AgentScope,
  messages: UIMessage[],
) {
  if (messages.length === 0) return

  const scope = normalizeAgentScope(input)
  const now = Date.now()
  const db = database()
  const readMaxOrder = db.prepare(`
    SELECT COALESCE(MAX(message_order), 0) AS max_order
    FROM agent_session_messages
    WHERE conversation_id = ?
  `)
  const findExisting = db.prepare(`
    SELECT message_order, message_json
    FROM agent_session_messages
    WHERE conversation_id = ? AND message_id = ?
  `)
  const isArchived = db.prepare(`
    SELECT 1 FROM agent_archived_session_messages
    WHERE conversation_id = ? AND message_id = ?
  `)
  const upsert = db.prepare(`
    INSERT INTO agent_session_messages (
      conversation_id, message_id, symbol, timeframe, role, message_order,
      message_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id, message_id) DO UPDATE SET
      role = excluded.role,
      message_json = excluded.message_json,
      updated_at = excluded.updated_at
  `)

  db.exec('BEGIN IMMEDIATE')
  try {
    let nextOrder = Number((readMaxOrder.get(conversationId) as { max_order: number }).max_order)
    for (const rawMessage of messages) {
      const messageId = rawMessage.id.trim()
      if (messageId && isArchived.get(conversationId, messageId)) continue
      const existing = messageId
        ? findExisting.get(conversationId, messageId) as StoredMessageRow | undefined
        : undefined
      const previous = existing ? parseStoredMessage(existing.message_json) : undefined
      const message = messageWithScene(rawMessage, scope, previous)
      const scene = messageScene(message)!
      const messageOrder = existing?.message_order ?? ++nextOrder
      upsert.run(
        conversationId,
        message.id,
        scene.symbol,
        scene.timeframe,
        message.role,
        messageOrder,
        JSON.stringify(message),
        now,
        now,
      )
    }
    db.prepare(`
      UPDATE agent_conversations SET updated_at = ? WHERE id = ?
    `).run(now, conversationId)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
