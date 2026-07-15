import { randomUUID } from 'node:crypto'
import type {
  AgentAnalysisRun,
  AgentAnalysisTrigger,
  AgentScope,
} from '@helix/contracts/agent'
import { agentScopeKey, normalizeAgentScope } from './schemas'
import { agentDatabase } from './story-store'

let schemaReady = false

function database() {
  const db = agentDatabase()
  if (schemaReady) return db
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_analysis_runs (
      id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      symbol TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      output TEXT,
      story_revision INTEGER,
      error TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS agent_analysis_runs_scope
      ON agent_analysis_runs (scope_key, started_at DESC);
    CREATE TABLE IF NOT EXISTS agent_scheduler_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  schemaReady = true
  return db
}

function rowToRun(row: Record<string, unknown>): AgentAnalysisRun {
  return {
    id: String(row.id),
    symbol: String(row.symbol),
    timeframe: String(row.timeframe),
    trigger: row.trigger as AgentAnalysisRun['trigger'],
    status: row.status as AgentAnalysisRun['status'],
    attempt: Number(row.attempt),
    output: typeof row.output === 'string' ? row.output : null,
    storyRevision: typeof row.story_revision === 'number' ? row.story_revision : null,
    error: typeof row.error === 'string' ? row.error : null,
    startedAt: Number(row.started_at),
    completedAt: typeof row.completed_at === 'number' ? row.completed_at : null,
  }
}

export function startAgentAnalysisRun(
  input: AgentScope,
  trigger: AgentAnalysisTrigger,
  attempt: number,
) {
  const scope = normalizeAgentScope(input)
  const id = randomUUID()
  const startedAt = Date.now()
  database().prepare(`
    INSERT INTO agent_analysis_runs (
      id, scope_key, symbol, timeframe, trigger, status, attempt, started_at
    ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)
  `).run(id, agentScopeKey(scope), scope.symbol, scope.timeframe, trigger, attempt, startedAt)
  return { id, startedAt }
}

export function completeAgentAnalysisRun(id: string, output: string, storyRevision: number | null) {
  database().prepare(`
    UPDATE agent_analysis_runs
    SET status = 'succeeded', output = ?, story_revision = ?, error = NULL, completed_at = ?
    WHERE id = ? AND status = 'running'
  `).run(output, storyRevision, Date.now(), id)
}

export function failAgentAnalysisRun(id: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  database().prepare(`
    UPDATE agent_analysis_runs
    SET status = 'failed', error = ?, completed_at = ?
    WHERE id = ? AND status = 'running'
  `).run(message.slice(0, 1000), Date.now(), id)
}

export function recoverInterruptedAgentAnalysisRuns() {
  const now = Date.now()
  const result = database().prepare(`
    UPDATE agent_analysis_runs
    SET status = 'failed', error = 'DAEMON_RESTARTED_DURING_ANALYSIS', completed_at = ?
    WHERE status = 'running'
  `).run(now)
  return Number(result.changes)
}

export function readAgentAnalysisRuns(input: AgentScope, requestedLimit = 20): AgentAnalysisRun[] {
  const scope = normalizeAgentScope(input)
  const limit = Math.max(1, Math.min(100, Math.trunc(requestedLimit)))
  const rows = database().prepare(`
    SELECT id, symbol, timeframe, trigger, status, attempt, output, story_revision,
           error, started_at, completed_at
    FROM agent_analysis_runs
    WHERE scope_key = ?
    ORDER BY started_at DESC, id DESC
    LIMIT ?
  `).all(agentScopeKey(scope), limit) as Array<Record<string, unknown>>
  return rows.map(rowToRun)
}

export function readAgentSchedulerState(key: string) {
  const row = database().prepare('SELECT value FROM agent_scheduler_state WHERE key = ?')
    .get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function writeAgentSchedulerState(key: string, value: string) {
  database().prepare(`
    INSERT INTO agent_scheduler_state (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, Date.now())
}
