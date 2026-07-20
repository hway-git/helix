import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { backtestFeeObservations, backtestMetrics } from '../lib/backtest-metrics.mjs';
import { reconcileSignalBacktest } from '../lib/backtest-reconciliation.mjs';
import {
  createExecutionRuntimeEvidence,
  executionConfigIdentity,
  executionConfigIdentityHash,
  executionProfileHash,
  signalExecutionProfile,
} from '../lib/execution-runtime-evidence.mjs';
import {
  createWalkForwardReport,
  loadPromotableWalkForwardReport,
  loadWalkForwardBundle,
  verifyWalkForwardPlan,
  verifyWalkForwardReport,
  walkForwardPlanHash,
  walkForwardReportHash,
  walkForwardRunHash,
} from '../lib/walk-forward.mjs';
import { historicalRiskTraceHash } from '../lib/historical-risk.mjs';
import { marketDatasetHash } from '../lib/market-dataset.mjs';
import { signalArtifactHash } from '../lib/signal-artifact.mjs';
import { createPromotableWalkForwardReport } from './helpers/promotable-report.mjs';

const execFileAsync = promisify(execFile);
const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY = resolve(SKILL_DIR, 'scripts', 'ft-deploy.mjs');

function planFixture() {
  const payload = {
    schemaVersion: 'helix.walk-forward-plan/v1',
    mode: 'fixed_candidate',
    candidate: {
      strategyId: 'helix_scalp_hunter',
      strategyVersion: '1.0.1',
      strategyRepoCommit: 'a'.repeat(40),
      strategyConfigHash: `sha256:${'b'.repeat(64)}`,
      engineCommit: 'c'.repeat(40),
      lifecycle: 'proposal',
      objectModel: 'PRICE_EVENT',
    },
    sourceDataset: {
      datasetHash: `sha256:${'d'.repeat(64)}`,
      source: {
        provider: 'okx',
        market: 'futures',
        instrumentId: 'BTC-USDT-SWAP',
        symbol: 'BTC/USDT:USDT',
      },
      capturedThrough: 14_400_000,
    },
    baseTimeframe: '1m',
    requiredTimeframes: ['1h', '15m', '5m', '1m'],
    activationDecisionTime: 7_200_000,
    warmupDurationMs: 3_600_000,
    folds: [
      {
        sequence: 0,
        entryWindowStartTime: 7_200_000,
        entryWindowEndTime: 9_000_000,
        observationEndTime: 10_800_000,
      },
      {
        sequence: 1,
        entryWindowStartTime: 9_000_000,
        entryWindowEndTime: 10_800_000,
        observationEndTime: 14_400_000,
      },
    ],
    executionScenarios: [
      { id: 'base', fee: 0.0005 },
      { id: 'fee_stress', fee: 0.001 },
    ],
  };
  return { ...payload, planHash: walkForwardPlanHash(payload) };
}

function walkForwardPolicyFixture({ entryWindowMs, observationTailMs, executionScenarios }) {
  return {
    schemaVersion: 'helix.walk-forward-policy/v1',
    id: 'scalp_walk_forward_v1',
    version: '1.0.0',
    strategyId: 'helix_scalp_hunter',
    strategyVersion: '1.0.1',
    policyPath: 'strategies/scalp/validation/walk-forward-policy.yaml',
    policyHash: `sha256:${'9'.repeat(64)}`,
    plan: {
      foldCount: 2,
      entryWindowMs,
      observationTailMs,
      riskUnitRatio: 0.01,
      referenceAccountEquity: 1000,
      executionScenarios: structuredClone(executionScenarios),
    },
    gates: {
      censoredEntries: 'reject',
      minimumTotalTrades: 1,
      minimumActiveFoldRatio: 0.5,
      minimumPositiveFoldRatio: 0,
      minimumExpectancyR: -0.1,
      minimumProfitFactor: 0,
      maximumDrawdownR: 1,
      segmentStability: {
        dimensions: ['scalp.event_type'],
        minimumTradesPerSegment: 1,
        minimumStableSegmentRatio: 1 / 3,
      },
    },
  };
}

test('matches the Core canonical plan hash', () => {
  const payload = {
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
      {
        sequence: 0,
        entryWindowStartTime: 120_000,
        entryWindowEndTime: 240_000,
        observationEndTime: 300_000,
      },
      {
        sequence: 1,
        entryWindowStartTime: 240_000,
        entryWindowEndTime: 360_000,
        observationEndTime: 420_000,
      },
    ],
    executionScenarios: [{ id: 'base', fee: 0.0005 }, { id: 'stressed', fee: 0.001 }],
  };
  assert.equal(
    walkForwardPlanHash(payload),
    'sha256:3e1b24c657c96c2690ab0e12ea650adb25f676417b3e126095478c6e86dff5e4',
  );
});

test('verifies a policy-pinned plan and rejects policy/plan divergence', () => {
  const plan = planFixture();
  plan.folds[1].observationEndTime = 12_600_000;
  plan.walkForwardPolicy = walkForwardPolicyFixture({
    entryWindowMs: 1_800_000,
    observationTailMs: 1_800_000,
    executionScenarios: plan.executionScenarios,
  });
  const { planHash: _oldHash, ...payload } = plan;
  plan.planHash = walkForwardPlanHash(payload);
  assert.deepEqual(verifyWalkForwardPlan(plan), plan);

  const changedRiskUnit = structuredClone(plan);
  changedRiskUnit.walkForwardPolicy.plan.riskUnitRatio = 0.02;
  assert.throws(() => verifyWalkForwardPlan(changedRiskUnit), /plan hash mismatch/);

  const mismatched = structuredClone(plan);
  mismatched.walkForwardPolicy.plan.foldCount = 3;
  const { planHash: _mismatchedHash, ...mismatchedPayload } = mismatched;
  mismatched.planHash = walkForwardPlanHash(mismatchedPayload);
  assert.throws(() => verifyWalkForwardPlan(mismatched), /fold count does not match walkForwardPolicy/);
});

test('verifies a fixed-candidate plan and rejects hash tampering', () => {
  const plan = planFixture();
  assert.deepEqual(verifyWalkForwardPlan(plan), plan);
  const tampered = structuredClone(plan);
  tampered.executionScenarios[1].fee = 0.002;
  assert.throws(() => verifyWalkForwardPlan(tampered), /plan hash mismatch/);
});

test('requires contiguous half-open entry windows and a real fee stress', () => {
  const gap = planFixture();
  gap.folds[1].entryWindowStartTime += 60_000;
  const { planHash: _gapHash, ...gapPayload } = gap;
  gap.planHash = walkForwardPlanHash(gapPayload);
  assert.throws(() => verifyWalkForwardPlan(gap), /not contiguous/);

  const noStress = planFixture();
  noStress.executionScenarios[1].fee = noStress.executionScenarios[0].fee;
  const { planHash: _stressHash, ...noStressPayload } = noStress;
  noStress.planHash = walkForwardPlanHash(noStressPayload);
  assert.throws(() => verifyWalkForwardPlan(noStress), /higher stressed fee/);
});

function marketDataset(candles, capturedThrough) {
  const payload = {
    schemaVersion: 'helix.market-dataset/v1',
    source: {
      provider: 'okx', market: 'futures', instrumentId: 'BTC-USDT-SWAP', symbol: 'BTC/USDT:USDT',
    },
    capturedThrough,
    timeframes: { '1m': candles },
  };
  return { ...payload, datasetHash: marketDatasetHash(payload) };
}

function signalArtifact(dataset, signals, lastCandleCloseTime) {
  const payload = {
    schemaVersion: 'helix.signal-artifact/v1',
    identity: {
      strategyId: 'helix_scalp_hunter',
      strategyVersion: '1.0.1',
      strategyRepoCommit: 'a'.repeat(40),
      strategyConfigHash: `sha256:${'b'.repeat(64)}`,
      engineCommit: 'c'.repeat(40),
      marketDataSnapshotId: dataset.datasetHash,
    },
    strategyLifecycle: 'proposal',
    objectModel: 'PRICE_EVENT',
    symbol: 'BTC/USDT:USDT',
    baseTimeframe: '1m',
    marketData: { firstCandleOpenTime: 60_000, lastCandleCloseTime },
    signals,
  };
  return { ...payload, artifactHash: signalArtifactHash(payload) };
}

function riskTrace(artifact, entries) {
  const payload = {
    schemaVersion: 'helix.historical-risk-trace/v1',
    signalArtifactHash: artifact.artifactHash,
    entries,
  };
  return { ...payload, traceHash: historicalRiskTraceHash(payload) };
}

async function writeBundle(directory, { censored = false, exitAtObservationEnd = false, policy = false } = {}) {
  const minute = 60_000;
  const candles = Array.from({ length: 8 }, (_, index) => ({
    time: index * minute,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 10 + index,
  }));
  const source = marketDataset(candles, 8 * minute);
  const foldDatasets = [marketDataset(candles.slice(0, 6), 6 * minute), source];
  const planPayload = {
    schemaVersion: 'helix.walk-forward-plan/v1',
    mode: 'fixed_candidate',
    candidate: {
      strategyId: 'helix_scalp_hunter', strategyVersion: '1.0.1',
      strategyRepoCommit: 'a'.repeat(40), strategyConfigHash: `sha256:${'b'.repeat(64)}`,
      engineCommit: 'c'.repeat(40), lifecycle: 'proposal', objectModel: 'PRICE_EVENT',
    },
    sourceDataset: {
      datasetHash: source.datasetHash, source: source.source, capturedThrough: source.capturedThrough,
    },
    baseTimeframe: '1m',
    requiredTimeframes: ['1m'],
    activationDecisionTime: 2 * minute,
    warmupDurationMs: 2 * minute,
    folds: [
      { sequence: 0, entryWindowStartTime: 2 * minute, entryWindowEndTime: 4 * minute, observationEndTime: 6 * minute },
      { sequence: 1, entryWindowStartTime: 4 * minute, entryWindowEndTime: 6 * minute, observationEndTime: 8 * minute },
    ],
    executionScenarios: [{ id: 'base', fee: 0.0005 }, { id: 'stressed', fee: 0.001 }],
  };
  if (policy) {
    planPayload.walkForwardPolicy = walkForwardPolicyFixture({
      entryWindowMs: 2 * minute,
      observationTailMs: 2 * minute,
      executionScenarios: planPayload.executionScenarios,
    });
  }
  const plan = { ...planPayload, planHash: walkForwardPlanHash(planPayload) };
  const enter = {
    sequence: 0,
    signalId: 'entry-0',
    decisionId: 'decision-entry-0',
    object: { model: 'PRICE_EVENT', id: 'event-0' },
    action: 'ENTER',
    side: 'LONG',
    sourceCandleOpenTime: 2 * minute,
    decisionTime: 3 * minute,
    reasonCodes: ['EXECUTION_TRIGGERED'],
  };
  const exit = {
    sequence: 1,
    signalId: 'exit-0',
    decisionId: 'decision-exit-0',
    object: { model: 'PRICE_EVENT', id: 'event-0' },
    action: 'EXIT',
    side: 'LONG',
    sourceCandleOpenTime: 4 * minute,
    decisionTime: 5 * minute,
    reasonCodes: ['TARGET_HIT'],
  };
  const lateExit = {
    ...exit,
    sourceCandleOpenTime: 6 * minute,
    decisionTime: 7 * minute,
  };
  const boundaryExit = {
    ...exit,
    sourceCandleOpenTime: 5 * minute,
    decisionTime: 6 * minute,
  };
  const completedSignals = exitAtObservationEnd ? [enter, boundaryExit] : [enter, exit];
  const decisionArtifacts = [
    signalArtifact(foldDatasets[0], censored ? [enter] : completedSignals, 6 * minute),
    signalArtifact(foldDatasets[1], censored ? [enter, lateExit] : completedSignals, 8 * minute),
  ];
  const executionArtifacts = [
    censored || exitAtObservationEnd
      ? signalArtifact(foldDatasets[0], [], 6 * minute)
      : decisionArtifacts[0],
    signalArtifact(foldDatasets[1], [], 8 * minute),
  ];
  const entryRisk = {
    entrySignalId: enter.signalId,
    family: 'scalp',
    object: enter.object,
    side: enter.side,
    entryPrice: { source: 'DECISION_CANDLE_CLOSE', price: candles[2].close },
    initialStop: 100,
    initialTarget: 109,
    riskDistance: candles[2].close - 100,
    riskR: 0.35,
    scalp: {
      eventType: 'LIQUIDITY_SWEEP',
      grade: 'A',
      regime: { id: 'regime-0', type: 'RANGING' },
    },
  };
  const decisionRiskTraces = decisionArtifacts.map((artifact) => riskTrace(artifact, [entryRisk]));
  const executionRiskTraces = executionArtifacts.map((artifact, index) => (
    riskTrace(artifact, index === 0 && !censored && !exitAtObservationEnd ? [entryRisk] : [])
  ));
  const folds = plan.folds.map((fold, index) => {
    const prefix = `fold-${String(index).padStart(3, '0')}`;
    return {
      ...fold,
      datasetFile: `${prefix}-dataset.json`,
      datasetHash: foldDatasets[index].datasetHash,
      decisionArtifactFile: `${prefix}-decision-artifact.json`,
      decisionArtifactHash: decisionArtifacts[index].artifactHash,
      decisionRiskTraceFile: `${prefix}-decision-risk-trace.json`,
      decisionRiskTraceHash: decisionRiskTraces[index].traceHash,
      replayArtifactFile: `${prefix}-replay-artifact.json`,
      replayArtifactHash: decisionArtifacts[index].artifactHash,
      executionArtifactFile: `${prefix}-execution-artifact.json`,
      executionArtifactHash: executionArtifacts[index].artifactHash,
      executionRiskTraceFile: `${prefix}-execution-risk-trace.json`,
      executionRiskTraceHash: executionRiskTraces[index].traceHash,
      tradeIds: index === 0 && !censored && !exitAtObservationEnd ? ['entry-0'] : [],
      censoredEntries: index === 0 && (censored || exitAtObservationEnd) ? [{
        tradeId: enter.signalId,
        entrySignalId: enter.signalId,
        decisionId: enter.decisionId,
        object: enter.object,
        side: enter.side,
        sourceCandleOpenTime: enter.sourceCandleOpenTime,
        decisionTime: enter.decisionTime,
        reason: exitAtObservationEnd ? 'EXIT_AT_OBSERVATION_END' : 'NO_EXIT_BY_OBSERVATION_END',
      }] : [],
      statistics: {
        decisionSignals: decisionArtifacts[index].signals.length,
        entriesInWindow: index === 0 ? 1 : 0,
        completedTrades: index === 0 && !censored && !exitAtObservationEnd ? 1 : 0,
        censoredEntries: index === 0 && (censored || exitAtObservationEnd) ? 1 : 0,
        evaluator: {},
      },
    };
  });
  const runPayload = {
    schemaVersion: 'helix.walk-forward-run/v1',
    planFile: 'walk-forward-plan.json',
    planHash: plan.planHash,
    folds,
  };
  const run = { ...runPayload, runHash: walkForwardRunHash(runPayload) };
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'source.json'), JSON.stringify(source));
  await writeFile(join(directory, 'walk-forward-plan.json'), JSON.stringify(plan));
  await writeFile(join(directory, 'walk-forward-run.json'), JSON.stringify(run));
  for (const [index, fold] of folds.entries()) {
    await writeFile(join(directory, fold.datasetFile), JSON.stringify(foldDatasets[index]));
    await writeFile(join(directory, fold.decisionArtifactFile), JSON.stringify(decisionArtifacts[index]));
    await writeFile(join(directory, fold.decisionRiskTraceFile), JSON.stringify(decisionRiskTraces[index]));
    await writeFile(join(directory, fold.replayArtifactFile), JSON.stringify(decisionArtifacts[index]));
    await writeFile(join(directory, fold.executionArtifactFile), JSON.stringify(executionArtifacts[index]));
    await writeFile(join(directory, fold.executionRiskTraceFile), JSON.stringify(executionRiskTraces[index]));
  }
  return { plan, run, executionArtifacts, executionRiskTraces };
}

test('verifies the full Core run bundle and exact execution cohort derivation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-walk-forward-bundle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await writeBundle(directory);
  const bundle = loadWalkForwardBundle(
    join(directory, 'walk-forward-run.json'),
    join(directory, 'source.json'),
  );
  assert.equal(bundle.plan.planHash, fixture.plan.planHash);
  assert.equal(bundle.run.runHash, fixture.run.runHash);
  assert.deepEqual(bundle.folds[0].run.tradeIds, ['entry-0']);

  const tampered = structuredClone(fixture.executionArtifacts[0]);
  tampered.signals[0].reasonCodes = ['OTHER_REASON'];
  await writeFile(join(directory, fixture.run.folds[0].executionArtifactFile), JSON.stringify(tampered));
  assert.throws(() => loadWalkForwardBundle(
    join(directory, 'walk-forward-run.json'),
    join(directory, 'source.json'),
  ), /signal artifact hash mismatch/);
});

test('treats an EXIT at observationEndTime as censored instead of executable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-walk-forward-boundary-exit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeBundle(directory, { exitAtObservationEnd: true });
  const bundle = loadWalkForwardBundle(
    join(directory, 'walk-forward-run.json'),
    join(directory, 'source.json'),
  );
  assert.deepEqual(bundle.folds[0].run.tradeIds, []);
  assert.deepEqual(bundle.folds[0].run.censoredEntries.map(({ reason }) => reason), [
    'EXIT_AT_OBSERVATION_END',
  ]);
  assert.deepEqual(bundle.folds[0].executionArtifact.signals, []);
  assert.deepEqual(bundle.folds[0].executionRiskTrace.entries, []);
});

function backtestResultFixture(plan, fold, scenario, index) {
  const tradeCount = fold.run.tradeIds.length;
  const stressed = index > 0;
  const profitRatio = stressed ? -0.002 : 0.01;
  const [entry, exit] = fold.executionArtifact.signals;
  const openRate = tradeCount
    ? fold.dataset.timeframes[fold.executionArtifact.baseTimeframe]
      .find(({ time }) => time === entry.decisionTime).open
    : null;
  const closeRate = tradeCount
    ? fold.dataset.timeframes[fold.executionArtifact.baseTimeframe]
      .find(({ time }) => time === exit.decisionTime).open
    : null;
  const risk = fold.executionRiskTrace.entries[0];
  const riskUnitRatio = plan.walkForwardPolicy?.plan.riskUnitRatio ?? 0.01;
  const accountEquity = plan.walkForwardPolicy?.plan.referenceAccountEquity ?? 1000;
  const stakeAmount = tradeCount
    ? (accountEquity * riskUnitRatio * risk.riskR)
      / (
        (Math.abs(openRate - risk.initialStop) / openRate)
        + scenario.fee
        + (risk.initialStop / openRate) * scenario.fee
      )
    : null;
  const profitAbs = tradeCount ? stakeAmount * profitRatio : 0;
  const summary = {
    total_trades: tradeCount,
    wins: tradeCount && !stressed ? tradeCount : 0,
    draws: 0,
    losses: tradeCount && stressed ? tradeCount : 0,
    profit_total: tradeCount ? profitRatio : 0,
    profit_total_abs: tradeCount ? profitAbs : 0,
    winrate: tradeCount ? (stressed ? 0 : 1) : 0,
    max_drawdown_account: tradeCount ? Math.max(0, -profitRatio) : 0,
    max_drawdown_abs: tradeCount ? Math.max(0, -profitAbs) : 0,
    expectancy: tradeCount ? profitAbs : 0,
    expectancy_ratio: stressed && tradeCount ? 0.5 : 0,
    profit_factor: stressed && tradeCount ? 0.8 : 0,
    holding_avg_s: tradeCount ? (exit.decisionTime - entry.decisionTime) / 1000 : 0,
    trades: tradeCount ? [{
      pair: fold.executionArtifact.symbol,
      is_open: false,
      is_short: entry.side === 'SHORT',
      open_timestamp: entry.decisionTime,
      close_timestamp: exit.decisionTime,
      enter_tag: entry.signalId,
      exit_reason: exit.signalId,
      open_rate: openRate,
      close_rate: closeRate,
      profit_ratio: profitRatio,
      profit_abs: profitAbs,
      stake_amount: stakeAmount,
      leverage: 1,
      fee_open: scenario.fee,
      fee_close: scenario.fee,
    }] : [],
  };
  return {
    summary,
    resultContent: `${JSON.stringify({ strategy: { HelixSignalStrategy: summary } })}\n`,
    resultMetaContent: `${JSON.stringify({ HelixSignalStrategy: { run_id: `${fold.run.sequence}-${scenario.id}` } })}\n`,
  };
}

const adapterFiles = [
  { name: 'HelixSignalStrategy.py', contentBase64: Buffer.from('class HelixSignalStrategy:\n    pass\n').toString('base64') },
  { name: 'helix_signal_artifact.py', contentBase64: Buffer.from('ARTIFACT = True\n').toString('base64') },
  { name: 'helix_signal_batch.py', contentBase64: Buffer.from('BATCH = True\n').toString('base64') },
];

function executionConfig(plan) {
  return {
    trading_mode: 'futures', margin_mode: 'isolated', max_open_trades: 2,
    stake_currency: 'USDT', stake_amount: 'unlimited', tradable_balance_ratio: 0.5,
    dry_run: true,
    dry_run_wallet: plan.walkForwardPolicy?.plan.referenceAccountEquity ?? 1000,
    entry_pricing: { price_side: 'same', use_order_book: true, order_book_top: 1 },
    exit_pricing: { price_side: 'same', use_order_book: true, order_book_top: 1 },
    exchange: { name: plan.sourceDataset.source.provider },
  };
}

function runtimeEvidence(plan, fold, scenario, resultHash, resultMetaHash) {
  const config = executionConfig(plan);
  return createExecutionRuntimeEvidence({
    resultHash,
    resultMetaHash,
    datasetHash: fold.dataset.datasetHash,
    executionArtifactHash: fold.executionArtifact.artifactHash,
    riskTraceHash: fold.executionRiskTrace.traceHash,
    riskUnitRatio: plan.walkForwardPolicy?.plan.riskUnitRatio ?? 0.01,
    scenarioId: scenario.id,
    fee: scenario.fee,
    freqtradeVersion: 'freqtrade 2026.6',
    configIdentity: executionConfigIdentity(config),
    executionProfile: signalExecutionProfile(config, {
      timeframe: plan.baseTimeframe,
      pairs: [plan.sourceDataset.source.symbol],
      fee: scenario.fee,
    }),
    adapterFiles,
  });
}

function executionEvidence(plan, fold, scenario, index) {
  const { summary, resultContent, resultMetaContent } = backtestResultFixture(plan, fold, scenario, index);
  const resultHash = `sha256:${createHash('sha256').update(resultContent).digest('hex')}`;
  const resultMetaHash = `sha256:${createHash('sha256').update(resultMetaContent).digest('hex')}`;
  const runtime = runtimeEvidence(plan, fold, scenario, resultHash, resultMetaHash);
  const runtimeContent = `${JSON.stringify(runtime, null, 2)}\n`;
  const runtimeEvidenceHash = `sha256:${createHash('sha256').update(runtimeContent).digest('hex')}`;
  const tradeCount = fold.run.tradeIds.length;
  return {
    scenarioId: scenario.id,
    fee: scenario.fee,
    freqtradeVersion: runtime.freqtradeVersion,
    configHash: runtime.configHash,
    adapterHash: runtime.adapterHash,
    executionProfile: runtime.executionProfile,
    executionProfileHash: runtime.executionProfileHash,
    riskTraceHash: fold.executionRiskTrace.traceHash,
    riskUnitRatio: plan.walkForwardPolicy?.plan.riskUnitRatio ?? 0.01,
    runtimeEvidenceFile: `evidence/${runtimeEvidenceHash.replace(':', '-')}.runtime.json`,
    runtimeEvidenceHash,
    resultFile: `evidence/${resultHash.replace(':', '-')}.json`,
    resultHash,
    resultMetaFile: `evidence/${resultMetaHash.replace(':', '-')}.meta.json`,
    resultMetaHash,
    reconciliation: reconcileSignalBacktest(summary, fold.executionArtifact),
    feeObservations: backtestFeeObservations(summary, scenario.fee),
    metrics: backtestMetrics(summary, {
      signalArtifact: fold.executionArtifact,
      riskTrace: fold.executionRiskTrace,
      marketDataset: fold.dataset,
      riskUnitRatio: plan.walkForwardPolicy?.plan.riskUnitRatio ?? 0.01,
      accountEquity: plan.walkForwardPolicy?.plan.referenceAccountEquity ?? 1000,
    }),
  };
}

async function writeReportArchives(directory, bundle, evidence) {
  const root = `core/${bundle.run.runHash.replace(':', '-')}`;
  const entries = [
    ['source-dataset.json', bundle.sourceDataset],
    [bundle.run.planFile, bundle.plan],
    ['walk-forward-run.json', bundle.run],
    ...bundle.folds.flatMap((fold) => [
      [fold.run.datasetFile, fold.dataset],
      [fold.run.decisionArtifactFile, fold.decisionArtifact],
      [fold.run.decisionRiskTraceFile, fold.decisionRiskTrace],
      [fold.run.replayArtifactFile, fold.replayArtifact],
      [fold.run.executionArtifactFile, fold.executionArtifact],
      [fold.run.executionRiskTraceFile, fold.executionRiskTrace],
    ]),
  ];
  const files = [];
  for (const [name, value] of entries) {
    const file = `${root}/${name}`;
    const content = `${JSON.stringify(value, null, 2)}\n`;
    await mkdir(dirname(join(directory, file)), { recursive: true });
    await writeFile(join(directory, file), content);
    files.push({
      file,
      fileHash: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    });
  }
  await mkdir(join(directory, 'evidence'), { recursive: true });
  for (const [foldIndex, foldEvidence] of evidence.entries()) {
    for (const [scenarioIndex, item] of foldEvidence.entries()) {
      const scenario = bundle.plan.executionScenarios[scenarioIndex];
      const fixture = backtestResultFixture(bundle.plan, bundle.folds[foldIndex], scenario, scenarioIndex);
      await writeFile(
        join(directory, item.resultFile),
        fixture.resultContent,
      );
      await writeFile(
        join(directory, item.resultMetaFile),
        fixture.resultMetaContent,
      );
      const runtime = runtimeEvidence(
        bundle.plan,
        bundle.folds[foldIndex],
        scenario,
        item.resultHash,
        item.resultMetaHash,
      );
      await writeFile(
        join(directory, item.runtimeEvidenceFile),
        `${JSON.stringify(runtime, null, 2)}\n`,
      );
    }
  }
  return {
    root,
    sourceDatasetFile: `${root}/source-dataset.json`,
    runFile: `${root}/walk-forward-run.json`,
    files,
  };
}

test('builds a hash-pinned R-normalized research report but requires a versioned policy', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-walk-forward-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeBundle(directory);
  const bundle = loadWalkForwardBundle(
    join(directory, 'walk-forward-run.json'),
    join(directory, 'source.json'),
  );
  const evidence = bundle.folds.map((fold) => bundle.plan.executionScenarios.map(
    (scenario, index) => executionEvidence(bundle.plan, fold, scenario, index),
  ));
  const coreEvidence = await writeReportArchives(directory, bundle, evidence);
  const report = createWalkForwardReport(bundle, evidence, coreEvidence);
  assert.throws(() => verifyWalkForwardReport(report), /reportDirectory is required/);
  assert.deepEqual(verifyWalkForwardReport(report, bundle, directory), report);
  assert.equal(report.gate.ok, false);
  assert.equal(
    report.gate.checks.find(({ code }) => code === 'REQUIRED_METRICS_PRESENT').ok,
    true,
  );
  assert.equal(report.aggregate.scenarios[0].riskNormalized.available, true);
  assert.equal(report.aggregate.scenarios[0].riskNormalized.activeFolds, 1);
  assert.equal(
    report.gate.checks.find(({ code }) => code === 'VERSIONED_GATE_POLICY_PRESENT').ok,
    false,
  );

  const legacyEvidence = structuredClone(evidence);
  for (const fold of legacyEvidence) {
    for (const item of fold) delete item.metrics.riskNormalized.observations;
  }
  const legacyReport = createWalkForwardReport(bundle, legacyEvidence, coreEvidence);
  assert.throws(
    () => verifyWalkForwardReport(legacyReport, bundle, directory),
    /metrics does not match archived result/,
  );

  const changedAdapter = structuredClone(evidence);
  changedAdapter[0][1].adapterHash = `sha256:${'9'.repeat(64)}`;
  assert.throws(
    () => createWalkForwardReport(bundle, changedAdapter, coreEvidence),
    /one Freqtrade version, config, and adapter/,
  );

  const unobservedFee = structuredClone(evidence);
  unobservedFee[0][1].feeObservations.openRates = [0.0005];
  unobservedFee[0][1].feeObservations.matchesRequested = false;
  assert.throws(
    () => createWalkForwardReport(bundle, unobservedFee, coreEvidence),
    /does not prove the requested fee was applied/,
  );

  const dishonest = structuredClone(report);
  dishonest.gate.ok = true;
  const { reportHash: _oldHash, ...dishonestPayload } = dishonest;
  dishonest.reportHash = walkForwardReportHash(dishonestPayload);
  assert.throws(() => verifyWalkForwardReport(dishonest, bundle, directory), /gate\.ok does not match/);

  const forgedMetrics = structuredClone(report);
  forgedMetrics.folds[0].executionEvidence[0].metrics.riskNormalized.mfeR += 1;
  const { reportHash: _forgedHash, ...forgedPayload } = forgedMetrics;
  forgedMetrics.reportHash = walkForwardReportHash(forgedPayload);
  assert.throws(
    () => verifyWalkForwardReport(forgedMetrics, bundle, directory),
    /metrics does not match archived result/,
  );

  for (const [field, replacement] of [
    ['adapterHash', `sha256:${'9'.repeat(64)}`],
    ['configHash', `sha256:${'8'.repeat(64)}`],
    ['freqtradeVersion', 'freqtrade forged-version'],
  ]) {
    const forgedRuntime = structuredClone(report);
    for (const fold of forgedRuntime.folds) {
      for (const item of fold.executionEvidence) item[field] = replacement;
    }
    const { reportHash: _runtimeHash, ...runtimePayload } = forgedRuntime;
    forgedRuntime.reportHash = walkForwardReportHash(runtimePayload);
    assert.throws(
      () => verifyWalkForwardReport(forgedRuntime, bundle, directory),
      new RegExp(`${field} does not match archived runtime evidence`),
    );
  }

  await writeFile(join(directory, report.folds[0].executionEvidence[0].resultFile), 'tampered\n');
  assert.throws(
    () => verifyWalkForwardReport(report, bundle, directory),
    /execution archive hash mismatch/,
  );
});

test('rebuilds every versioned policy gate from archived trade-level R evidence', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-walk-forward-policy-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeBundle(directory, { policy: true });
  const bundle = loadWalkForwardBundle(
    join(directory, 'walk-forward-run.json'),
    join(directory, 'source.json'),
  );
  const evidence = bundle.folds.map((fold) => bundle.plan.executionScenarios.map(
    (scenario, index) => executionEvidence(bundle.plan, fold, scenario, index),
  ));
  const coreEvidence = await writeReportArchives(directory, bundle, evidence);
  const wrongEquity = structuredClone(evidence);
  const wrongConfig = executionConfig(bundle.plan);
  wrongConfig.dry_run_wallet = 2000;
  const wrongConfigHash = executionConfigIdentityHash(executionConfigIdentity(wrongConfig));
  wrongEquity[0][0].configHash = wrongConfigHash;
  wrongEquity[0][0].executionProfile.configHash = wrongConfigHash;
  wrongEquity[0][0].executionProfile.dryRunWallet = 2000;
  wrongEquity[0][0].executionProfileHash = executionProfileHash(wrongEquity[0][0].executionProfile);
  assert.throws(
    () => createWalkForwardReport(bundle, wrongEquity, coreEvidence),
    /executionProfile does not match the plan scenario/,
  );
  const wrongRiskComponents = structuredClone(evidence);
  wrongRiskComponents[0][0].metrics.riskNormalized.observations[0].feeRiskBudget = 0;
  assert.throws(
    () => createWalkForwardReport(bundle, wrongRiskComponents, coreEvidence),
    /risk budget components are inconsistent/,
  );
  const report = createWalkForwardReport(bundle, evidence, coreEvidence);
  assert.equal(report.gate.ok, true);
  assert.equal(report.gate.checks.find(({ code }) => code === 'VERSIONED_GATE_POLICY_PRESENT').ok, true);
  assert.equal(report.gate.checks.find(({ code }) => code === 'RISK_SIZING_VALID').ok, true);
  assert.equal(report.gate.checks.find(({ code }) => code === 'SEGMENT_STABILITY').ok, true);
  assert.equal(report.aggregate.scenarios[0].riskNormalized.observations.length, 1);
  assert.deepEqual(verifyWalkForwardReport(report, bundle, directory), report);
  const reportFile = join(directory, `walk-forward-report-${report.reportHash.replace(':', '-')}.json`);
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  const artifact = {
    identity: {
      strategyId: report.candidate.strategyId,
      strategyVersion: report.candidate.strategyVersion,
      strategyRepoCommit: report.candidate.strategyRepoCommit,
      strategyConfigHash: report.candidate.strategyConfigHash,
      engineCommit: report.candidate.engineCommit,
    },
    strategyLifecycle: report.candidate.lifecycle,
    objectModel: report.candidate.objectModel,
    symbol: bundle.plan.sourceDataset.source.symbol,
    baseTimeframe: bundle.plan.baseTimeframe,
  };
  assert.equal(loadPromotableWalkForwardReport(reportFile, artifact).report.reportHash, report.reportHash);
  assert.throws(
    () => loadPromotableWalkForwardReport(reportFile, {
      ...artifact,
      identity: { ...artifact.identity, strategyConfigHash: `sha256:${'0'.repeat(64)}` },
    }),
    /does not match the Signal Artifact identity/,
  );
  assert.throws(
    () => loadPromotableWalkForwardReport(reportFile, { ...artifact, symbol: 'ETH/USDT:USDT' }),
    /source dataset symbol does not match the Signal Artifact symbol/,
  );
  assert.throws(
    () => loadPromotableWalkForwardReport(reportFile, { ...artifact, baseTimeframe: '5m' }),
    /base timeframe does not match/,
  );
  for (const [field, source] of [
    ['provider', {
      provider: 'binance', market: 'futures', instrumentId: 'BTC-USDT-SWAP', symbol: artifact.symbol,
    }],
    ['market', {
      provider: 'okx', market: 'swap', instrumentId: 'BTC-USDT-SWAP', symbol: artifact.symbol,
    }],
    ['instrumentId', {
      provider: 'okx', market: 'futures', instrumentId: 'BTC-USDT-PERP', symbol: artifact.symbol,
    }],
  ]) {
    const invalid = await createPromotableWalkForwardReport(
      join(directory, `invalid-source-${field}`),
      artifact,
      { source },
    );
    assert.throws(
      () => loadPromotableWalkForwardReport(invalid.reportFile, artifact),
      new RegExp(`source ${field} does not match`),
    );
  }

  const forged = JSON.parse(JSON.stringify(report));
  forged.aggregate.scenarios[0].riskNormalized.observations[0].realizedR += 1;
  const { reportHash: _oldHash, ...payload } = forged;
  forged.reportHash = walkForwardReportHash(payload);
  assert.throws(
    () => verifyWalkForwardReport(forged, bundle, directory),
    /does not match its verified Core bundle/,
  );
});

test('walk_forward rejects censored folds before invoking Freqtrade', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-walk-forward-censored-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeBundle(directory, { censored: true });
  await assert.rejects(execFileAsync(process.execPath, [
    DEPLOY,
    'walk_forward',
    JSON.stringify({
      walk_forward_run: join(directory, 'walk-forward-run.json'),
      source_dataset: join(directory, 'source.json'),
    }),
  ], {
    cwd: SKILL_DIR,
    env: { ...process.env, HOME: directory, HELIX_FREQTRADE_RUNTIME: '' },
  }), (error) => {
    assert.match(error.stderr, /right-censored entry/);
    return true;
  });
});
