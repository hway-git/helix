import assert from 'node:assert/strict'
import test from 'node:test'
import type { Candle } from '@helix/contracts/market'
import type { StrategyDecisionIdentity } from '@helix/contracts/strategy'
import {
  assertStrategyHistoricalDataset,
  createStrategyHistoricalDataset,
} from './historical-dataset'
import { runHistoricalStrategy } from './historical-runner'

const minute = 60_000

function candles(count: number, duration: number): Candle[] {
  return Array.from({ length: count }, (_, index) => ({
    time: index * duration,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100.5 + index,
    volume: 10 + index,
  }))
}

function dataset() {
  return createStrategyHistoricalDataset({
    schemaVersion: 'helix.market-dataset/v1',
    source: { provider: 'fixture', market: 'test', instrumentId: 'BTC-TEST', symbol: 'BTC/USDT:USDT' },
    capturedThrough: 6 * minute,
    timeframes: {
      '1m': candles(6, minute),
      '5m': candles(1, 5 * minute),
    },
  })
}

function identity(snapshotId: string): StrategyDecisionIdentity {
  return {
    strategyId: 'helix_scalp_hunter',
    strategyVersion: '1.0.1',
    strategyRepoCommit: 'a'.repeat(40),
    strategyConfigHash: `sha256:${'b'.repeat(64)}`,
    engineCommit: 'c'.repeat(40),
    marketDataSnapshotId: snapshotId,
  }
}

test('creates a deterministic immutable market snapshot and rejects tampering', () => {
  const first = dataset()
  const second = dataset()
  assert.equal(first.datasetHash, second.datasetHash)
  assert.equal(Object.isFrozen(first.timeframes['1m']), true)

  const tampered = {
    ...structuredClone(first),
    timeframes: {
      ...structuredClone(first.timeframes),
      '1m': first.timeframes['1m']!.map((candle, index) => (
        index === 0 ? { ...candle, volume: candle.volume + 1 } : candle
      )),
    },
  }
  assert.throws(() => assertStrategyHistoricalDataset(tampered), /hash mismatch/)
})

test('exposes only candles closed by each decision time and assigns non-backdated signal timestamps', () => {
  const snapshot = dataset()
  const seenFiveMinuteCounts: number[] = []
  let checkedReadOnlyView = false
  const artifact = runHistoricalStrategy({
    dataset: snapshot,
    identity: identity(snapshot.datasetHash),
    strategyLifecycle: 'proposal',
    objectModel: 'PRICE_EVENT',
    baseTimeframe: '1m',
    requiredTimeframes: ['1m', '5m'],
    registeredReasonCodes: ['EXECUTION_TRIGGERED', 'TIME_STOP'],
    evaluate: (context) => {
      for (const [timeframe, series] of Object.entries(context.candles)) {
        const duration = timeframe === '1m' ? minute : 5 * minute
        assert.ok(series.every((candle) => candle.time + duration <= context.decisionTime))
        assert.equal(series[series.length], undefined)
        assert.equal(Object.keys(series).length, series.length)
        if (!checkedReadOnlyView && series.length) {
          assert.throws(() => (series as Candle[]).push(series[0]!), /read-only/)
          checkedReadOnlyView = true
        }
      }
      seenFiveMinuteCounts.push(context.candles['5m']!.length)
      if (context.decisionTime === 2 * minute) {
        return [{
          signalId: 'enter-1', decisionId: 'decision-1',
          object: { model: 'PRICE_EVENT', id: 'event-1' },
          action: 'ENTER', side: 'LONG', reasonCodes: ['EXECUTION_TRIGGERED'],
        }]
      }
      if (context.decisionTime === 6 * minute) {
        return [{
          signalId: 'exit-1', decisionId: 'decision-2',
          object: { model: 'PRICE_EVENT', id: 'event-1' },
          action: 'EXIT', side: 'LONG', reasonCodes: ['TIME_STOP'],
        }]
      }
      return []
    },
  })

  assert.deepEqual(seenFiveMinuteCounts, [0, 0, 0, 0, 1, 1])
  assert.deepEqual(artifact.signals.map((signal) => ({
    sequence: signal.sequence,
    sourceCandleOpenTime: signal.sourceCandleOpenTime,
    decisionTime: signal.decisionTime,
  })), [
    { sequence: 0, sourceCandleOpenTime: minute, decisionTime: 2 * minute },
    { sequence: 1, sourceCandleOpenTime: 5 * minute, decisionTime: 6 * minute },
  ])
})

test('requires Decision Identity to name the exact dataset snapshot', () => {
  const snapshot = dataset()
  assert.throws(() => runHistoricalStrategy({
    dataset: snapshot,
    identity: identity(`sha256:${'d'.repeat(64)}`),
    strategyLifecycle: 'proposal',
    objectModel: 'PRICE_EVENT',
    baseTimeframe: '1m',
    requiredTimeframes: ['1m'],
    registeredReasonCodes: ['EXECUTION_TRIGGERED'],
    evaluate: () => [],
  }), /marketDataSnapshotId must equal/)
})

test('rejects stale higher-timeframe tails and unregistered reason codes', () => {
  const late = createStrategyHistoricalDataset({
    schemaVersion: 'helix.market-dataset/v1',
    source: { provider: 'fixture', market: 'test', instrumentId: 'BTC-TEST', symbol: 'BTC/USDT:USDT' },
    capturedThrough: 10 * minute,
    timeframes: {
      '1m': candles(10, minute),
      '5m': candles(1, 5 * minute).map((candle) => ({ ...candle, time: 5 * minute })),
    },
  })
  assert.throws(() => runHistoricalStrategy({
    dataset: late,
    identity: identity(late.datasetHash),
    strategyLifecycle: 'proposal',
    objectModel: 'PRICE_EVENT',
    baseTimeframe: '1m',
    requiredTimeframes: ['1m', '5m'],
    registeredReasonCodes: ['EXECUTION_TRIGGERED'],
    evaluate: () => [],
  }), /timeframe 5m starts after/)

  const stale = createStrategyHistoricalDataset({
    schemaVersion: 'helix.market-dataset/v1',
    source: { provider: 'fixture', market: 'test', instrumentId: 'BTC-TEST', symbol: 'BTC/USDT:USDT' },
    capturedThrough: 11 * minute,
    timeframes: {
      '1m': candles(11, minute),
      '5m': candles(1, 5 * minute),
    },
  })
  assert.throws(() => runHistoricalStrategy({
    dataset: stale,
    identity: identity(stale.datasetHash),
    strategyLifecycle: 'proposal',
    objectModel: 'PRICE_EVENT',
    baseTimeframe: '1m',
    requiredTimeframes: ['1m', '5m'],
    registeredReasonCodes: ['EXECUTION_TRIGGERED'],
    evaluate: () => [],
  }), /timeframe 5m ends before/)

  const snapshot = dataset()
  assert.throws(() => runHistoricalStrategy({
    dataset: snapshot,
    identity: identity(snapshot.datasetHash),
    strategyLifecycle: 'proposal',
    objectModel: 'PRICE_EVENT',
    baseTimeframe: '1m',
    requiredTimeframes: ['1m', '5m'],
    registeredReasonCodes: ['EXECUTION_TRIGGERED'],
    evaluate: ({ decisionTime }) => decisionTime === minute ? [{
      signalId: 'bad-signal', decisionId: 'bad-decision',
      object: { model: 'PRICE_EVENT', id: 'event-1' },
      action: 'ENTER', side: 'LONG', reasonCodes: ['UNREGISTERED_REASON'],
    }] : [],
  }), /unregistered reason code UNREGISTERED_REASON/)
})
