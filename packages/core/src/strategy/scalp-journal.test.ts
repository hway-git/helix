import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import type { StrategyManifestIdentity } from '@helix/contracts/strategy'
import { ScalpStrategyJournal, type ScalpJournalWrite } from './scalp-journal'
import { appendScalpShadowDecision } from './scalp-shadow'
import { createScalpPriceEvent } from './scalp-state-machine'

const configHash = `sha256:${'a'.repeat(64)}`

function manifest(lifecycle: StrategyManifestIdentity['lifecycle']): StrategyManifestIdentity {
  return {
    schemaVersion: 'helix.strategy/v1',
    id: 'helix_scalp_hunter',
    name: 'Helix Scalp Hunter',
    family: 'scalp',
    version: '1.0.0',
    lifecycle,
    objectModel: 'PRICE_EVENT',
    timeframes: [{ role: 'execution', timeframe: '1m' }],
    manifestPath: 'strategies/scalp/strategy.yaml',
    configHash,
    requiredEngineCapabilities: [
      'market_regime_v1',
      'hunting_zone_v1',
      'liquidity_sweep_v1',
      'breakout_failure_v1',
      'momentum_burst_v1',
      'micro_structure_execution_v1',
      'immediate_response_v1',
      'scalp_event_lifecycle_v1',
      'scalp_risk_budget_v1',
      'scalp_time_stop_v1',
    ],
    capabilityConfigurations: {},
    reasonCodes: [
      'LIQUIDITY_SWEEP_DETECTED',
      'TARGET_HIT',
    ],
  }
}

function journalWrite(): Omit<ScalpJournalWrite, 'runMode' | 'shadowAction'> {
  const event = createScalpPriceEvent({
    id: 'BTC-5M-EVENT-001',
    symbol: 'BTC-USDT-SWAP',
    regimeId: 'BTC-1H-REGIME-001',
    zoneId: 'BTC-15M-ZONE-001',
    detectorId: 'liquidity_sweep_v1',
    type: 'LIQUIDITY_SWEEP',
    direction: 'LONG',
    score: 82,
    detectedAt: 1_000,
    expiresAt: 2_000,
    reasonCodes: ['LIQUIDITY_SWEEP_DETECTED'],
  })

  return {
    decisionId: 'decision-001',
    identity: {
      strategyId: 'helix_scalp_hunter',
      strategyVersion: '1.0.0',
      strategyRepoCommit: 'b'.repeat(40),
      strategyConfigHash: configHash,
      engineCommit: 'c'.repeat(40),
      marketDataSnapshotId: 'snapshot-001',
    },
    engineVersion: '0.1.0',
    decisionTime: 1_000,
    symbol: 'BTC-USDT-SWAP',
    transition: {
      objectKind: 'PRICE_EVENT',
      objectId: event.id,
      fromState: null,
      toState: event.state,
      occurredAt: event.updatedAt,
    },
    reasonCodes: event.reasonCodes,
    featureSnapshot: {
      breach_atr: 0.42,
      reclaim_bars: 1,
    },
    regime: {
      id: event.regimeId,
      symbol: event.symbol,
      type: 'RANGING',
      score: 76,
      observedAt: 900,
    },
    zone: {
      id: event.zoneId,
      symbol: event.symbol,
      type: 'RANGE_LOW',
      state: 'ACTIVE',
      score: 84,
      testCount: 1,
      directionInterest: 'LONG',
      boundary: { lower: 61_180, upper: 61_300 },
      detectedAt: 800,
    },
    event,
  }
}

test('persists complete shadow decisions and reads them in append order', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'helix-scalp-journal-'))
  const path = resolve(root, 'helix.sqlite')
  const journal = new ScalpStrategyJournal(path)

  try {
    const stored = appendScalpShadowDecision(journal, manifest('shadow'), {
      ...journalWrite(),
      action: 'would_reject',
    })
    const entries = journal.readEntries()

    assert.equal(stored.sequence, 1)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].strategyLifecycle, 'shadow')
    assert.equal(entries[0].runMode, 'shadow')
    assert.equal(entries[0].shadowAction, 'would_reject')
    assert.equal(entries[0].identity.strategyVersion, '1.0.0')
    assert.deepEqual(entries[0].featureSnapshot, { breach_atr: 0.42, reclaim_bars: 1 })
    assert.equal(entries[0].zone.id, 'BTC-15M-ZONE-001')
    assert.equal(entries[0].event.state, 'DETECTED')
  } finally {
    journal.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('enforces append-only storage at the SQLite boundary', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'helix-scalp-journal-'))
  const path = resolve(root, 'helix.sqlite')
  const journal = new ScalpStrategyJournal(path)

  try {
    appendScalpShadowDecision(journal, manifest('shadow'), {
      ...journalWrite(),
      action: 'would_trigger',
    })
    journal.close()

    const db = new DatabaseSync(path)
    try {
      assert.throws(
        () => db.prepare('UPDATE strategy_journal_entries SET symbol = ? WHERE sequence = 1').run('ETH-USDT-SWAP'),
        /strategy journal is append-only/,
      )
      assert.throws(
        () => db.prepare('DELETE FROM strategy_journal_entries WHERE sequence = 1').run(),
        /strategy journal is append-only/,
      )
    } finally {
      db.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects proposal lifecycle in both shadow and production modes', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'helix-scalp-journal-'))
  const journal = new ScalpStrategyJournal(resolve(root, 'helix.sqlite'))

  try {
    assert.throws(
      () => appendScalpShadowDecision(journal, manifest('proposal'), {
        ...journalWrite(),
        action: 'would_trigger',
      }),
      /strategy lifecycle proposal cannot run in shadow mode/,
    )
    assert.throws(
      () => journal.append(manifest('proposal'), {
        ...journalWrite(),
        runMode: 'production',
      }),
      /strategy lifecycle proposal cannot run in production mode/,
    )
    assert.equal(journal.readEntries().length, 0)
  } finally {
    journal.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects a shadow action outside the would_* contract', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'helix-scalp-journal-'))
  const journal = new ScalpStrategyJournal(resolve(root, 'helix.sqlite'))

  try {
    assert.throws(
      () => appendScalpShadowDecision(journal, manifest('shadow'), {
        ...journalWrite(),
        action: 'trigger' as 'would_trigger',
      }),
      /require a would_\* action/,
    )
  } finally {
    journal.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects a journal transition that bypasses the Scalp state machine', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'helix-scalp-journal-'))
  const journal = new ScalpStrategyJournal(resolve(root, 'helix.sqlite'))

  try {
    const write = journalWrite()
    const closedEvent = {
      ...write.event,
      state: 'CLOSED' as const,
      updatedAt: 1_100,
      reasonCodes: ['TARGET_HIT'],
    }
    assert.throws(
      () => appendScalpShadowDecision(journal, manifest('shadow'), {
        ...write,
        event: closedEvent,
        transition: {
          objectKind: 'PRICE_EVENT',
          objectId: closedEvent.id,
          fromState: 'DETECTED',
          toState: 'CLOSED',
          occurredAt: closedEvent.updatedAt,
        },
        action: 'would_exit',
      }),
      /illegal journal Event transition DETECTED -> CLOSED/,
    )
  } finally {
    journal.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects Scalp reason codes not registered by the pinned manifest', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'helix-scalp-journal-'))
  const journal = new ScalpStrategyJournal(resolve(root, 'helix.sqlite'))

  try {
    const write = journalWrite()
    assert.throws(
      () => appendScalpShadowDecision(journal, manifest('shadow'), {
        ...write,
        reasonCodes: ['UNREGISTERED_REASON'],
        event: { ...write.event, reasonCodes: ['UNREGISTERED_REASON'] },
        action: 'would_reject',
      }),
      /contains unregistered reason codes: UNREGISTERED_REASON/,
    )
  } finally {
    journal.close()
    rmSync(root, { recursive: true, force: true })
  }
})
