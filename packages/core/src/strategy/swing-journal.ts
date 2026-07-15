import { chmodSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  SWING_SHADOW_ACTIONS,
  SWING_THESIS_STATES,
  type StoredSwingJournalEntry,
  type SwingJournalEntry,
  type SwingTradeThesisState,
} from '@helix/contracts/swing'
import type { StrategyManifestIdentity } from '@helix/contracts/strategy'
import { assertSwingTradeThesis, isSwingThesisTransitionAllowed } from './swing-state-machine'

const DEFAULT_DATABASE_PATH = resolve(homedir(), '.helix', 'helix.sqlite')

export type SwingJournalWrite = Omit<SwingJournalEntry, 'strategyLifecycle'>

type JournalRow = {
  sequence: number
  recorded_at: number
  decision_id: string
  strategy_id: string
  strategy_version: string
  strategy_repo_commit: string
  strategy_config_hash: string
  engine_version: string
  engine_commit: string
  market_data_snapshot_id: string
  strategy_lifecycle: SwingJournalEntry['strategyLifecycle']
  run_mode: SwingJournalEntry['runMode']
  decision_time: number
  symbol: string
  change_kind: SwingJournalEntry['change']['kind']
  thesis_id: string
  evidence_id: string | null
  from_state: SwingTradeThesisState | null
  to_state: SwingTradeThesisState | null
  occurred_at: number
  reason_codes_json: string
  feature_snapshot_json: string
  context_json: string | null
  location_json: string
  thesis_json: string
  evidence_json: string | null
  execution_json: string | null
  risk_json: string | null
  result_json: string | null
  shadow_action: SwingJournalEntry['shadowAction'] | null
}

function nonEmptyText(value: string, field: string) {
  if (!value.trim()) throw new Error(`${field} is required`)
}

function timestamp(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer timestamp`)
}

function json(value: unknown) {
  return value === undefined ? null : JSON.stringify(value)
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T
}

function parseOptionalJson<T>(value: string | null): T | undefined {
  return value == null ? undefined : parseJson<T>(value)
}

function assertReasonCodes(reasonCodes: string[]) {
  if (reasonCodes.length === 0) throw new Error('reasonCodes must not be empty')
  for (const reasonCode of reasonCodes) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(reasonCode)) throw new Error(`invalid reason code ${reasonCode}`)
  }
}

function assertRegisteredReasonCodes(manifest: StrategyManifestIdentity, reasonCodes: string[], field: string) {
  const registered = new Set(manifest.reasonCodes)
  const unknown = reasonCodes.filter((reasonCode) => !registered.has(reasonCode))
  if (unknown.length > 0) throw new Error(`${field} contains unregistered reason codes: ${unknown.join(', ')}`)
}

function isThesisState(value: unknown): value is SwingTradeThesisState {
  return typeof value === 'string' && SWING_THESIS_STATES.some((state) => state === value)
}

function assertManifestIdentity(manifest: StrategyManifestIdentity, entry: SwingJournalWrite) {
  if (manifest.schemaVersion !== 'helix.strategy/v1'
    || manifest.id !== 'helix_swing_hunter'
    || manifest.family !== 'swing'
    || manifest.objectModel !== 'TRADE_THESIS'
    || !/^1\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error('journal requires the Swing Hunter V1 manifest')
  }

  const requiredLifecycle = entry.runMode === 'shadow' ? 'shadow' : 'production'
  if (manifest.lifecycle !== requiredLifecycle) {
    throw new Error(`strategy lifecycle ${manifest.lifecycle} cannot run in ${entry.runMode} mode`)
  }
  if (entry.identity.strategyId !== manifest.id
    || entry.identity.strategyVersion !== manifest.version
    || entry.identity.strategyConfigHash !== manifest.configHash) {
    throw new Error('decision identity does not match the active manifest')
  }
}

function assertJournalWrite(manifest: StrategyManifestIdentity, entry: SwingJournalWrite) {
  assertManifestIdentity(manifest, entry)
  nonEmptyText(entry.decisionId, 'decisionId')
  nonEmptyText(entry.engineVersion, 'engineVersion')
  nonEmptyText(entry.symbol, 'symbol')
  nonEmptyText(entry.identity.strategyRepoCommit, 'identity.strategyRepoCommit')
  nonEmptyText(entry.identity.engineCommit, 'identity.engineCommit')
  nonEmptyText(entry.identity.marketDataSnapshotId, 'identity.marketDataSnapshotId')
  if (!/^sha256:[a-f0-9]{64}$/.test(entry.identity.strategyConfigHash)) {
    throw new Error('identity.strategyConfigHash must be a SHA-256 hash')
  }
  timestamp(entry.decisionTime, 'decisionTime')
  timestamp(entry.change.occurredAt, 'change.occurredAt')
  assertReasonCodes(entry.reasonCodes)
  assertSwingTradeThesis(entry.thesis)
  assertRegisteredReasonCodes(manifest, entry.reasonCodes, 'journal.reasonCodes')
  assertRegisteredReasonCodes(manifest, entry.thesis.reasonCodes, 'thesis.reasonCodes')
  for (const evidence of entry.thesis.evidence) {
    assertRegisteredReasonCodes(manifest, evidence.reasonCodes, `evidence.${evidence.id}.reasonCodes`)
  }
  if (entry.execution) assertRegisteredReasonCodes(manifest, entry.execution.reasonCodes, 'execution.reasonCodes')
  if (entry.risk) assertRegisteredReasonCodes(manifest, entry.risk.reasonCodes, 'risk.reasonCodes')

  nonEmptyText(entry.location.id, 'location.id')
  nonEmptyText(entry.location.type, 'location.type')
  if (entry.location.id !== entry.thesis.locationId) throw new Error('journal Location does not match Thesis Location')
  if (entry.symbol !== entry.thesis.symbol || entry.symbol !== entry.location.symbol) {
    throw new Error('journal symbol must match Thesis and Location symbols')
  }
  if (entry.context) {
    if (entry.context.id !== entry.thesis.contextId) throw new Error('journal Context does not match Thesis Context')
    if (entry.context.symbol !== entry.symbol) throw new Error('journal Context symbol does not match Thesis symbol')
    timestamp(entry.context.observedAt, 'context.observedAt')
    assertReasonCodes(entry.context.reasonCodes)
    assertRegisteredReasonCodes(manifest, entry.context.reasonCodes, 'context.reasonCodes')
  }
  if (!Number.isFinite(entry.location.score) || entry.location.score < 0 || entry.location.score > 100) {
    throw new Error('location.score must be between 0 and 100')
  }
  if (!Number.isFinite(entry.location.boundaries.lower)
    || !Number.isFinite(entry.location.boundaries.upper)
    || entry.location.boundaries.lower > entry.location.boundaries.upper) {
    throw new Error('location.boundaries are invalid')
  }
  assertReasonCodes(entry.location.reasonCodes)
  assertRegisteredReasonCodes(manifest, entry.location.reasonCodes, 'location.reasonCodes')

  if (entry.change.kind === 'THESIS_STATE') {
    if (entry.change.thesisId !== entry.thesis.id
      || entry.change.toState !== entry.thesis.state
      || entry.change.occurredAt !== entry.thesis.updatedAt) {
      throw new Error('THESIS_STATE change must match the current Thesis')
    }
    if (entry.change.fromState == null) {
      if (entry.change.toState !== 'CANDIDATE' || entry.change.occurredAt !== entry.thesis.createdAt) {
        throw new Error('new Thesis journals must begin at CANDIDATE')
      }
    } else if (!isThesisState(entry.change.fromState)
      || !isSwingThesisTransitionAllowed(entry.change.fromState, entry.change.toState)) {
      throw new Error(`illegal journal Thesis transition ${entry.change.fromState} -> ${entry.change.toState}`)
    }
  } else {
    const latestEvidence = entry.thesis.evidence.at(-1)
    if (!entry.evidence
      || entry.change.thesisId !== entry.thesis.id
      || entry.change.evidenceId !== entry.evidence.id
      || entry.change.occurredAt !== entry.evidence.time
      || entry.thesis.updatedAt !== entry.evidence.time
      || latestEvidence?.id !== entry.evidence.id
      || JSON.stringify(latestEvidence) !== JSON.stringify(entry.evidence)) {
      throw new Error('EVIDENCE_APPENDED change must match the latest ordered Evidence')
    }
  }

  if (entry.runMode === 'shadow') {
    if (!entry.shadowAction || !SWING_SHADOW_ACTIONS.includes(entry.shadowAction)) {
      throw new Error('shadow journal entries require a would_* action')
    }
  } else if (entry.shadowAction !== undefined) {
    throw new Error('production journal entries cannot contain a shadow action')
  }

  for (const [name, value] of Object.entries(entry.featureSnapshot)) {
    if (!name.trim()) throw new Error('feature snapshot keys must not be empty')
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`feature ${name} must be finite`)
  }
}

function toStoredEntry(row: JournalRow): StoredSwingJournalEntry {
  const change: SwingJournalEntry['change'] = row.change_kind === 'THESIS_STATE'
    ? {
        kind: 'THESIS_STATE',
        thesisId: row.thesis_id,
        fromState: row.from_state,
        toState: row.to_state!,
        occurredAt: row.occurred_at,
      }
    : {
        kind: 'EVIDENCE_APPENDED',
        thesisId: row.thesis_id,
        evidenceId: row.evidence_id!,
        occurredAt: row.occurred_at,
      }

  return {
    sequence: row.sequence,
    recordedAt: row.recorded_at,
    decisionId: row.decision_id,
    identity: {
      strategyId: row.strategy_id,
      strategyVersion: row.strategy_version,
      strategyRepoCommit: row.strategy_repo_commit,
      strategyConfigHash: row.strategy_config_hash,
      engineCommit: row.engine_commit,
      marketDataSnapshotId: row.market_data_snapshot_id,
    },
    engineVersion: row.engine_version,
    strategyLifecycle: row.strategy_lifecycle,
    runMode: row.run_mode,
    decisionTime: row.decision_time,
    symbol: row.symbol,
    change,
    reasonCodes: parseJson(row.reason_codes_json),
    featureSnapshot: parseJson(row.feature_snapshot_json),
    context: parseOptionalJson(row.context_json),
    location: parseJson(row.location_json),
    thesis: parseJson(row.thesis_json),
    evidence: parseOptionalJson(row.evidence_json),
    execution: parseOptionalJson(row.execution_json),
    risk: parseOptionalJson(row.risk_json),
    result: parseOptionalJson(row.result_json),
    shadowAction: row.shadow_action ?? undefined,
  }
}

export class SwingStrategyJournal {
  readonly path: string
  private readonly db: DatabaseSync

  constructor(databasePath = process.env.HELIX_DATABASE_PATH || DEFAULT_DATABASE_PATH) {
    this.path = resolve(databasePath)
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(this.path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS swing_strategy_journal_entries (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        recorded_at INTEGER NOT NULL,
        decision_id TEXT NOT NULL,
        strategy_id TEXT NOT NULL,
        strategy_version TEXT NOT NULL,
        strategy_repo_commit TEXT NOT NULL,
        strategy_config_hash TEXT NOT NULL,
        engine_version TEXT NOT NULL,
        engine_commit TEXT NOT NULL,
        market_data_snapshot_id TEXT NOT NULL,
        strategy_lifecycle TEXT NOT NULL,
        run_mode TEXT NOT NULL,
        decision_time INTEGER NOT NULL,
        symbol TEXT NOT NULL,
        change_kind TEXT NOT NULL,
        thesis_id TEXT NOT NULL,
        evidence_id TEXT,
        from_state TEXT,
        to_state TEXT,
        occurred_at INTEGER NOT NULL,
        reason_codes_json TEXT NOT NULL,
        feature_snapshot_json TEXT NOT NULL,
        context_json TEXT,
        location_json TEXT NOT NULL,
        thesis_json TEXT NOT NULL,
        evidence_json TEXT,
        execution_json TEXT,
        risk_json TEXT,
        result_json TEXT,
        shadow_action TEXT,
        CHECK (change_kind IN ('THESIS_STATE', 'EVIDENCE_APPENDED')),
        CHECK (
          (change_kind = 'THESIS_STATE' AND evidence_id IS NULL AND to_state IS NOT NULL)
          OR
          (change_kind = 'EVIDENCE_APPENDED' AND evidence_id IS NOT NULL AND from_state IS NULL AND to_state IS NULL)
        ),
        CHECK (
          (run_mode = 'shadow' AND strategy_lifecycle = 'shadow' AND shadow_action IN ('would_trigger', 'would_reject', 'would_exit'))
          OR
          (run_mode = 'production' AND strategy_lifecycle = 'production' AND shadow_action IS NULL)
        )
      ) STRICT;
      CREATE INDEX IF NOT EXISTS swing_strategy_journal_decision
        ON swing_strategy_journal_entries (decision_id, sequence);
      CREATE INDEX IF NOT EXISTS swing_strategy_journal_thesis
        ON swing_strategy_journal_entries (thesis_id, sequence);
      CREATE TRIGGER IF NOT EXISTS swing_strategy_journal_no_update
        BEFORE UPDATE ON swing_strategy_journal_entries
        BEGIN
          SELECT RAISE(ABORT, 'strategy journal is append-only');
        END;
      CREATE TRIGGER IF NOT EXISTS swing_strategy_journal_no_delete
        BEFORE DELETE ON swing_strategy_journal_entries
        BEGIN
          SELECT RAISE(ABORT, 'strategy journal is append-only');
        END;
    `)
    chmodSync(this.path, 0o600)
  }

  append(manifest: StrategyManifestIdentity, entry: SwingJournalWrite): StoredSwingJournalEntry {
    assertJournalWrite(manifest, entry)
    const recordedAt = Date.now()
    const thesisChange = entry.change.kind === 'THESIS_STATE' ? entry.change : null
    const evidenceChange = entry.change.kind === 'EVIDENCE_APPENDED' ? entry.change : null
    const result = this.db.prepare(`
      INSERT INTO swing_strategy_journal_entries (
        recorded_at, decision_id, strategy_id, strategy_version,
        strategy_repo_commit, strategy_config_hash, engine_version, engine_commit,
        market_data_snapshot_id, strategy_lifecycle, run_mode, decision_time,
        symbol, change_kind, thesis_id, evidence_id, from_state, to_state, occurred_at,
        reason_codes_json, feature_snapshot_json, context_json, location_json,
        thesis_json, evidence_json, execution_json, risk_json, result_json, shadow_action
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      recordedAt,
      entry.decisionId,
      entry.identity.strategyId,
      entry.identity.strategyVersion,
      entry.identity.strategyRepoCommit,
      entry.identity.strategyConfigHash,
      entry.engineVersion,
      entry.identity.engineCommit,
      entry.identity.marketDataSnapshotId,
      manifest.lifecycle,
      entry.runMode,
      entry.decisionTime,
      entry.symbol,
      entry.change.kind,
      entry.change.thesisId,
      evidenceChange?.evidenceId ?? null,
      thesisChange?.fromState ?? null,
      thesisChange?.toState ?? null,
      entry.change.occurredAt,
      json(entry.reasonCodes),
      json(entry.featureSnapshot),
      json(entry.context),
      json(entry.location),
      json(entry.thesis),
      json(entry.evidence),
      json(entry.execution),
      json(entry.risk),
      json(entry.result),
      entry.shadowAction ?? null,
    )

    return {
      ...entry,
      strategyLifecycle: manifest.lifecycle,
      sequence: Number(result.lastInsertRowid),
      recordedAt,
    }
  }

  readEntries(limit = 100): StoredSwingJournalEntry[] {
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 1_000))
    const rows = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM swing_strategy_journal_entries
        ORDER BY sequence DESC
        LIMIT ?
      ) ORDER BY sequence ASC
    `).all(safeLimit) as JournalRow[]
    return rows.map(toStoredEntry)
  }

  close() {
    this.db.close()
  }
}
