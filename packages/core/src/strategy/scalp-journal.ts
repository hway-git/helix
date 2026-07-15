import { chmodSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  SCALP_EVENT_STATES,
  SCALP_RESPONSE_STATES,
  SCALP_SHADOW_ACTIONS,
  type ScalpJournalEntry,
  type ScalpPriceEventState,
  type ScalpResponseState,
  type StoredScalpJournalEntry,
} from '@helix/contracts/scalp'
import type { StrategyManifestIdentity } from '@helix/contracts/strategy'
import {
  assertScalpPriceEvent,
  assertScalpResponse,
  isScalpEventTransitionAllowed,
  isScalpResponseTransitionAllowed,
} from './scalp-state-machine'

const DEFAULT_DATABASE_PATH = resolve(homedir(), '.helix', 'helix.sqlite')

export type ScalpJournalWrite = Omit<ScalpJournalEntry, 'strategyLifecycle'>

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
  strategy_lifecycle: ScalpJournalEntry['strategyLifecycle']
  run_mode: ScalpJournalEntry['runMode']
  decision_time: number
  symbol: string
  object_kind: ScalpJournalEntry['transition']['objectKind']
  object_id: string
  from_state: ScalpJournalEntry['transition']['fromState']
  to_state: ScalpJournalEntry['transition']['toState']
  occurred_at: number
  reason_codes_json: string
  feature_snapshot_json: string
  regime_json: string | null
  zone_json: string
  event_json: string
  response_json: string | null
  execution_json: string | null
  risk_json: string | null
  result_json: string | null
  shadow_action: ScalpJournalEntry['shadowAction'] | null
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

function isEventState(value: ScalpJournalEntry['transition']['toState']): value is ScalpPriceEventState {
  return SCALP_EVENT_STATES.some((state) => state === value)
}

function isResponseState(value: ScalpJournalEntry['transition']['toState']): value is ScalpResponseState {
  return SCALP_RESPONSE_STATES.some((state) => state === value)
}

function assertManifestIdentity(manifest: StrategyManifestIdentity, entry: ScalpJournalWrite) {
  if (manifest.schemaVersion !== 'helix.strategy/v1'
    || manifest.id !== 'helix_scalp_hunter'
    || manifest.family !== 'scalp'
    || manifest.objectModel !== 'PRICE_EVENT'
    || !/^1\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error('journal requires the Scalp Hunter V1 manifest')
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

function assertJournalWrite(manifest: StrategyManifestIdentity, entry: ScalpJournalWrite) {
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
  timestamp(entry.transition.occurredAt, 'transition.occurredAt')
  nonEmptyText(entry.transition.objectId, 'transition.objectId')
  assertReasonCodes(entry.reasonCodes)
  assertScalpPriceEvent(entry.event)
  assertRegisteredReasonCodes(manifest, entry.reasonCodes, 'journal.reasonCodes')
  assertRegisteredReasonCodes(manifest, entry.event.reasonCodes, 'event.reasonCodes')
  if (entry.response) assertRegisteredReasonCodes(manifest, entry.response.reasonCodes, 'response.reasonCodes')
  if (entry.execution) assertRegisteredReasonCodes(manifest, entry.execution.reasonCodes, 'execution.reasonCodes')
  if (entry.risk) assertRegisteredReasonCodes(manifest, entry.risk.reasonCodes, 'risk.reasonCodes')

  if (entry.zone.id !== entry.event.zoneId) throw new Error('journal Zone does not match Event Zone')
  if (entry.symbol !== entry.event.symbol || entry.symbol !== entry.zone.symbol) {
    throw new Error('journal symbol must match Event and Zone symbols')
  }
  if (entry.regime && entry.regime.id !== entry.event.regimeId) {
    throw new Error('journal Regime does not match Event Regime')
  }

  if (entry.transition.objectKind === 'PRICE_EVENT') {
    if (entry.transition.objectId !== entry.event.id || entry.transition.toState !== entry.event.state) {
      throw new Error('PRICE_EVENT transition must match the current Event')
    }
    if (entry.transition.occurredAt !== entry.event.updatedAt) {
      throw new Error('PRICE_EVENT transition time must match the current Event')
    }
    if (entry.transition.fromState == null) {
      if (entry.transition.toState !== 'DETECTED' || entry.transition.occurredAt !== entry.event.detectedAt) {
        throw new Error('new PRICE_EVENT journals must begin at DETECTED')
      }
    } else if (!isEventState(entry.transition.fromState)
      || !isEventState(entry.transition.toState)
      || !isScalpEventTransitionAllowed(entry.transition.fromState, entry.transition.toState)) {
      throw new Error(`illegal journal Event transition ${entry.transition.fromState} -> ${entry.transition.toState}`)
    }
  } else {
    if (!entry.response
      || entry.transition.objectId !== entry.response.eventId
      || entry.transition.toState !== entry.response.state) {
      throw new Error('RESPONSE transition must match the current Response')
    }
    assertScalpResponse(entry.response)
    if (entry.transition.occurredAt !== entry.response.updatedAt) {
      throw new Error('RESPONSE transition time must match the current Response')
    }
    if (entry.transition.fromState == null) {
      if (entry.transition.toState !== 'EXPECTED_RESPONSE_WINDOW') {
        throw new Error('new RESPONSE journals must begin at EXPECTED_RESPONSE_WINDOW')
      }
    } else if (!isResponseState(entry.transition.fromState)
      || !isResponseState(entry.transition.toState)
      || !isScalpResponseTransitionAllowed(entry.transition.fromState, entry.transition.toState)) {
      throw new Error(`illegal journal Response transition ${entry.transition.fromState} -> ${entry.transition.toState}`)
    }
  }

  if (entry.runMode === 'shadow') {
    if (!entry.shadowAction || !SCALP_SHADOW_ACTIONS.includes(entry.shadowAction)) {
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

function toStoredEntry(row: JournalRow): StoredScalpJournalEntry {
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
    transition: {
      objectKind: row.object_kind,
      objectId: row.object_id,
      fromState: row.from_state,
      toState: row.to_state,
      occurredAt: row.occurred_at,
    },
    reasonCodes: parseJson(row.reason_codes_json),
    featureSnapshot: parseJson(row.feature_snapshot_json),
    regime: parseOptionalJson(row.regime_json),
    zone: parseJson(row.zone_json),
    event: parseJson(row.event_json),
    response: parseOptionalJson(row.response_json),
    execution: parseOptionalJson(row.execution_json),
    risk: parseOptionalJson(row.risk_json),
    result: parseOptionalJson(row.result_json),
    shadowAction: row.shadow_action ?? undefined,
  }
}

export class ScalpStrategyJournal {
  readonly path: string
  private readonly db: DatabaseSync

  constructor(databasePath = process.env.HELIX_DATABASE_PATH || DEFAULT_DATABASE_PATH) {
    this.path = resolve(databasePath)
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(this.path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS strategy_journal_entries (
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
        object_kind TEXT NOT NULL,
        object_id TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        reason_codes_json TEXT NOT NULL,
        feature_snapshot_json TEXT NOT NULL,
        regime_json TEXT,
        zone_json TEXT NOT NULL,
        event_json TEXT NOT NULL,
        response_json TEXT,
        execution_json TEXT,
        risk_json TEXT,
        result_json TEXT,
        shadow_action TEXT,
        CHECK (run_mode IN ('shadow', 'production')),
        CHECK (
          (run_mode = 'shadow' AND strategy_lifecycle = 'shadow' AND shadow_action IN ('would_trigger', 'would_reject', 'would_exit'))
          OR
          (run_mode = 'production' AND strategy_lifecycle = 'production' AND shadow_action IS NULL)
        )
      ) STRICT;
      CREATE INDEX IF NOT EXISTS strategy_journal_decision
        ON strategy_journal_entries (decision_id, sequence);
      CREATE INDEX IF NOT EXISTS strategy_journal_object
        ON strategy_journal_entries (object_kind, object_id, sequence);
      CREATE TRIGGER IF NOT EXISTS strategy_journal_no_update
        BEFORE UPDATE ON strategy_journal_entries
        BEGIN
          SELECT RAISE(ABORT, 'strategy journal is append-only');
        END;
      CREATE TRIGGER IF NOT EXISTS strategy_journal_no_delete
        BEFORE DELETE ON strategy_journal_entries
        BEGIN
          SELECT RAISE(ABORT, 'strategy journal is append-only');
        END;
    `)
    chmodSync(this.path, 0o600)
  }

  append(manifest: StrategyManifestIdentity, entry: ScalpJournalWrite): StoredScalpJournalEntry {
    assertJournalWrite(manifest, entry)
    const recordedAt = Date.now()
    const result = this.db.prepare(`
      INSERT INTO strategy_journal_entries (
        recorded_at, decision_id, strategy_id, strategy_version,
        strategy_repo_commit, strategy_config_hash, engine_version, engine_commit,
        market_data_snapshot_id, strategy_lifecycle, run_mode, decision_time,
        symbol, object_kind, object_id, from_state, to_state, occurred_at,
        reason_codes_json, feature_snapshot_json, regime_json, zone_json,
        event_json, response_json, execution_json, risk_json, result_json, shadow_action
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      entry.transition.objectKind,
      entry.transition.objectId,
      entry.transition.fromState,
      entry.transition.toState,
      entry.transition.occurredAt,
      json(entry.reasonCodes),
      json(entry.featureSnapshot),
      json(entry.regime),
      json(entry.zone),
      json(entry.event),
      json(entry.response),
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

  readEntries(limit = 100): StoredScalpJournalEntry[] {
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 1_000))
    const rows = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM strategy_journal_entries
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
