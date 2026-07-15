import assert from 'node:assert/strict'
import test from 'node:test'
import type { StrategySignalArtifactPayload } from '@helix/contracts/strategy'
import {
  assertStrategySignalArtifact,
  createStrategySignalArtifact,
  strategySignalArtifactHash,
} from './signal-artifact'

const minute = 60_000

function payload(): StrategySignalArtifactPayload {
  return {
    schemaVersion: 'helix.signal-artifact/v1',
    identity: {
      strategyId: 'helix_scalp_hunter',
      strategyVersion: '1.0.1',
      strategyRepoCommit: 'a'.repeat(40),
      strategyConfigHash: `sha256:${'b'.repeat(64)}`,
      engineCommit: 'c'.repeat(40),
      marketDataSnapshotId: 'okx-btc-2026-07-01',
    },
    strategyLifecycle: 'proposal',
    objectModel: 'PRICE_EVENT',
    symbol: 'BTC/USDT:USDT',
    baseTimeframe: '1m',
    marketData: {
      firstCandleOpenTime: 1_782_864_000_000,
      lastCandleCloseTime: 1_782_864_000_000 + 3 * minute,
    },
    signals: [
      {
        sequence: 0,
        signalId: 'btc-scalp-001',
        decisionId: 'decision-001',
        object: { model: 'PRICE_EVENT', id: 'event-001' },
        action: 'ENTER',
        side: 'LONG',
        sourceCandleOpenTime: 1_782_864_000_000,
        decisionTime: 1_782_864_000_000 + minute,
        reasonCodes: ['EXECUTION_TRIGGERED'],
      },
      {
        sequence: 1,
        signalId: 'btc-scalp-002',
        decisionId: 'decision-002',
        object: { model: 'PRICE_EVENT', id: 'event-001' },
        action: 'EXIT',
        side: 'LONG',
        sourceCandleOpenTime: 1_782_864_000_000 + 2 * minute,
        decisionTime: 1_782_864_000_000 + 3 * minute,
        reasonCodes: ['TIME_STOP'],
      },
    ],
  }
}

test('creates a frozen, deterministic artifact bound to decision identity and market data', () => {
  const artifact = createStrategySignalArtifact(payload())

  assert.match(artifact.artifactHash, /^sha256:[a-f0-9]{64}$/)
  assert.equal(artifact.artifactHash, strategySignalArtifactHash(payload()))
  assert.equal(assertStrategySignalArtifact(structuredClone(artifact)).artifactHash, artifact.artifactHash)
  assert.equal(Object.isFrozen(artifact), true)
  assert.equal(Object.isFrozen(artifact.signals), true)
  assert.equal(Object.isFrozen(artifact.signals[0]), true)
})

test('rejects artifact tampering', () => {
  const artifact = structuredClone(createStrategySignalArtifact(payload()))
  const tampered = {
    ...artifact,
    signals: artifact.signals.map((signal, index) => index === 0
      ? { ...signal, reasonCodes: ['CHANGED_EXECUTION_REASON'] }
      : signal),
  }

  assert.throws(() => assertStrategySignalArtifact(tampered), /hash mismatch/)
})

test('rejects backdated decisions and signals outside the immutable market window', () => {
  const original = payload()
  const backdated = {
    ...original,
    signals: original.signals.map((signal, index) => index === 0 ? {
      ...signal,
      decisionTime: signal.sourceCandleOpenTime,
    } : signal),
  }
  assert.throws(() => createStrategySignalArtifact(backdated), /source candle close time/)

  const outside = {
    ...original,
    signals: original.signals.map((signal, index) => index === 1 ? {
      ...signal,
      sourceCandleOpenTime: original.marketData.lastCandleCloseTime,
      decisionTime: original.marketData.lastCandleCloseTime + minute,
    } : signal),
  }
  assert.throws(() => createStrategySignalArtifact(outside), /outside the marketData window/)
})

test('rejects unordered or ambiguous executable signals', () => {
  const original = payload()
  const unordered = {
    ...original,
    signals: original.signals.map((signal, index) => index === 1 ? {
      ...signal,
      sourceCandleOpenTime: original.signals[0]!.sourceCandleOpenTime - minute,
      decisionTime: original.signals[0]!.decisionTime - minute,
    } : signal),
  }
  assert.throws(() => createStrategySignalArtifact(unordered), /ordered by decisionTime/)

  const duplicate = {
    ...original,
    signals: original.signals.map((signal, index) => index === 1 ? {
      ...signal,
      signalId: 'another-id',
      decisionId: 'another-decision',
      action: 'ENTER' as const,
      sourceCandleOpenTime: original.signals[0]!.sourceCandleOpenTime,
      decisionTime: original.signals[0]!.decisionTime,
    } : signal),
  }
  assert.throws(() => createStrategySignalArtifact(duplicate), /multiple signals at decisionTime/)
})

test('requires object-level ENTER and EXIT ordering with a stable side', () => {
  const original = payload()
  const exitOnly = {
    ...original,
    signals: [{ ...original.signals[1]!, sequence: 0 }],
  }
  assert.throws(() => createStrategySignalArtifact(exitOnly), /EXIT for object event-001 has no matching ENTER/)

  const mismatchedSide = {
    ...original,
    signals: original.signals.map((signal, index) => index === 1
      ? { ...signal, side: 'SHORT' as const }
      : signal),
  }
  assert.throws(() => createStrategySignalArtifact(mismatchedSide), /EXIT side for object event-001 does not match/)
})

test('rejects overlapping positions and conflicting decisions on one candle', () => {
  const original = payload()
  const overlapping = {
    ...original,
    signals: original.signals.map((signal, index) => index === 1 ? {
      ...signal,
      object: { model: 'PRICE_EVENT' as const, id: 'event-002' },
      action: 'ENTER' as const,
      side: 'SHORT' as const,
    } : signal),
  }
  assert.throws(() => createStrategySignalArtifact(overlapping), /overlaps open position for object event-001/)

  const conflicting = {
    ...overlapping,
    signals: overlapping.signals.map((signal, index) => index === 1 ? {
      ...signal,
      sourceCandleOpenTime: original.signals[0]!.sourceCandleOpenTime,
      decisionTime: original.signals[0]!.decisionTime,
    } : signal),
  }
  assert.throws(() => createStrategySignalArtifact(conflicting), /multiple signals at decisionTime/)
})
