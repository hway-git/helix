import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  AgentScope,
  MarketScenario,
  MarketStory,
  MarketStoryEvent,
  MarketStoryState,
  MarketStoryTransition,
} from '@helix/contracts/agent'
import {
  agentScopeKey,
  marketStorySchema,
  marketStoryUpdateSchema,
  normalizeAgentScope,
  type MarketStoryUpdate,
} from './schemas'

const DEFAULT_DATABASE_PATH = resolve(homedir(), '.helix', 'helix.sqlite')

type AgentDatabaseGlobal = typeof globalThis & {
  __helixAgentDatabase?: DatabaseSync
}

const TERMINAL_STATES = new Set<MarketStoryState>(['rejected', 'expired'])
const ALLOWED_TRANSITIONS: Record<MarketStoryState, ReadonlySet<MarketStoryState>> = {
  watching: new Set(['watching', 'armed', 'confirmed', 'rejected', 'expired']),
  armed: new Set(['watching', 'armed', 'confirmed', 'rejected', 'expired']),
  confirmed: new Set(['confirmed', 'rejected', 'expired']),
  rejected: new Set(['rejected']),
  expired: new Set(['expired']),
}

function databasePath() {
  return process.env.HELIX_DATABASE_PATH
    ? resolve(process.env.HELIX_DATABASE_PATH)
    : DEFAULT_DATABASE_PATH
}

export function agentDatabase() {
  const globalState = globalThis as AgentDatabaseGlobal
  if (globalState.__helixAgentDatabase) return globalState.__helixAgentDatabase

  const path = databasePath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;')
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_market_stories (
      scope_key TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      revision INTEGER NOT NULL,
      story_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_story_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_key TEXT NOT NULL,
      revision INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      occurred_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_story_events_scope
      ON agent_story_events (scope_key, revision DESC, id DESC);
  `)
  chmodSync(path, 0o600)
  globalState.__helixAgentDatabase = db
  return db
}

export function readMarketStory(input: AgentScope): MarketStory | null {
  const row = agentDatabase()
    .prepare('SELECT story_json FROM agent_market_stories WHERE scope_key = ?')
    .get(agentScopeKey(input)) as { story_json: string } | undefined

  if (!row) return null
  return marketStorySchema.parse(JSON.parse(row.story_json))
}

export function listMarketStoryScopes(limit = 20): AgentScope[] {
  return agentDatabase().prepare(`
    SELECT symbol, timeframe FROM agent_market_stories
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(100, Math.trunc(limit)))) as AgentScope[]
}

export function readMarketStoryEvents(input: AgentScope, requestedLimit = 50): MarketStoryEvent[] {
  const scope = normalizeAgentScope(input)
  const limit = Math.max(1, Math.min(100, Math.trunc(requestedLimit)))
  const rows = agentDatabase().prepare(`
    SELECT id, revision, event_type, payload_json, occurred_at
    FROM agent_story_events
    WHERE scope_key = ?
    ORDER BY revision DESC, id DESC
    LIMIT ?
  `).all(agentScopeKey(scope), limit) as Array<{
    id: number
    revision: number
    event_type: MarketStoryEvent['eventType']
    payload_json: string
    occurred_at: number
  }>

  return rows.map((row) => {
    const payload = JSON.parse(row.payload_json) as {
      changeSummary: string
      transitions: MarketStoryTransition[]
    }
    return {
      ...scope,
      id: row.id,
      revision: row.revision,
      eventType: row.event_type,
      changeSummary: payload.changeSummary,
      transitions: payload.transitions,
      occurredAt: row.occurred_at,
    }
  })
}

function assertScenarioTransition(previous: MarketScenario | undefined, next: MarketScenario) {
  if (!previous) {
    if (TERMINAL_STATES.has(next.state)) {
      throw new Error(`NEW_SCENARIO_TERMINAL_STATE:${next.state}`)
    }
    return
  }
  if (!ALLOWED_TRANSITIONS[previous.state].has(next.state)) {
    throw new Error(`INVALID_SCENARIO_TRANSITION:${previous.state}->${next.state}`)
  }
}

function nextScenarios(previous: MarketStory | null, update: MarketStoryUpdate, now: number): MarketScenario[] {
  const previousById = new Map(previous?.scenarios.map((scenario) => [scenario.id, scenario]) ?? [])

  const next = update.scenarios.map((scenario) => {
    const existing = previous && scenario.id ? previousById.get(scenario.id) : undefined
    if (previous && scenario.id && !existing) throw new Error(`UNKNOWN_SCENARIO_ID:${scenario.id}`)
    if (existing && existing.thesis !== scenario.thesis) {
      throw new Error(`SCENARIO_THESIS_IMMUTABLE:${scenario.id}`)
    }

    const result = {
      ...scenario,
      id: existing?.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    assertScenarioTransition(existing, result)
    return result
  })

  const nextIds = new Set(next.map((scenario) => scenario.id))
  const omittedActive = previous?.scenarios.find((scenario) => (
    !TERMINAL_STATES.has(scenario.state) && !nextIds.has(scenario.id)
  ))
  if (omittedActive) throw new Error(`ACTIVE_SCENARIO_OMITTED:${omittedActive.id}`)
  return next
}

export function writeMarketStory(input: AgentScope, rawUpdate: MarketStoryUpdate): MarketStory {
  const scope = normalizeAgentScope(input)
  const previous = readMarketStory(scope)
  const update = marketStoryUpdateSchema.parse(previous ? rawUpdate : {
    ...rawUpdate,
    scenarios: rawUpdate.scenarios.map(({ id: _placeholderId, ...scenario }) => scenario),
  })
  const now = Date.now()
  const story = marketStorySchema.parse({
    id: previous?.id ?? randomUUID(),
    ...scope,
    revision: (previous?.revision ?? 0) + 1,
    summary: update.summary,
    changeSummary: update.changeSummary,
    analysisSource: update.analysisSource,
    strategyVersion: update.strategyVersion,
    scenarios: nextScenarios(previous, update, now),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  })

  const transitions = story.scenarios.flatMap((scenario) => {
    const before = previous?.scenarios.find((item) => item.id === scenario.id)
    return before && before.state !== scenario.state
      ? [{ scenarioId: scenario.id, from: before.state, to: scenario.state }]
      : []
  })

  const db = agentDatabase()
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`
      INSERT INTO agent_market_stories (
        scope_key, symbol, timeframe, revision, story_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_key) DO UPDATE SET
        revision = excluded.revision,
        story_json = excluded.story_json,
        updated_at = excluded.updated_at
    `).run(
      agentScopeKey(scope),
      scope.symbol,
      scope.timeframe,
      story.revision,
      JSON.stringify(story),
      story.createdAt,
      story.updatedAt,
    )
    db.prepare(`
      INSERT INTO agent_story_events (
        scope_key, revision, event_type, payload_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      agentScopeKey(scope),
      story.revision,
      previous ? 'story_updated' : 'story_created',
      JSON.stringify({ changeSummary: story.changeSummary, transitions }),
      now,
    )
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  return story
}
