import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import type { StrategyManifestIdentity } from '@helix/contracts/strategy'
import { SwingStrategyJournal, type SwingJournalWrite } from './swing-journal'
import { appendSwingShadowDecision } from './swing-shadow'
import {
  appendSwingEvidence,
  createSwingTradeThesis,
  transitionSwingTradeThesis,
} from './swing-state-machine'

const configHash = `sha256:${'d'.repeat(64)}`

function manifest(lifecycle: StrategyManifestIdentity['lifecycle']): StrategyManifestIdentity {
  return {
    schemaVersion: 'helix.strategy/v1',
    id: 'helix_swing_hunter',
    name: 'Helix Swing Hunter',
    family: 'swing',
    version: '1.0.0',
    lifecycle,
    objectModel: 'TRADE_THESIS',
    timeframes: [{ role: 'execution', timeframe: '15m' }],
    manifestPath: 'strategies/swing/strategy.yaml',
    configHash,
    requiredEngineCapabilities: [
      'daily_market_context_v1',
      'swing_location_v1',
      'trade_thesis_v1',
      'evidence_accumulation_v1',
      'staged_execution_v1',
      'swing_thesis_lifecycle_v1',
      'swing_risk_budget_v1',
      'thesis_invalidation_v1',
    ],
    capabilityConfigurations: {},
    reasonCodes: [
      'CONTEXT_ALIGNED',
      'LOCATION_ALIGNED',
      'EVIDENCE_STRENGTHENED',
      'EXECUTION_TRIGGERED',
    ],
  }
}

function activeThesis() {
  const candidate = createSwingTradeThesis({
    id: 'BTC-4H-THESIS-001',
    symbol: 'BTC-USDT-SWAP',
    type: 'TREND_CONTINUATION',
    direction: 'SHORT',
    contextId: 'BTC-CONTEXT-001',
    locationId: 'BTC-LOCATION-001',
    score: 60,
    invalidation: {
      policyId: 'thesis_invalidation_v1',
      type: 'H4_CLOSE_ABOVE_LEVEL',
      timeframe: '4h',
      level: 62_650,
    },
    expectedMove: { targetLocationId: 'BTC-TARGET-001', target: 60_500 },
    createdAt: 1_000,
    expiresAt: 5_000,
    reasonCodes: ['LOCATION_ALIGNED'],
  })
  return transitionSwingTradeThesis(candidate, {
    toState: 'ACTIVE',
    occurredAt: 1_500,
    reasonCodes: ['CONTEXT_ALIGNED'],
  }).thesis
}

function evidence() {
  return {
    id: 'evidence-001',
    thesisId: 'BTC-4H-THESIS-001',
    type: 'STRUCTURE_EVIDENCE',
    time: 2_000,
    direction: 'SHORT' as const,
    effect: 'SUPPORTING' as const,
    scoreDelta: 10,
    reasonCodes: ['EVIDENCE_STRENGTHENED'],
    featureSnapshot: { structure_score: 0.72 },
  }
}

function journalWrite(): Omit<SwingJournalWrite, 'runMode' | 'shadowAction'> {
  const latestEvidence = evidence()
  const thesis = appendSwingEvidence(activeThesis(), latestEvidence)
  return {
    decisionId: 'decision-001',
    identity: {
      strategyId: 'helix_swing_hunter',
      strategyVersion: '1.0.0',
      strategyRepoCommit: 'e'.repeat(40),
      strategyConfigHash: configHash,
      engineCommit: 'f'.repeat(40),
      marketDataSnapshotId: 'snapshot-001',
    },
    engineVersion: '0.1.0',
    decisionTime: latestEvidence.time,
    symbol: thesis.symbol,
    change: {
      kind: 'EVIDENCE_APPENDED',
      thesisId: thesis.id,
      evidenceId: latestEvidence.id,
      occurredAt: latestEvidence.time,
    },
    reasonCodes: latestEvidence.reasonCodes,
    featureSnapshot: latestEvidence.featureSnapshot,
    context: {
      id: thesis.contextId,
      symbol: thesis.symbol,
      daily: 'BEARISH',
      h4: 'RESISTANCE_RETEST',
      reasonCodes: ['CONTEXT_ALIGNED'],
      observedAt: 1_000,
    },
    location: {
      id: thesis.locationId,
      symbol: thesis.symbol,
      type: 'RESISTANCE_ZONE',
      score: 82,
      boundaries: { lower: 61_800, upper: 62_300 },
      reasonCodes: ['LOCATION_ALIGNED'],
    },
    thesis,
    evidence: latestEvidence,
  }
}

test('persists ordered Swing Evidence as an append-only shadow decision', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'helix-swing-journal-'))
  const journal = new SwingStrategyJournal(resolve(root, 'helix.sqlite'))

  try {
    const stored = appendSwingShadowDecision(journal, manifest('shadow'), {
      ...journalWrite(),
      action: 'would_trigger',
    })
    const entries = journal.readEntries()

    assert.equal(stored.sequence, 1)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].strategyLifecycle, 'shadow')
    assert.equal(entries[0].change.kind, 'EVIDENCE_APPENDED')
    assert.equal(entries[0].evidence?.id, 'evidence-001')
    assert.deepEqual(entries[0].thesis.evidence.map((item) => item.id), ['evidence-001'])
    assert.equal(entries[0].thesis.score, 70)
    assert.equal(entries[0].shadowAction, 'would_trigger')
  } finally {
    journal.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('enforces append-only Swing storage at the SQLite boundary', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'helix-swing-journal-'))
  const path = resolve(root, 'helix.sqlite')
  const journal = new SwingStrategyJournal(path)

  try {
    appendSwingShadowDecision(journal, manifest('shadow'), {
      ...journalWrite(),
      action: 'would_reject',
    })
    journal.close()

    const db = new DatabaseSync(path)
    try {
      assert.throws(
        () => db.prepare('UPDATE swing_strategy_journal_entries SET symbol = ? WHERE sequence = 1').run('ETH-USDT-SWAP'),
        /strategy journal is append-only/,
      )
      assert.throws(
        () => db.prepare('DELETE FROM swing_strategy_journal_entries WHERE sequence = 1').run(),
        /strategy journal is append-only/,
      )
    } finally {
      db.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects Swing proposal lifecycle in both shadow and production modes', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'helix-swing-journal-'))
  const journal = new SwingStrategyJournal(resolve(root, 'helix.sqlite'))

  try {
    assert.throws(
      () => appendSwingShadowDecision(journal, manifest('proposal'), {
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

test('rejects a Swing journal change that bypasses the Thesis state machine', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'helix-swing-journal-'))
  const journal = new SwingStrategyJournal(resolve(root, 'helix.sqlite'))

  try {
    const write = journalWrite()
    const triggered = {
      ...write.thesis,
      state: 'TRIGGERED' as const,
      updatedAt: 2_500,
      reasonCodes: ['EXECUTION_TRIGGERED'],
    }
    assert.throws(
      () => appendSwingShadowDecision(journal, manifest('shadow'), {
        ...write,
        thesis: triggered,
        evidence: undefined,
        change: {
          kind: 'THESIS_STATE',
          thesisId: triggered.id,
          fromState: 'ACTIVE',
          toState: 'TRIGGERED',
          occurredAt: triggered.updatedAt,
        },
        action: 'would_trigger',
      }),
      /illegal journal Thesis transition ACTIVE -> TRIGGERED/,
    )
  } finally {
    journal.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects Swing reason codes not registered by the pinned manifest', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'helix-swing-journal-'))
  const journal = new SwingStrategyJournal(resolve(root, 'helix.sqlite'))

  try {
    const write = journalWrite()
    assert.throws(
      () => appendSwingShadowDecision(journal, manifest('shadow'), {
        ...write,
        reasonCodes: ['UNREGISTERED_REASON'],
        action: 'would_reject',
      }),
      /contains unregistered reason codes: UNREGISTERED_REASON/,
    )
  } finally {
    journal.close()
    rmSync(root, { recursive: true, force: true })
  }
})
