import assert from 'node:assert/strict'
import test from 'node:test'
import type { Candle } from '@helix/contracts/market'
import type {
  StrategyRepositorySnapshot,
  StrategySignalRecord,
  StrategyWalkForwardPlanPayload,
  StrategyWalkForwardPolicy,
} from '@helix/contracts/strategy'
import { createStrategyHistoricalDataset } from './historical-dataset'
import {
  assertStrategyHistoricalRiskTrace,
  createStrategyHistoricalRiskTrace,
} from './historical-risk'
import { createStrategySignalArtifact } from './signal-artifact'
import {
  assertStrategyWalkForwardPlan,
  assertStrategyWalkForwardRun,
  createStrategyWalkForwardExecutionCohort,
  createStrategyWalkForwardPlan,
  createStrategyWalkForwardPlanArtifact,
  createStrategyWalkForwardPlanFromPolicy,
  runStrategyWalkForward,
} from './walk-forward'

const minute = 60_000
const hour = 60 * minute
const day = 24 * hour

function candles(count: number, duration: number): Candle[] {
  return Array.from({ length: count }, (_, index) => ({
    time: index * duration,
    open: 100 + index * 0.1,
    high: 101 + index * 0.1,
    low: 99 + index * 0.1,
    close: 100.5 + index * 0.1,
    volume: 100 + index,
  }))
}

function snapshot(): StrategyRepositorySnapshot {
  const capabilityConfigurations = {
    daily_market_context_v1: {
      fast_window_bars: 3, slow_window_bars: 4, ema_period: 3,
      swing_left_bars: 1, swing_right_bars: 1,
      trend_min_efficiency: 0.3, trend_min_ema_slope_atr: 0.2,
      range_max_efficiency: 0.2, range_max_ema_slope_atr: 0.1,
    },
    swing_location_v1: {
      atr_period: 2, lookback_bars: 3, range_lookback_bars: 3,
      swing_left_bars: 1, swing_right_bars: 1,
      zone_half_width_atr: 0.1, touch_tolerance_atr: 0.2,
      reaction_distance_atr: 0.5, reaction_bars: 2,
      mean_reversion_distance_atr: 1, max_test_count: 3,
      max_age_bars: 20, min_location_score: 40,
    },
    staged_execution_v1: {
      min_rr_by_stage: { EARLY: 1, STANDARD: 1, CONFIRMED: 1 },
      max_attempts_per_thesis: 2,
      stop_buffer_atr: 0.1,
    },
    swing_risk_budget_v1: {
      thesis_risk_budget_r: 1,
      maximum_leverage: 50,
      risk_by_stage_r: { EARLY: 0.2, STANDARD: 0.3, CONFIRMED: 0.5 },
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
      id: 'helix_swing_hunter',
      name: 'Helix Swing Hunter',
      family: 'swing',
      version: '1.0.1',
      lifecycle: 'proposal',
      objectModel: 'TRADE_THESIS',
      timeframes: [
        { role: 'context', timeframe: '1d' },
        { role: 'thesis', timeframe: '4h' },
        { role: 'evidence', timeframe: '1h' },
        { role: 'execution', timeframe: '15m' },
      ],
      manifestPath: 'strategies/swing/strategy.yaml',
      configHash: `sha256:${'b'.repeat(64)}`,
      requiredEngineCapabilities: Object.keys(capabilityConfigurations),
      capabilityConfigurations,
      reasonCodes: ['EXECUTION_TRIGGERED', 'STOP_HIT', 'TARGET_HIT', 'THESIS_INVALIDATED'],
    }],
    compatibility: [{
      strategyId: 'helix_swing_hunter', engineCommit: 'c'.repeat(40), compatible: true,
      required: [], available: [], missing: [], unconfigured: [], invalidConfiguration: [],
    }],
    fetchedAt: 0,
    errors: [],
  }
}

function dataset() {
  return createStrategyHistoricalDataset({
    schemaVersion: 'helix.market-dataset/v1',
    source: {
      provider: 'okx', market: 'futures', instrumentId: 'BTC-USDT-SWAP', symbol: 'BTC/USDT:USDT',
    },
    capturedThrough: 10 * day,
    timeframes: {
      '15m': candles(10 * 24 * 4, 15 * minute),
      '1h': candles(10 * 24, hour),
      '4h': candles(10 * 6, 4 * hour),
      '1d': candles(10, day),
    },
  })
}

function planOptions() {
  return {
    snapshot: snapshot(),
    strategyId: 'helix_swing_hunter',
    dataset: dataset(),
    activationDecisionTime: 5 * day,
    folds: [
      { entryWindowStartTime: 5 * day, entryWindowEndTime: 7 * day, observationEndTime: 8 * day },
      { entryWindowStartTime: 7 * day, entryWindowEndTime: 9 * day, observationEndTime: 10 * day },
    ],
    executionScenarios: [
      { id: 'base', fee: 0.0005 },
      { id: 'stressed', fee: 0.001 },
    ],
  }
}

function policyFixture(): StrategyWalkForwardPolicy {
  return {
    schemaVersion: 'helix.walk-forward-policy/v1',
    id: 'swing_walk_forward_v1',
    version: '1.0.0',
    strategyId: 'helix_swing_hunter',
    strategyVersion: '1.0.1',
    policyPath: 'strategies/swing/validation/walk-forward-policy.yaml',
    policyHash: `sha256:${'9'.repeat(64)}`,
    plan: {
      foldCount: 2,
      entryWindowMs: 2 * day,
      observationTailMs: day,
      riskUnitRatio: 0.01,
      referenceAccountEquity: 10_000,
      executionScenarios: [
        { id: 'base', fee: 0.0005 },
        { id: 'stressed', fee: 0.001 },
      ],
    },
    gates: {
      censoredEntries: 'reject',
      minimumTotalTrades: 1,
      minimumActiveFoldRatio: 0.5,
      minimumPositiveFoldRatio: 0.5,
      minimumExpectancyR: 0,
      minimumProfitFactor: 1,
      maximumDrawdownR: 10,
      segmentStability: {
        dimensions: ['swing.stage'],
        minimumTradesPerSegment: 1,
        minimumStableSegmentRatio: 0.5,
      },
    },
  }
}

const MINIMAL_PLAN_PAYLOAD: StrategyWalkForwardPlanPayload = {
  schemaVersion: 'helix.walk-forward-plan/v1',
  mode: 'fixed_candidate',
  candidate: {
    strategyId: 'helix_scalp_hunter',
    strategyVersion: '1.0.1',
    strategyRepoCommit: '1'.repeat(40),
    strategyConfigHash: `sha256:${'2'.repeat(64)}`,
    engineCommit: '3'.repeat(40),
    lifecycle: 'proposal',
    objectModel: 'PRICE_EVENT',
  },
  sourceDataset: {
    datasetHash: `sha256:${'4'.repeat(64)}`,
    source: {
      provider: 'okx', market: 'swap', instrumentId: 'BTC-USDT-SWAP', symbol: 'BTC/USDT:USDT',
    },
    capturedThrough: 420_000,
  },
  baseTimeframe: '1m',
  requiredTimeframes: ['1h', '15m', '5m', '1m'],
  activationDecisionTime: 120_000,
  warmupDurationMs: 60_000,
  folds: [
    { sequence: 0, entryWindowStartTime: 120_000, entryWindowEndTime: 240_000, observationEndTime: 300_000 },
    { sequence: 1, entryWindowStartTime: 240_000, entryWindowEndTime: 360_000, observationEndTime: 420_000 },
  ],
  executionScenarios: [
    { id: 'base', fee: 0.0005 },
    { id: 'stressed', fee: 0.001 },
  ],
}

test('uses a stable cross-runtime plan hash and rejects hash-preserving tampering', () => {
  const plan = createStrategyWalkForwardPlanArtifact(MINIMAL_PLAN_PAYLOAD)
  assert.equal(plan.planHash, 'sha256:3e1b24c657c96c2690ab0e12ea650adb25f676417b3e126095478c6e86dff5e4')
  assert.deepEqual(assertStrategyWalkForwardPlan(plan), plan)

  const tampered = structuredClone(plan)
  ;(tampered.candidate as { lifecycle: string }).lifecycle = 'backtested'
  assert.throws(() => assertStrategyWalkForwardPlan(tampered), /plan hash mismatch/)
  assert.throws(() => createStrategyWalkForwardPlanArtifact({
    ...MINIMAL_PLAN_PAYLOAD,
    executionScenarios: [{ id: 'one', fee: 0.001 }, { id: 'two', fee: 0.001 }],
  }), /at least one higher fee/)
  assert.throws(() => createStrategyWalkForwardPlanArtifact({
    ...MINIMAL_PLAN_PAYLOAD,
    executionScenarios: [{ id: 'Base', fee: 0.0005 }, { id: 'stressed', fee: 0.001 }],
  }), /id must use lowercase/)
})

test('pins the versioned policy and rejects plan parameters that diverge from it', () => {
  const options = planOptions()
  options.snapshot.manifests[0]!.walkForwardPolicy = policyFixture()
  const plan = createStrategyWalkForwardPlan(options)
  assert.deepEqual(plan.walkForwardPolicy, policyFixture())
  assert.deepEqual(assertStrategyWalkForwardPlan(plan), plan)

  const changedRiskUnit = structuredClone(plan)
  changedRiskUnit.walkForwardPolicy!.plan.riskUnitRatio = 0.02
  assert.throws(() => assertStrategyWalkForwardPlan(changedRiskUnit), /plan hash mismatch/)

  const wrongWindow = planOptions()
  wrongWindow.snapshot.manifests[0]!.walkForwardPolicy = policyFixture()
  wrongWindow.folds[0]!.entryWindowEndTime = 6 * day
  wrongWindow.folds[1]!.entryWindowStartTime = 6 * day
  assert.throws(() => createStrategyWalkForwardPlan(wrongWindow), /entry window does not match walkForwardPolicy/)

  const changedSnapshot = structuredClone(options.snapshot)
  changedSnapshot.manifests[0]!.walkForwardPolicy!.policyHash = `sha256:${'8'.repeat(64)}`
  assert.throws(
    () => runStrategyWalkForward({ plan, snapshot: changedSnapshot, dataset: options.dataset }),
    /policy changed after plan creation/,
  )
})

test('derives all fold windows and fee scenarios from the pinned policy', () => {
  const options = planOptions()
  options.snapshot.manifests[0]!.walkForwardPolicy = policyFixture()
  const plan = createStrategyWalkForwardPlanFromPolicy({
    snapshot: options.snapshot,
    strategyId: options.strategyId,
    dataset: options.dataset,
    activationDecisionTime: options.activationDecisionTime,
  })
  assert.deepEqual(plan.folds, [
    { sequence: 0, entryWindowStartTime: 5 * day, entryWindowEndTime: 7 * day, observationEndTime: 8 * day },
    { sequence: 1, entryWindowStartTime: 7 * day, entryWindowEndTime: 9 * day, observationEndTime: 10 * day },
  ])
  assert.deepEqual(plan.executionScenarios, policyFixture().plan.executionScenarios)

  const noPolicy = planOptions()
  assert.throws(() => createStrategyWalkForwardPlanFromPolicy({
    snapshot: noPolicy.snapshot,
    strategyId: noPolicy.strategyId,
    dataset: noPolicy.dataset,
    activationDecisionTime: noPolicy.activationDecisionTime,
  }), /has no versioned walk-forward policy/)
})

test('precommits touching half-open entry windows and rejects both gaps and overlaps', () => {
  const first = createStrategyWalkForwardPlan(planOptions())
  const replay = createStrategyWalkForwardPlan(planOptions())
  assert.deepEqual(replay, first)
  assert.equal(first.mode, 'fixed_candidate')
  assert.equal(first.candidate.lifecycle, 'proposal')
  assert.equal(first.folds[0]!.entryWindowEndTime, first.folds[1]!.entryWindowStartTime)
  assert.equal('datasetFile' in first.folds[0]!, false)

  const gap = planOptions()
  gap.folds[1]!.entryWindowStartTime = 8 * day
  assert.throws(() => createStrategyWalkForwardPlan(gap), /without a gap or overlap/)

  const overlap = planOptions()
  overlap.folds[1]!.entryWindowStartTime = 6 * day
  assert.throws(() => createStrategyWalkForwardPlan(overlap), /without a gap or overlap/)

  const backwardObservation = planOptions()
  backwardObservation.folds[0]!.observationEndTime = 10 * day
  backwardObservation.folds[1]!.observationEndTime = 9 * day
  assert.throws(() => createStrategyWalkForwardPlan(backwardObservation), /must not move backward/)
})

test('runs every fold from the common activation prefix with deterministic replay', () => {
  const options = planOptions()
  const plan = createStrategyWalkForwardPlan(options)
  const first = runStrategyWalkForward({ plan, snapshot: options.snapshot, dataset: options.dataset })
  const replay = runStrategyWalkForward({ plan, snapshot: options.snapshot, dataset: options.dataset })
  assert.deepEqual(replay, first)
  assert.deepEqual(assertStrategyWalkForwardRun(first.run), first.run)
  assert.equal(first.files[0]!.dataset.timeframes['1d']![0]!.time, 0)
  assert.equal(first.files[1]!.dataset.timeframes['1d']![0]!.time, 0)
  assert.equal(first.files[0]!.dataset.capturedThrough, 8 * day)
  assert.equal(first.files[1]!.dataset.capturedThrough, 10 * day)
  for (const [index, fold] of first.run.folds.entries()) {
    const files = first.files[index]!
    assert.equal(files.decisionArtifact.identity.marketDataSnapshotId, fold.datasetHash)
    assert.equal(files.decisionArtifact.artifactHash, fold.replayArtifactHash)
    assert.equal(files.decisionRiskTrace.traceHash, fold.decisionRiskTraceHash)
    assert.equal(
      fold.decisionRiskTraceFile,
      `fold-${String(index).padStart(3, '0')}-decision-risk-trace.json`,
    )
    assert.equal(files.decisionRiskTrace.signalArtifactHash, files.decisionArtifact.artifactHash)
    assert.deepEqual(
      assertStrategyHistoricalRiskTrace(files.decisionRiskTrace, files.decisionArtifact),
      files.decisionRiskTrace,
    )
    assert.equal(files.executionRiskTrace.traceHash, fold.executionRiskTraceHash)
    assert.equal(
      fold.executionRiskTraceFile,
      `fold-${String(index).padStart(3, '0')}-execution-risk-trace.json`,
    )
    assert.equal(files.executionRiskTrace.signalArtifactHash, files.executionArtifact.artifactHash)
    assert.deepEqual(
      assertStrategyHistoricalRiskTrace(files.executionRiskTrace, files.executionArtifact),
      files.executionRiskTrace,
    )
    assert.deepEqual(
      files.executionRiskTrace.entries.map(({ entrySignalId }) => entrySignalId),
      fold.tradeIds,
    )
    assert.equal(files.decisionArtifact.marketData.firstCandleOpenTime, 5 * day - 15 * minute)
    assert.equal(files.decisionArtifact.marketData.lastCandleCloseTime, fold.observationEndTime)
    assert.equal(files.executionArtifact.signals.every((signal) => signal.action === 'ENTER'
      ? signal.decisionTime >= fold.entryWindowStartTime && signal.decisionTime < fold.entryWindowEndTime
      : true), true)
  }

  const tampered = structuredClone(first.run)
  ;(tampered.folds[0]! as { datasetHash: string }).datasetHash = `sha256:${'f'.repeat(64)}`
  assert.throws(() => assertStrategyWalkForwardRun(tampered), /run hash mismatch/)

  const tamperedRiskTrace = structuredClone(first.run)
  ;(tamperedRiskTrace.folds[0]! as { executionRiskTraceHash: string }).executionRiskTraceHash = `sha256:${'f'.repeat(64)}`
  assert.throws(() => assertStrategyWalkForwardRun(tamperedRiskTrace), /run hash mismatch/)
})

function decisionSignal(
  sequence: number,
  signalId: string,
  objectId: string,
  action: StrategySignalRecord['action'],
  decisionTime: number,
): StrategySignalRecord {
  return {
    sequence,
    signalId,
    decisionId: `decision-${signalId}`,
    object: { model: 'TRADE_THESIS', id: objectId },
    action,
    side: 'LONG',
    sourceCandleOpenTime: decisionTime - 15 * minute,
    decisionTime,
    reasonCodes: [action === 'ENTER' ? 'EXECUTION_TRIGGERED' : 'TARGET_HIT'],
  }
}

function decisionArtifact(signals: readonly StrategySignalRecord[]) {
  return createStrategySignalArtifact({
    schemaVersion: 'helix.signal-artifact/v1',
    identity: {
      strategyId: 'helix_swing_hunter',
      strategyVersion: '1.0.1',
      strategyRepoCommit: 'a'.repeat(40),
      strategyConfigHash: `sha256:${'b'.repeat(64)}`,
      engineCommit: 'c'.repeat(40),
      marketDataSnapshotId: `sha256:${'d'.repeat(64)}`,
    },
    strategyLifecycle: 'proposal',
    objectModel: 'TRADE_THESIS',
    symbol: 'BTC/USDT:USDT',
    baseTimeframe: '15m',
    marketData: { firstCandleOpenTime: 0, lastCandleCloseTime: 8 * day },
    signals,
  })
}

function decisionEvidence(signals: readonly StrategySignalRecord[]) {
  const artifact = decisionArtifact(signals)
  const decisionRiskTrace = createStrategyHistoricalRiskTrace({
    schemaVersion: 'helix.historical-risk-trace/v1',
    signalArtifactHash: artifact.artifactHash,
    entries: signals.filter(({ action }) => action === 'ENTER').map((signal) => ({
      entrySignalId: signal.signalId,
      family: 'swing' as const,
      object: { model: 'TRADE_THESIS' as const, id: signal.object.id },
      side: signal.side,
      entryPrice: { source: 'DECISION_CANDLE_CLOSE' as const, price: 100 },
      initialStop: 95,
      initialTarget: 110,
      riskDistance: 5,
      riskR: 0.4,
      swing: {
        stage: 'CONFIRMED' as const,
        context: {
          id: `context-${signal.object.id}`,
          state: 'BULLISH_TREND' as const,
          bias: 'BULLISH' as const,
        },
      },
    })),
  }, artifact)
  return { decisionArtifact: artifact, decisionRiskTrace }
}

const cohortFold = {
  sequence: 0,
  entryWindowStartTime: 5 * day,
  entryWindowEndTime: 7 * day,
  observationEndTime: 8 * day,
}

test('keeps executable natural exits and censors entries without an execution candle', () => {
  const exitAtObservationEnd = createStrategyWalkForwardExecutionCohort({
    fold: cohortFold,
    ...decisionEvidence([
      decisionSignal(0, 'entry-a', 'thesis-a', 'ENTER', 6 * day),
      decisionSignal(1, 'exit-a', 'thesis-a', 'EXIT', 8 * day),
    ]),
  })
  assert.deepEqual(exitAtObservationEnd.tradeIds, [])
  assert.equal(exitAtObservationEnd.executionArtifact.signals.length, 0)
  assert.deepEqual(exitAtObservationEnd.censoredEntries.map(({ reason }) => reason), [
    'EXIT_AT_OBSERVATION_END',
  ])

  const completedBeforeObservationEnd = createStrategyWalkForwardExecutionCohort({
    fold: cohortFold,
    ...decisionEvidence([
      decisionSignal(0, 'entry-complete', 'thesis-complete', 'ENTER', 6 * day),
      decisionSignal(1, 'exit-complete', 'thesis-complete', 'EXIT', 8 * day - 15 * minute),
    ]),
  })
  assert.deepEqual(completedBeforeObservationEnd.tradeIds, ['entry-complete'])
  assert.deepEqual(
    completedBeforeObservationEnd.executionArtifact.signals.map(({ action }) => action),
    ['ENTER', 'EXIT'],
  )
  assert.deepEqual(
    completedBeforeObservationEnd.executionRiskTrace.entries.map(({ entrySignalId }) => entrySignalId),
    ['entry-complete'],
  )
  assert.equal(
    completedBeforeObservationEnd.executionRiskTrace.signalArtifactHash,
    completedBeforeObservationEnd.executionArtifact.artifactHash,
  )

  const entryAtWindowEnd = createStrategyWalkForwardExecutionCohort({
    fold: cohortFold,
    ...decisionEvidence([
      decisionSignal(0, 'entry-boundary', 'thesis-boundary', 'ENTER', 7 * day),
      decisionSignal(1, 'exit-boundary', 'thesis-boundary', 'EXIT', 8 * day),
    ]),
  })
  assert.deepEqual(entryAtWindowEnd.tradeIds, [])
  assert.deepEqual(entryAtWindowEnd.censoredEntries, [])
  assert.equal(entryAtWindowEnd.executionArtifact.signals.length, 0)
  assert.equal(entryAtWindowEnd.executionRiskTrace.entries.length, 0)

  const censored = createStrategyWalkForwardExecutionCohort({
    fold: cohortFold,
    ...decisionEvidence([
      decisionSignal(0, 'entry-open', 'thesis-open', 'ENTER', 6 * day),
    ]),
  })
  assert.equal(censored.executionArtifact.signals.length, 0)
  assert.deepEqual(censored.tradeIds, [])
  assert.equal(censored.censoredEntries.length, 1)
  assert.equal(censored.censoredEntries[0]!.tradeId, 'entry-open')
  assert.equal(censored.censoredEntries[0]!.reason, 'NO_EXIT_BY_OBSERVATION_END')
  assert.equal(censored.executionRiskTrace.entries.length, 0)
})

test('refuses to create a plan from a dirty Engine identity', () => {
  const options = planOptions()
  options.snapshot.engine!.dirty = true
  assert.throws(() => createStrategyWalkForwardPlan(options), /engine repository must be clean/)
})
