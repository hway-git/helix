import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  StrategyRepositorySnapshot,
  StrategyWalkForwardPolicy,
  StrategyWalkForwardPortfolioPlanPayload,
} from '@helix/contracts/strategy'
import {
  createStrategyWalkForwardPlanArtifact,
  createStrategyWalkForwardRunArtifact,
} from './walk-forward'
import {
  assertStrategyWalkForwardPortfolioPlan,
  createStrategyWalkForwardPortfolioPlan,
  createStrategyWalkForwardPortfolioPlanArtifact,
} from './walk-forward-portfolio'

const minute = 60_000
const day = 24 * 60 * minute

function policy(): StrategyWalkForwardPolicy {
  return {
    schemaVersion: 'helix.walk-forward-policy/v2',
    id: 'scalp_walk_forward_v1',
    version: '2.0.0',
    strategyId: 'helix_scalp_hunter',
    strategyVersion: '1.0.3',
    policyPath: 'strategies/scalp/validation/walk-forward-policy.yaml',
    policyHash: `sha256:${'9'.repeat(64)}`,
    plan: {
      foldCount: 2,
      entryWindowMs: 2 * minute,
      observationTailMs: minute,
      riskUnitRatio: 0.01,
      referenceAccountEquity: 2_000,
      executionScenarios: [
        { id: 'base', fee: 0.0005 },
        { id: 'stressed', fee: 0.001 },
      ],
    },
    gates: {
      censoredEntries: 'reject',
      minimumTotalTrades: 24,
      minimumActiveFoldRatio: 0.5,
      minimumPositiveFoldRatio: 0.5,
      minimumExpectancyR: 0,
      minimumProfitFactor: 1.1,
      maximumDrawdownR: 8,
      segmentStability: {
        dimensions: ['scalp.event_type'],
        minimumTradesPerSegment: 4,
        minimumStableSegmentRatio: 2 / 3,
      },
      symbolStability: {
        members: [
          {
            provider: 'okx', market: 'futures',
            instrumentId: 'BTC-USDT-SWAP', symbol: 'BTC/USDT:USDT',
          },
          {
            provider: 'okx', market: 'futures',
            instrumentId: 'ETH-USDT-SWAP', symbol: 'ETH/USDT:USDT',
          },
        ],
        minimumStableSymbolRatio: 0.5,
      },
    },
  }
}

function payload(): StrategyWalkForwardPortfolioPlanPayload {
  const walkForwardPolicy = policy()
  return {
    schemaVersion: 'helix.walk-forward-portfolio-plan/v1',
    mode: 'fixed_candidate_multi_symbol',
    candidate: {
      strategyId: 'helix_scalp_hunter',
      strategyVersion: '1.0.3',
      strategyRepoCommit: 'a'.repeat(40),
      strategyConfigHash: `sha256:${'b'.repeat(64)}`,
      engineCommit: 'c'.repeat(40),
      lifecycle: 'proposal',
      objectModel: 'PRICE_EVENT',
    },
    walkForwardPolicy,
    members: walkForwardPolicy.gates.symbolStability!.members.map((source, index) => ({
      source,
      sourceDatasetHash: `sha256:${String(index + 1).repeat(64)}`,
      capturedThrough: 8 * minute,
      planHash: `sha256:${String(index + 3).repeat(64)}`,
      runHash: `sha256:${String(index + 5).repeat(64)}`,
    })),
    baseTimeframe: '1m',
    requiredTimeframes: ['1h', '15m', '5m', '1m'],
    activationDecisionTime: 2 * minute,
    warmupDurationMs: minute,
    folds: [
      {
        sequence: 0,
        entryWindowStartTime: 2 * minute,
        entryWindowEndTime: 4 * minute,
        observationEndTime: 5 * minute,
      },
      {
        sequence: 1,
        entryWindowStartTime: 4 * minute,
        entryWindowEndTime: 6 * minute,
        observationEndTime: 7 * minute,
      },
    ],
    executionScenarios: walkForwardPolicy.plan.executionScenarios,
  }
}

function builderFixture() {
  const walkForwardPolicy: StrategyWalkForwardPolicy = {
    schemaVersion: 'helix.walk-forward-policy/v2',
    id: 'swing_walk_forward_v1',
    version: '2.0.0',
    strategyId: 'helix_swing_hunter',
    strategyVersion: '1.0.4',
    policyPath: 'strategies/swing/validation/walk-forward-policy.yaml',
    policyHash: `sha256:${'9'.repeat(64)}`,
    plan: {
      foldCount: 2,
      entryWindowMs: 2 * day,
      observationTailMs: day,
      riskUnitRatio: 0.01,
      referenceAccountEquity: 2_000,
      executionScenarios: [
        { id: 'base', fee: 0.0005 },
        { id: 'stressed', fee: 0.001 },
      ],
    },
    gates: {
      censoredEntries: 'reject',
      minimumTotalTrades: 24,
      minimumActiveFoldRatio: 0.5,
      minimumPositiveFoldRatio: 0.5,
      minimumExpectancyR: 0,
      minimumProfitFactor: 1.1,
      maximumDrawdownR: 10,
      segmentStability: {
        dimensions: ['swing.stage'],
        minimumTradesPerSegment: 4,
        minimumStableSegmentRatio: 0.5,
      },
      symbolStability: {
        members: [
          {
            provider: 'okx', market: 'futures',
            instrumentId: 'BTC-USDT-SWAP', symbol: 'BTC/USDT:USDT',
          },
          {
            provider: 'okx', market: 'futures',
            instrumentId: 'ETH-USDT-SWAP', symbol: 'ETH/USDT:USDT',
          },
        ],
        minimumStableSymbolRatio: 0.5,
      },
    },
  }
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
      max_attempts_per_thesis: 1,
      stop_buffer_atr: 0.1,
    },
    swing_risk_budget_v1: {
      thesis_risk_budget_r: 1,
      maximum_leverage: 50,
      risk_by_stage_r: { EARLY: 0.2, STANDARD: 0.3, CONFIRMED: 0.5 },
    },
  }
  const snapshot: StrategyRepositorySnapshot = {
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
      version: '1.0.4',
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
      reasonCodes: [],
      walkForwardPolicy,
    }],
    compatibility: [{
      strategyId: 'helix_swing_hunter',
      engineCommit: 'c'.repeat(40),
      compatible: true,
      required: [],
      available: [],
      missing: [],
      unconfigured: [],
      invalidConfiguration: [],
    }],
    fetchedAt: 0,
    errors: [],
  }
  const candidate = {
    strategyId: 'helix_swing_hunter',
    strategyVersion: '1.0.4',
    strategyRepoCommit: 'a'.repeat(40),
    strategyConfigHash: `sha256:${'b'.repeat(64)}`,
    engineCommit: 'c'.repeat(40),
    lifecycle: 'proposal' as const,
    objectModel: 'TRADE_THESIS' as const,
  }
  const folds = [
    {
      sequence: 0,
      entryWindowStartTime: 5 * day,
      entryWindowEndTime: 7 * day,
      observationEndTime: 8 * day,
    },
    {
      sequence: 1,
      entryWindowStartTime: 7 * day,
      entryWindowEndTime: 9 * day,
      observationEndTime: 10 * day,
    },
  ]
  const evidenceHash = `sha256:${'d'.repeat(64)}`
  const children = walkForwardPolicy.gates.symbolStability!.members.map((source, sourceIndex) => {
    const plan = createStrategyWalkForwardPlanArtifact({
      schemaVersion: 'helix.walk-forward-plan/v1',
      mode: 'fixed_candidate',
      candidate,
      walkForwardPolicy,
      sourceDataset: {
        datasetHash: `sha256:${String(sourceIndex + 1).repeat(64)}`,
        source,
        capturedThrough: 10 * day,
      },
      baseTimeframe: '15m',
      requiredTimeframes: ['1d', '4h', '1h', '15m'],
      activationDecisionTime: 5 * day,
      warmupDurationMs: 5 * day,
      folds,
      executionScenarios: walkForwardPolicy.plan.executionScenarios,
    })
    const run = createStrategyWalkForwardRunArtifact({
      schemaVersion: 'helix.walk-forward-run/v1',
      planFile: 'walk-forward-plan.json',
      planHash: plan.planHash,
      folds: folds.map((fold, index) => {
        const prefix = `fold-${String(index).padStart(3, '0')}`
        return {
          ...fold,
          datasetFile: `${prefix}-dataset.json`,
          datasetHash: evidenceHash,
          decisionArtifactFile: `${prefix}-decision-artifact.json`,
          decisionArtifactHash: evidenceHash,
          decisionRiskTraceFile: `${prefix}-decision-risk-trace.json`,
          decisionRiskTraceHash: evidenceHash,
          replayArtifactFile: `${prefix}-replay-artifact.json`,
          replayArtifactHash: evidenceHash,
          executionArtifactFile: `${prefix}-execution-artifact.json`,
          executionArtifactHash: evidenceHash,
          executionRiskTraceFile: `${prefix}-execution-risk-trace.json`,
          executionRiskTraceHash: evidenceHash,
          tradeIds: [],
          censoredEntries: [],
          statistics: {
            decisionSignals: 0,
            entriesInWindow: 0,
            completedTrades: 0,
            censoredEntries: 0,
            evaluator: {},
          },
        }
      }),
    })
    return { plan, run }
  })
  return { snapshot, children, walkForwardPolicy }
}

test('creates a content-addressed portfolio plan without changing child identities', () => {
  const plan = createStrategyWalkForwardPortfolioPlanArtifact(payload())
  assert.match(plan.planHash, /^sha256:[a-f0-9]{64}$/)
  assert.deepEqual(assertStrategyWalkForwardPortfolioPlan(plan), plan)
  assert.deepEqual(
    plan.members.map(({ source, planHash, runHash }) => ({ symbol: source.symbol, planHash, runHash })),
    [
      {
        symbol: 'BTC/USDT:USDT',
        planHash: `sha256:${'3'.repeat(64)}`,
        runHash: `sha256:${'5'.repeat(64)}`,
      },
      {
        symbol: 'ETH/USDT:USDT',
        planHash: `sha256:${'4'.repeat(64)}`,
        runHash: `sha256:${'6'.repeat(64)}`,
      },
    ],
  )

  const tampered = {
    ...plan,
    members: plan.members.map((member, index) => (
      index === 0 ? { ...member, runHash: `sha256:${'7'.repeat(64)}` } : member
    )),
  }
  assert.throws(() => assertStrategyWalkForwardPortfolioPlan(tampered), /plan hash mismatch/)
})

test('production builder canonicalizes child order to the policy universe', () => {
  const { snapshot, children, walkForwardPolicy } = builderFixture()
  const ordered = createStrategyWalkForwardPortfolioPlan({
    snapshot,
    strategyId: 'helix_swing_hunter',
    members: children,
  })
  const reversed = createStrategyWalkForwardPortfolioPlan({
    snapshot,
    strategyId: 'helix_swing_hunter',
    members: [...children].reverse(),
  })

  assert.equal(reversed.planHash, ordered.planHash)
  assert.deepEqual(reversed, ordered)
  assert.deepEqual(
    ordered.members.map(({ source }) => source.symbol),
    walkForwardPolicy.gates.symbolStability!.members.map(({ symbol }) => symbol),
  )
  assert.deepEqual(
    ordered.members.map(({ planHash, runHash }) => ({ planHash, runHash })),
    children.map(({ plan, run }) => ({ planHash: plan.planHash, runHash: run.runHash })),
  )
})

test('requires the exact ordered policy universe and unique child identities', () => {
  const original = payload()
  const reversed = { ...original, members: [...original.members].reverse() }
  assert.throws(
    () => createStrategyWalkForwardPortfolioPlanArtifact(reversed),
    /members do not exactly match the policy symbol universe/,
  )

  const duplicateSymbolSource = payload()
  const duplicateSymbol = {
    ...duplicateSymbolSource,
    members: duplicateSymbolSource.members.map((member, index) => (
      index === 1
        ? { ...member, source: { ...member.source, symbol: duplicateSymbolSource.members[0]!.source.symbol } }
        : member
    )),
  }
  assert.throws(
    () => createStrategyWalkForwardPortfolioPlanArtifact(duplicateSymbol),
    /duplicate symbols/,
  )

  const duplicateRunSource = payload()
  const duplicateRun = {
    ...duplicateRunSource,
    members: duplicateRunSource.members.map((member, index) => (
      index === 1 ? { ...member, runHash: duplicateRunSource.members[0]!.runHash } : member
    )),
  }
  assert.throws(
    () => createStrategyWalkForwardPortfolioPlanArtifact(duplicateRun),
    /duplicate child identities/,
  )
})

test('rejects V1 policies and members that do not cover every observation tail', () => {
  const portfolio = payload()
  const { symbolStability: _symbolStability, ...legacyGates } = portfolio.walkForwardPolicy.gates
  const legacy = {
    ...portfolio,
    walkForwardPolicy: {
      ...portfolio.walkForwardPolicy,
      schemaVersion: 'helix.walk-forward-policy/v1' as const,
      gates: legacyGates,
    },
  }
  assert.throws(
    () => createStrategyWalkForwardPortfolioPlanArtifact(legacy),
    /requires a V2 policy with symbol stability/,
  )

  const shortDatasetSource = payload()
  const shortDataset = {
    ...shortDatasetSource,
    members: shortDatasetSource.members.map((member, index) => (
      index === 1 ? { ...member, capturedThrough: 6 * minute } : member
    )),
  }
  assert.throws(
    () => createStrategyWalkForwardPortfolioPlanArtifact(shortDataset),
    /does not cover every fold observation window/,
  )
})
