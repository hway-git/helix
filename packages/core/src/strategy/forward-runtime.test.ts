import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Candle } from '@helix/contracts/market'
import type { StrategyRepositorySnapshot } from '@helix/contracts/strategy'
import { createStrategyHistoricalDataset } from './historical-dataset'
import {
  assertStrategyForwardDeployment,
  assertStrategyForwardDataset,
  createStrategyForwardDeployment,
  requireCurrentStrategyForwardDeployment,
  STRATEGY_FORWARD_DECISION_STATE_SCHEMA_VERSION,
  strategyForwardDecisionStateHash,
  strategyForwardFirstDecisionTime,
} from './forward-runtime'
import { mergeStrategyForwardDatasets, StrategyForwardSession } from './forward-session'
import {
  assertStrategyForwardCheckpoint,
  compactStrategyForwardDataset,
  STRATEGY_FORWARD_NO_SIGNAL_CAPACITY,
} from './forward-session'
import { runStrategyForwardWorkerLoop, StrategyForwardWorker } from './forward-worker'

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

function signalCandles(count: number): Candle[] {
  const closes = Array.from({ length: count }, (_, index) => (
    100
      + Math.sin(index / 45) * 5
      + Math.sin(index / 6) * 0.35
      + (index > 24 * 60 && index % 180 === 5 ? 3 : 0)
      - (index > 24 * 60 && index % 180 === 6 ? 3 : 0)
  ))
  return closes.map((close, index) => {
    const open = index === 0 ? close : closes[index - 1]!
    const sweep = index > 24 * 60 && index % 180 === 0 ? 2 : 0
    return {
      time: index * minute,
      open,
      high: Math.max(open, close) + 0.08 + sweep,
      low: Math.min(open, close) - 0.08 - sweep,
      close,
      volume: 100,
    }
  })
}

function aggregate(source: Candle[], bars: number): Candle[] {
  const output: Candle[] = []
  for (let index = 0; index + bars <= source.length; index += bars) {
    const group = source.slice(index, index + bars)
    output.push({
      time: group[0]!.time,
      open: group[0]!.open,
      high: Math.max(...group.map((candle) => candle.high)),
      low: Math.min(...group.map((candle) => candle.low)),
      close: group.at(-1)!.close,
      volume: group.reduce((sum, candle) => sum + candle.volume, 0),
    })
  }
  return output
}

function snapshot(): StrategyRepositorySnapshot {
  const configHash = `sha256:${'b'.repeat(64)}`
  const capabilityConfigurations = {
    market_regime_v1: {
      fast_window_bars: 10, slow_window_bars: 50, ema_period: 20, swing_left_bars: 2, swing_right_bars: 2,
      trend_min_efficiency: 0.3, trend_min_ema_slope_atr: 0.5, compression_max_atr_ratio: 0.7,
      compression_max_range_ratio: 0.7, compression_min_overlap_ratio: 0.8, expansion_min_atr_ratio: 2,
      expansion_min_body_ratio: 0.9, expansion_min_efficiency: 0.9, exhaustion_min_directional_bars: 10,
      exhaustion_min_mean_distance_atr: 10, exhaustion_max_last_range_ratio: 0.2,
      chaotic_min_alternation_ratio: 1, chaotic_min_wick_ratio: 1, chaotic_max_efficiency: 0,
    },
    hunting_zone_v1: {
      atr_period: 14, lookback_bars: 96, range_lookback_bars: 48, compression_lookback_bars: 12,
      swing_left_bars: 2, swing_right_bars: 2, zone_half_width_atr: 0.2, touch_tolerance_atr: 0.3,
      reaction_distance_atr: 0.2, reaction_bars: 3, compression_max_range_ratio: 0.8,
      max_test_count: 20, max_age_bars: 80, min_zone_score: 40,
    },
    liquidity_sweep_v1: {
      min_zone_score: 40, max_reclaim_bars: 2, min_wick_ratio: 0, max_follow_through_atr: 1,
    },
    breakout_failure_v1: { min_zone_score: 40, max_return_bars: 3, max_follow_through_atr: 1 },
    momentum_burst_v1: {
      min_zone_score: 40, min_body_ratio: 0.2, min_candle_range_atr: 0.5, max_distance_from_mean_atr: 10,
    },
    micro_structure_execution_v1: { min_rr: 1 },
    scalp_risk_budget_v1: {
      daily_loss_limit_r: 10, max_consecutive_losses: 20,
      risk_by_grade_r: { A_PLUS: 0.35, A: 0.25, B: 0.15 },
    },
    scalp_time_stop_v1: {
      max_holding_ms: { LIQUIDITY_SWEEP: 30 * minute, BREAKOUT_FAILURE: 30 * minute, MOMENTUM_BURST: 15 * minute },
      response_window_ms: { LIQUIDITY_SWEEP: 10 * minute, BREAKOUT_FAILURE: 10 * minute, MOMENTUM_BURST: 5 * minute },
    },
  }
  return {
    ok: true,
    source: 'local-git',
    repository: { commit: 'a'.repeat(40), dirty: false },
    engine: { commit: 'c'.repeat(40), dirty: false },
    engineCapabilities: [],
    manifests: [{
      schemaVersion: 'helix.strategy/v1',
      id: 'helix_scalp_hunter',
      name: 'Helix Scalp Hunter',
      family: 'scalp',
      version: '1.0.1',
      lifecycle: 'shadow',
      objectModel: 'PRICE_EVENT',
      timeframes: [
        { role: 'regime', timeframe: '1h' },
        { role: 'hunting_zone', timeframe: '15m' },
        { role: 'price_event', timeframe: '5m' },
        { role: 'execution', timeframe: '1m' },
      ],
      manifestPath: 'strategies/scalp/strategy.yaml',
      configHash,
      requiredEngineCapabilities: Object.keys(capabilityConfigurations),
      capabilityConfigurations,
      reasonCodes: [
        'EXECUTION_TRIGGERED', 'STOP_HIT', 'TARGET_HIT', 'TIME_STOP', 'RESPONSE_FAILURE_EXIT',
      ],
    }],
    compatibility: [{
      strategyId: 'helix_scalp_hunter', engineCommit: 'c'.repeat(40), compatible: true,
      required: [], available: [], missing: [], unconfigured: [], invalidConfiguration: [],
    }],
    fetchedAt: 0,
    errors: [],
  }
}

test('forward deployment is immutable and pins the clean strategy and Engine identity', () => {
  const deployment = createStrategyForwardDeployment(snapshot(), {
    strategyId: 'helix_scalp_hunter',
    instrumentId: 'BTC-USDT-SWAP',
    symbol: 'BTC/USDT:USDT',
    activatedAt: 90_000,
    deploymentId: 'forward-test',
    walkForwardReportHash: `sha256:${'d'.repeat(64)}`,
  })
  assert.equal(assertStrategyForwardDeployment(structuredClone(deployment)).deploymentHash, deployment.deploymentHash)
  assert.equal(deployment.strategy.repoCommit, 'a'.repeat(40))
  assert.equal(deployment.strategy.engineCommit, 'c'.repeat(40))
  assert.equal(deployment.walkForwardReportHash, `sha256:${'d'.repeat(64)}`)

  const tampered = { ...structuredClone(deployment), activatedAt: deployment.activatedAt + minute }
  assert.throws(() => assertStrategyForwardDeployment(tampered), /hash mismatch/)
})

test('forward deployment starts strictly after activation and accepts its exact market source', () => {
  const repository = snapshot()
  const deployment = createStrategyForwardDeployment(repository, {
    strategyId: 'helix_scalp_hunter',
    instrumentId: 'BTC-USDT-SWAP',
    symbol: 'BTC/USDT:USDT',
    activatedAt: 90_000,
    deploymentId: 'forward-test',
  })
  const dataset = createStrategyHistoricalDataset({
    schemaVersion: 'helix.market-dataset/v1',
    source: { provider: 'okx', market: 'futures', instrumentId: 'BTC-USDT-SWAP', symbol: 'BTC/USDT:USDT' },
    capturedThrough: 2 * 60 * minute,
    timeframes: {
      '1m': candles(120, minute),
      '5m': candles(24, 5 * minute),
      '15m': candles(8, 15 * minute),
      '1h': candles(2, 60 * minute),
    },
  })
  assert.equal(strategyForwardFirstDecisionTime(deployment), 2 * minute)
  assert.equal(assertStrategyForwardDataset(deployment, dataset).datasetHash, dataset.datasetHash)
  assert.equal(requireCurrentStrategyForwardDeployment(deployment, repository).id, 'helix_scalp_hunter')
})

test('forward evaluation rejects repository drift and mismatched market source', () => {
  const repository = snapshot()
  const deployment = createStrategyForwardDeployment(repository, {
    strategyId: 'helix_scalp_hunter', instrumentId: 'BTC-USDT-SWAP', symbol: 'BTC/USDT:USDT',
    activatedAt: 0, deploymentId: 'forward-test',
  })
  const dirty = structuredClone(repository)
  dirty.engine!.dirty = true
  const dataset = createStrategyHistoricalDataset({
    schemaVersion: 'helix.market-dataset/v1',
    source: { provider: 'okx', market: 'futures', instrumentId: 'ETH-USDT-SWAP', symbol: 'ETH/USDT:USDT' },
    capturedThrough: minute,
    timeframes: { '1m': candles(1, minute) },
  })
  assert.throws(
    () => assertStrategyForwardDataset(deployment, dataset),
    /forward dataset source does not match/,
  )
  const matchingDataset = createStrategyHistoricalDataset({
    schemaVersion: 'helix.market-dataset/v1',
    source: { provider: 'okx', market: 'futures', instrumentId: 'BTC-USDT-SWAP', symbol: 'BTC/USDT:USDT' },
    capturedThrough: minute,
    timeframes: { '1m': candles(1, minute) },
  })
  assert.throws(
    () => requireCurrentStrategyForwardDeployment(deployment, dirty),
    /engine repository must be clean/,
  )
  assert.equal(assertStrategyForwardDataset(deployment, matchingDataset).datasetHash, matchingDataset.datasetHash)
})

test('forward session advances closed candles once and fails closed if processed history changes', () => {
  const repository = snapshot()
  const deployment = createStrategyForwardDeployment(repository, {
    strategyId: 'helix_scalp_hunter', instrumentId: 'BTC-USDT-SWAP', symbol: 'BTC/USDT:USDT',
    activatedAt: 60 * minute + 30_000, deploymentId: 'forward-session-test',
  })
  const dataset = createStrategyHistoricalDataset({
    schemaVersion: 'helix.market-dataset/v1',
    source: { provider: 'okx', market: 'futures', instrumentId: 'BTC-USDT-SWAP', symbol: 'BTC/USDT:USDT' },
    capturedThrough: 2 * 60 * minute,
    timeframes: {
      '1m': candles(120, minute), '5m': candles(24, 5 * minute),
      '15m': candles(8, 15 * minute), '1h': candles(2, 60 * minute),
    },
  })
  const session = new StrategyForwardSession(deployment, repository)
  assert.deepEqual(session.advance(repository, dataset), [])
  assert.equal(session.state().lastDecisionTime, 2 * 60 * minute)
  assert.deepEqual(session.advance(repository, dataset), [])

  const changedMinute = candles(120, minute)
  changedMinute[changedMinute.length - 1] = {
    ...changedMinute.at(-1)!,
    close: changedMinute.at(-1)!.close + 0.1,
  }
  const changed = createStrategyHistoricalDataset({
    schemaVersion: 'helix.market-dataset/v1',
    source: dataset.source,
    capturedThrough: dataset.capturedThrough,
    timeframes: { ...dataset.timeframes, '1m': changedMinute },
  })
  assert.throws(
    () => session.advance(repository, changed),
    /forward market history changed after a decision was processed/,
  )
})

test('merges verified incremental datasets and rejects changed overlap candles', () => {
  const source = { provider: 'okx', market: 'futures', instrumentId: 'BTC-USDT-SWAP', symbol: 'BTC/USDT:USDT' }
  const current = createStrategyHistoricalDataset({
    schemaVersion: 'helix.market-dataset/v1', source, capturedThrough: 2 * minute,
    timeframes: { '1m': candles(2, minute) },
  })
  const delta = createStrategyHistoricalDataset({
    schemaVersion: 'helix.market-dataset/v1', source, capturedThrough: 3 * minute,
    timeframes: { '1m': candles(3, minute).slice(1) },
  })
  const merged = mergeStrategyForwardDatasets(current, delta)
  assert.deepEqual(merged.timeframes['1m']!.map((candle) => candle.time), [0, minute, 2 * minute])

  const changedRows = candles(3, minute).slice(1)
  changedRows[0] = { ...changedRows[0]!, close: changedRows[0]!.close + 0.1 }
  const changed = createStrategyHistoricalDataset({
    schemaVersion: 'helix.market-dataset/v1', source, capturedThrough: 3 * minute,
    timeframes: { '1m': changedRows },
  })
  assert.throws(() => mergeStrategyForwardDatasets(current, changed), /changed closed 1m candle/)
})

test('checkpoint recovery over a compacted market window exactly matches activation replay batches', () => {
  const repository = snapshot()
  const deployment = createStrategyForwardDeployment(repository, {
    strategyId: 'helix_scalp_hunter', instrumentId: 'BTC-USDT-SWAP', symbol: 'BTC/USDT:USDT',
    activatedAt: 51 * 60 * minute + 30_000, deploymentId: 'forward-checkpoint-replay',
  })
  const oneMinute = signalCandles(61 * 60)
  const full = createStrategyHistoricalDataset({
    schemaVersion: 'helix.market-dataset/v1',
    source: { provider: 'okx', market: 'futures', instrumentId: 'BTC-USDT-SWAP', symbol: 'BTC/USDT:USDT' },
    capturedThrough: oneMinute.length * minute,
    timeframes: {
      '1m': oneMinute,
      '5m': aggregate(oneMinute, 5),
      '15m': aggregate(oneMinute, 15),
      '1h': aggregate(oneMinute, 60),
    },
  })
  const replay = new StrategyForwardSession(deployment, repository)
  const replayBatches = replay.advance(repository, full)
  assert.ok(replayBatches.length >= 2)

  const splitTime = 55 * 60 * minute
  const prefix = createStrategyHistoricalDataset({
    schemaVersion: 'helix.market-dataset/v1',
    source: full.source,
    capturedThrough: splitTime,
    timeframes: Object.fromEntries(Object.entries(full.timeframes).map(([timeframe, rows]) => {
      const duration = timeframe === '1m' ? minute
        : timeframe === '5m' ? 5 * minute
          : timeframe === '15m' ? 15 * minute
            : 60 * minute
      return [timeframe, rows.filter((candle) => candle.time + duration <= splitTime)]
    })),
  })
  const staged = new StrategyForwardSession(deployment, repository)
  const prefixBatches = staged.advance(repository, prefix)
  const checkpoint = staged.checkpoint(splitTime)
  assert.equal(assertStrategyForwardCheckpoint(structuredClone(checkpoint), deployment).checkpointHash, checkpoint.checkpointHash)
  const tampered = {
    ...structuredClone(checkpoint),
    noSignalJournal: {
      ...structuredClone(checkpoint.noSignalJournal),
      total: checkpoint.noSignalJournal.total + 1,
    },
  }
  assert.throws(() => assertStrategyForwardCheckpoint(tampered, deployment), /counters are inconsistent|hash mismatch/)

  const retained = compactStrategyForwardDataset(
    full,
    checkpoint.lastDecisionTime,
    staged.state().marketRetentionMsByTimeframe,
  )
  assert.ok(retained.timeframes['1m']!.length < full.timeframes['1m']!.length)
  const restored = new StrategyForwardSession(deployment, repository, checkpoint)
  const suffixBatches = restored.advance(repository, retained)
  assert.deepEqual(
    restored.checkpoint(full.capturedThrough).evaluator,
    replay.checkpoint(full.capturedThrough).evaluator,
  )
  assert.deepEqual([...prefixBatches, ...suffixBatches], replayBatches)
  assert.deepEqual(restored.state().statistics, replay.state().statistics)
  assert.deepEqual(restored.state().position, replay.state().position)
  assert.equal(restored.state().lastBatchHash, replay.state().lastBatchHash)
  assert.equal(restored.state().batchCount, replay.state().batchCount)
  assert.equal(restored.state().noSignalJournal.entries.length, STRATEGY_FORWARD_NO_SIGNAL_CAPACITY)
  assert.equal(
    restored.state().noSignalJournal.total,
    restored.state().noSignalJournal.discarded + STRATEGY_FORWARD_NO_SIGNAL_CAPACITY,
  )
  for (const batch of replayBatches) {
    assert.equal(batch.decisionStateHash, strategyForwardDecisionStateHash({
      schemaVersion: STRATEGY_FORWARD_DECISION_STATE_SCHEMA_VERSION,
      deploymentHash: deployment.deploymentHash,
      decisionTime: batch.signal.decisionTime,
      marketDataSnapshotId: batch.identity.marketDataSnapshotId,
      previousDecisionStateHash: batch.previousDecisionStateHash,
      evaluatorStateHash: batch.evaluatorStateHash,
      position: batch.positionAfter,
      signal: {
        signalId: batch.signal.signalId,
        decisionId: batch.signal.decisionId,
        object: batch.signal.object,
        action: batch.signal.action,
        side: batch.signal.side,
        reasonCodes: batch.signal.reasonCodes,
      },
    }))
  }
  const earliestRetainedNoSignal = restored.state().noSignalJournal.entries[0]!.decisionTime
  const decisionTail = [
    ...restored.state().noSignalJournal.entries,
    ...replayBatches.map((batch) => ({
      decisionTime: batch.signal.decisionTime,
      previousDecisionStateHash: batch.previousDecisionStateHash,
      decisionStateHash: batch.decisionStateHash,
    })),
  ].filter((entry) => entry.decisionTime >= earliestRetainedNoSignal)
    .sort((left, right) => left.decisionTime - right.decisionTime)
  for (let index = 1; index < decisionTail.length; index += 1) {
    assert.equal(decisionTail[index]!.previousDecisionStateHash, decisionTail[index - 1]!.decisionStateHash)
  }
  assert.equal(decisionTail.at(-1)!.decisionStateHash, restored.state().decisionStateHash)

  const truncatedCheckpoint = restored.checkpoint(full.capturedThrough)
  assert.ok(truncatedCheckpoint.noSignalJournal.discarded > 0)
  const extendedMinute = signalCandles(62 * 60)
  const extended = createStrategyHistoricalDataset({
    schemaVersion: 'helix.market-dataset/v1',
    source: full.source,
    capturedThrough: extendedMinute.length * minute,
    timeframes: {
      '1m': extendedMinute,
      '5m': aggregate(extendedMinute, 5),
      '15m': aggregate(extendedMinute, 15),
      '1h': aggregate(extendedMinute, 60),
    },
  })
  const uninterruptedExtra = replay.advance(repository, extended)
  const recoveredAgain = new StrategyForwardSession(deployment, repository, truncatedCheckpoint)
  const retainedExtended = compactStrategyForwardDataset(
    extended,
    truncatedCheckpoint.lastDecisionTime,
    recoveredAgain.state().marketRetentionMsByTimeframe,
  )
  assert.deepEqual(recoveredAgain.advance(repository, retainedExtended), uninterruptedExtra)
  assert.equal(recoveredAgain.state().decisionStateHash, replay.state().decisionStateHash)
})

test('forward worker publishes a durable ready heartbeat and does not refetch an unchanged close', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-forward-worker-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const repository = snapshot()
  const deployment = createStrategyForwardDeployment(repository, {
    strategyId: 'helix_scalp_hunter', instrumentId: 'BTC-USDT-SWAP', symbol: 'BTC/USDT:USDT',
    activatedAt: 60 * minute + 30_000, deploymentId: 'forward-worker-test',
  })
  const dataset = createStrategyHistoricalDataset({
    schemaVersion: 'helix.market-dataset/v1',
    source: { provider: 'okx', market: 'futures', instrumentId: 'BTC-USDT-SWAP', symbol: 'BTC/USDT:USDT' },
    capturedThrough: 2 * 60 * minute,
    timeframes: {
      '1m': candles(120, minute), '5m': candles(24, 5 * minute),
      '15m': candles(8, 15 * minute), '1h': candles(2, 60 * minute),
    },
  })
  let fetches = 0
  const batches = join(home, 'batches')
  const marketDataFile = join(home, 'market-data.json')
  const statusFile = join(home, 'status.json')
  const worker = new StrategyForwardWorker(deployment, batches, marketDataFile, statusFile, async () => {
    fetches += 1
    return dataset
  })

  const first = await worker.advance(repository, dataset.capturedThrough)
  assert.equal(first.state, 'ready')
  assert.equal(first.deploymentHash, deployment.deploymentHash)
  assert.equal(first.lastDecisionTime, dataset.capturedThrough)
  assert.deepEqual(await readdir(batches), [])
  assert.equal(JSON.parse(await readFile(statusFile, 'utf8')).state, 'ready')
  const storedMarketData = JSON.parse(await readFile(marketDataFile, 'utf8'))
  assert.ok(storedMarketData.timeframes['1m'].length < dataset.timeframes['1m']!.length)
  assert.equal(storedMarketData.timeframes['1m'].length, 15)
  const storedCheckpoint = assertStrategyForwardCheckpoint(
    JSON.parse(await readFile(join(home, 'checkpoint.json'), 'utf8')),
    deployment,
  )
  assert.equal(storedCheckpoint.lastDecisionTime, dataset.capturedThrough)
  const storedNoSignalJournal = JSON.parse(await readFile(join(home, 'no-signal-journal.json'), 'utf8'))
  assert.equal(storedNoSignalJournal.total, storedNoSignalJournal.entries.length)
  assert.equal(storedNoSignalJournal.discarded, 0)
  await worker.advance(repository, dataset.capturedThrough)
  assert.equal(fetches, 1)

  const restarted = new StrategyForwardWorker(
    deployment,
    batches,
    marketDataFile,
    statusFile,
    async () => { throw new Error('restart must not redownload persisted history') },
  )
  const replayed = await restarted.advance(repository, dataset.capturedThrough)
  assert.equal(replayed.state, 'ready')
  assert.equal(replayed.lastMarketSnapshotId, first.lastMarketSnapshotId)
})

test('forward worker loop stays alive across transient failures and resets its backoff after recovery', async () => {
  const sleeps: number[] = []
  const failures: string[] = []
  let advances = 0
  const worker = {
    async advance() {
      advances += 1
      if (advances === 1) throw new Error('temporary OKX failure')
      return {} as never
    },
    async fail(error: unknown) {
      failures.push(error instanceof Error ? error.message : String(error))
      return failures.at(-1)!
    },
  }
  await runStrategyForwardWorkerLoop(worker, async () => snapshot(), {
    intervalMs: 10,
    iterations: 3,
    now: () => 120 * minute,
    sleep: async (milliseconds) => { sleeps.push(milliseconds) },
  })
  assert.equal(advances, 3)
  assert.deepEqual(failures, ['temporary OKX failure'])
  assert.deepEqual(sleeps, [10, 20, 10])
})
