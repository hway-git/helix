import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { backtestFeeObservations, backtestMetrics } from '../../lib/backtest-metrics.mjs';
import { reconcileSignalBacktest } from '../../lib/backtest-reconciliation.mjs';
import {
  createExecutionRuntimeEvidence,
  executionConfigIdentity,
  signalExecutionProfile,
} from '../../lib/execution-runtime-evidence.mjs';
import { historicalRiskTraceHash } from '../../lib/historical-risk.mjs';
import { marketDatasetHash } from '../../lib/market-dataset.mjs';
import { signalArtifactHash } from '../../lib/signal-artifact.mjs';
import {
  createWalkForwardReport,
  loadWalkForwardBundle,
  walkForwardPlanHash,
  walkForwardRunHash,
} from '../../lib/walk-forward.mjs';

function sha256(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function dataset(candles, capturedThrough, source = {
  provider: 'okx', market: 'futures', instrumentId: 'BTC-USDT-SWAP', symbol: 'BTC/USDT:USDT',
}) {
  const payload = {
    schemaVersion: 'helix.market-dataset/v1',
    source,
    capturedThrough,
    timeframes: { '1m': candles },
  };
  return { ...payload, datasetHash: marketDatasetHash(payload) };
}

function signalArtifact(candidate, marketDataset, signals, lastCandleCloseTime) {
  const payload = {
    schemaVersion: 'helix.signal-artifact/v1',
    identity: {
      strategyId: candidate.strategyId,
      strategyVersion: candidate.strategyVersion,
      strategyRepoCommit: candidate.strategyRepoCommit,
      strategyConfigHash: candidate.strategyConfigHash,
      engineCommit: candidate.engineCommit,
      marketDataSnapshotId: marketDataset.datasetHash,
    },
    strategyLifecycle: candidate.lifecycle,
    objectModel: candidate.objectModel,
    symbol: marketDataset.source.symbol,
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

function resultFixture(fold, scenario, stressed, options = {}) {
  const tradeCount = fold.run.tradeIds.length;
  const profitRatio = stressed
    ? options.stressedProfitRatio ?? -0.002
    : options.baseProfitRatio ?? 0.01;
  const [entry, exit] = fold.executionArtifact.signals;
  const candles = fold.dataset.timeframes['1m'];
  const risk = fold.executionRiskTrace.entries[0];
  const openRate = tradeCount ? candles.find(({ time }) => time === entry.decisionTime).open : null;
  const stakeAmount = tradeCount
    ? (1000 * 0.01 * risk.riskR) / (
      (Math.abs(openRate - risk.initialStop) / openRate)
      + scenario.fee
      + (risk.initialStop / openRate) * scenario.fee
    )
    : null;
  const profitAbs = tradeCount ? stakeAmount * profitRatio : 0;
  const summary = {
    total_trades: tradeCount,
    wins: tradeCount && !stressed ? 1 : 0,
    draws: 0,
    losses: tradeCount && stressed ? 1 : 0,
    profit_total: tradeCount ? profitRatio : 0,
    profit_total_abs: profitAbs,
    winrate: tradeCount ? (stressed ? 0 : 1) : 0,
    max_drawdown_account: tradeCount ? Math.max(0, -profitRatio) : 0,
    max_drawdown_abs: tradeCount ? Math.max(0, -profitRatio * 1000) : 0,
    expectancy: profitAbs,
    expectancy_ratio: stressed && tradeCount ? 0.5 : 0,
    profit_factor: stressed && tradeCount ? 0 : 0,
    holding_avg_s: tradeCount ? (exit.decisionTime - entry.decisionTime) / 1000 : 0,
    trades: tradeCount ? [{
      pair: fold.executionArtifact.symbol,
      is_open: false,
      is_short: false,
      open_timestamp: entry.decisionTime,
      close_timestamp: exit.decisionTime,
      enter_tag: entry.signalId,
      exit_reason: exit.signalId,
      open_rate: openRate,
      close_rate: candles.find(({ time }) => time === exit.decisionTime).open,
      profit_ratio: profitRatio,
      profit_abs: profitAbs,
      stake_amount: stakeAmount,
      leverage: 1,
      fee_open: scenario.fee,
      fee_close: scenario.fee,
    }] : [],
  };
  const resultContent = `${JSON.stringify({ strategy: { HelixSignalStrategy: summary } })}\n`;
  const resultMetaContent = `${JSON.stringify({ HelixSignalStrategy: { run_id: `${fold.run.sequence}-${scenario.id}` } })}\n`;
  return { summary, resultContent, resultMetaContent };
}

function executionConfig() {
  return {
    trading_mode: 'futures', margin_mode: 'isolated', max_open_trades: 2,
    stake_currency: 'USDT', stake_amount: 'unlimited', tradable_balance_ratio: 0.5,
    dry_run: true, dry_run_wallet: 1000,
    entry_pricing: { price_side: 'same', use_order_book: true, order_book_top: 1 },
    exit_pricing: { price_side: 'same', use_order_book: true, order_book_top: 1 },
    exchange: { name: 'okx' },
  };
}

export async function createPromotableWalkForwardReport(root, artifact, options = {}) {
  const minute = 60_000;
  const candles = Array.from({ length: 8 }, (_, index) => ({
    time: index * minute,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 10 + index,
  }));
  const sourceIdentity = options.source || {
    provider: 'okx', market: 'futures', instrumentId: 'BTC-USDT-SWAP', symbol: 'BTC/USDT:USDT',
  };
  const source = dataset(candles, 8 * minute, sourceIdentity);
  const foldDatasets = [dataset(candles.slice(0, 6), 6 * minute, sourceIdentity), source];
  const candidate = {
    strategyId: artifact.identity.strategyId,
    strategyVersion: artifact.identity.strategyVersion,
    strategyRepoCommit: artifact.identity.strategyRepoCommit,
    strategyConfigHash: artifact.identity.strategyConfigHash,
    engineCommit: artifact.identity.engineCommit,
    lifecycle: artifact.strategyLifecycle,
    objectModel: artifact.objectModel,
  };
  const executionScenarios = [{ id: 'base', fee: 0.0005 }, { id: 'stressed', fee: 0.001 }];
  const planPayload = {
    schemaVersion: 'helix.walk-forward-plan/v1',
    mode: 'fixed_candidate',
    candidate,
    walkForwardPolicy: {
      schemaVersion: options.symbolStabilityMembers
        ? 'helix.walk-forward-policy/v2'
        : 'helix.walk-forward-policy/v1',
      id: 'scalp_walk_forward_v1',
      version: options.symbolStabilityMembers ? '2.0.0' : '1.0.0',
      strategyId: candidate.strategyId,
      strategyVersion: candidate.strategyVersion,
      policyPath: 'strategies/scalp/validation/walk-forward-policy.yaml',
      policyHash: `sha256:${'9'.repeat(64)}`,
      plan: {
        foldCount: 2,
        entryWindowMs: 2 * minute,
        observationTailMs: 2 * minute,
        riskUnitRatio: 0.01,
        referenceAccountEquity: 1000,
        executionScenarios,
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
          dimensions: ['scalp.event_type'], minimumTradesPerSegment: 1, minimumStableSegmentRatio: 1 / 3,
        },
        ...(options.symbolStabilityMembers ? {
          symbolStability: {
            members: options.symbolStabilityMembers,
            minimumStableSymbolRatio: options.minimumStableSymbolRatio ?? 1,
          },
        } : {}),
      },
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
    executionScenarios,
  };
  const plan = { ...planPayload, planHash: walkForwardPlanHash(planPayload) };
  const enter = {
    sequence: 0, signalId: 'fixture-entry', decisionId: 'fixture-entry-decision',
    object: { model: 'PRICE_EVENT', id: 'fixture-event' }, action: 'ENTER', side: 'LONG',
    sourceCandleOpenTime: 2 * minute, decisionTime: 3 * minute, reasonCodes: ['EXECUTION_TRIGGERED'],
  };
  const exit = {
    sequence: 1, signalId: 'fixture-exit', decisionId: 'fixture-exit-decision',
    object: enter.object, action: 'EXIT', side: 'LONG',
    sourceCandleOpenTime: 4 * minute, decisionTime: 5 * minute, reasonCodes: ['TARGET_HIT'],
  };
  const decisionArtifacts = foldDatasets.map((foldDataset, index) => (
    signalArtifact(candidate, foldDataset, [enter, exit], (index ? 8 : 6) * minute)
  ));
  const executionArtifacts = [decisionArtifacts[0], signalArtifact(candidate, foldDatasets[1], [], 8 * minute)];
  const entryRisk = {
    entrySignalId: enter.signalId,
    family: 'scalp', object: enter.object, side: 'LONG',
    entryPrice: { source: 'DECISION_CANDLE_CLOSE', price: candles[2].close },
    initialStop: 100, initialTarget: 109, riskDistance: candles[2].close - 100, riskR: 0.25,
    scalp: { eventType: 'LIQUIDITY_SWEEP', grade: 'A', regime: { id: 'fixture-regime', type: 'RANGING' } },
  };
  const decisionRisks = decisionArtifacts.map((item) => riskTrace(item, [entryRisk]));
  const executionRisks = [riskTrace(executionArtifacts[0], [entryRisk]), riskTrace(executionArtifacts[1], [])];
  const folds = plan.folds.map((fold, index) => {
    const prefix = `fold-${String(index).padStart(3, '0')}`;
    return {
      ...fold,
      datasetFile: `${prefix}-dataset.json`, datasetHash: foldDatasets[index].datasetHash,
      decisionArtifactFile: `${prefix}-decision-artifact.json`, decisionArtifactHash: decisionArtifacts[index].artifactHash,
      decisionRiskTraceFile: `${prefix}-decision-risk-trace.json`, decisionRiskTraceHash: decisionRisks[index].traceHash,
      replayArtifactFile: `${prefix}-replay-artifact.json`, replayArtifactHash: decisionArtifacts[index].artifactHash,
      executionArtifactFile: `${prefix}-execution-artifact.json`, executionArtifactHash: executionArtifacts[index].artifactHash,
      executionRiskTraceFile: `${prefix}-execution-risk-trace.json`, executionRiskTraceHash: executionRisks[index].traceHash,
      tradeIds: index === 0 ? [enter.signalId] : [],
      censoredEntries: [],
      statistics: {
        decisionSignals: 2, entriesInWindow: index === 0 ? 1 : 0,
        completedTrades: index === 0 ? 1 : 0, censoredEntries: 0, evaluator: {},
      },
    };
  });
  const runPayload = { schemaVersion: 'helix.walk-forward-run/v1', planFile: 'walk-forward-plan.json', planHash: plan.planHash, folds };
  const run = { ...runPayload, runHash: walkForwardRunHash(runPayload) };
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'source.json'), JSON.stringify(source));
  await writeFile(join(root, 'walk-forward-plan.json'), JSON.stringify(plan));
  await writeFile(join(root, 'walk-forward-run.json'), JSON.stringify(run));
  for (const [index, fold] of folds.entries()) {
    await writeFile(join(root, fold.datasetFile), JSON.stringify(foldDatasets[index]));
    await writeFile(join(root, fold.decisionArtifactFile), JSON.stringify(decisionArtifacts[index]));
    await writeFile(join(root, fold.decisionRiskTraceFile), JSON.stringify(decisionRisks[index]));
    await writeFile(join(root, fold.replayArtifactFile), JSON.stringify(decisionArtifacts[index]));
    await writeFile(join(root, fold.executionArtifactFile), JSON.stringify(executionArtifacts[index]));
    await writeFile(join(root, fold.executionRiskTraceFile), JSON.stringify(executionRisks[index]));
  }
  const bundle = loadWalkForwardBundle(join(root, 'walk-forward-run.json'), join(root, 'source.json'));
  const adapterFiles = [
    { name: 'HelixSignalStrategy.py', contentBase64: Buffer.from('class HelixSignalStrategy:\n    pass\n').toString('base64') },
    { name: 'helix_signal_artifact.py', contentBase64: Buffer.from('ARTIFACT = True\n').toString('base64') },
    { name: 'helix_signal_batch.py', contentBase64: Buffer.from('BATCH = True\n').toString('base64') },
  ];
  const config = executionConfig();
  const evidence = [];
  await mkdir(join(root, 'evidence'), { recursive: true });
  for (const fold of bundle.folds) {
    const scenarioEvidence = [];
    for (const [scenarioIndex, scenario] of bundle.plan.executionScenarios.entries()) {
      const fixture = resultFixture(fold, scenario, scenarioIndex > 0, options);
      const resultHash = sha256(fixture.resultContent);
      const resultMetaHash = sha256(fixture.resultMetaContent);
      const executionProfile = signalExecutionProfile(config, {
        timeframe: '1m', pairs: [source.source.symbol], fee: scenario.fee,
      });
      const runtime = createExecutionRuntimeEvidence({
        resultHash, resultMetaHash, datasetHash: fold.dataset.datasetHash,
        executionArtifactHash: fold.executionArtifact.artifactHash,
        riskTraceHash: fold.executionRiskTrace.traceHash,
        riskUnitRatio: 0.01,
        scenarioId: scenario.id, fee: scenario.fee, freqtradeVersion: 'freqtrade test',
        configIdentity: executionConfigIdentity(config), executionProfile, adapterFiles,
      });
      const resultFile = `evidence/${resultHash.replace(':', '-')}.json`;
      const resultMetaFile = `evidence/${resultMetaHash.replace(':', '-')}.meta.json`;
      const runtimeContent = `${JSON.stringify(runtime, null, 2)}\n`;
      const runtimeEvidenceHash = sha256(runtimeContent);
      const runtimeEvidenceFile = `evidence/${runtimeEvidenceHash.replace(':', '-')}.runtime.json`;
      await writeFile(join(root, resultFile), fixture.resultContent);
      await writeFile(join(root, resultMetaFile), fixture.resultMetaContent);
      await writeFile(join(root, runtimeEvidenceFile), runtimeContent);
      scenarioEvidence.push({
        scenarioId: scenario.id, fee: scenario.fee, freqtradeVersion: runtime.freqtradeVersion,
        configHash: runtime.configHash, adapterHash: runtime.adapterHash,
        executionProfile: runtime.executionProfile, executionProfileHash: runtime.executionProfileHash,
        riskTraceHash: fold.executionRiskTrace.traceHash, riskUnitRatio: 0.01,
        runtimeEvidenceFile, runtimeEvidenceHash, resultFile, resultHash, resultMetaFile, resultMetaHash,
        reconciliation: reconcileSignalBacktest(fixture.summary, fold.executionArtifact),
        feeObservations: backtestFeeObservations(fixture.summary, scenario.fee),
        metrics: backtestMetrics(fixture.summary, {
          signalArtifact: fold.executionArtifact, riskTrace: fold.executionRiskTrace, marketDataset: fold.dataset,
          riskUnitRatio: 0.01, accountEquity: 1000,
        }),
      });
    }
    evidence.push(scenarioEvidence);
  }
  const coreRoot = `core/${run.runHash.replace(':', '-')}`;
  const coreEntries = [
    ['source-dataset.json', source], [run.planFile, plan], ['walk-forward-run.json', run],
    ...bundle.folds.flatMap((fold) => [
      [fold.run.datasetFile, fold.dataset], [fold.run.decisionArtifactFile, fold.decisionArtifact],
      [fold.run.decisionRiskTraceFile, fold.decisionRiskTrace], [fold.run.replayArtifactFile, fold.replayArtifact],
      [fold.run.executionArtifactFile, fold.executionArtifact], [fold.run.executionRiskTraceFile, fold.executionRiskTrace],
    ]),
  ];
  const files = [];
  for (const [name, value] of coreEntries) {
    const file = `${coreRoot}/${name}`;
    const content = `${JSON.stringify(value, null, 2)}\n`;
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
    files.push({ file, fileHash: sha256(content) });
  }
  const coreEvidence = {
    root: coreRoot,
    sourceDatasetFile: `${coreRoot}/source-dataset.json`,
    runFile: `${coreRoot}/walk-forward-run.json`,
    files,
  };
  const report = createWalkForwardReport(bundle, evidence, coreEvidence);
  if (options.symbolStabilityMembers) {
    const failed = report.gate.checks.filter(({ ok }) => !ok).map(({ code }) => code);
    const expectedStable = options.expectStable !== false;
    if ((expectedStable && !isDeepStrictEqual(failed, ['SYMBOL_STABILITY_GATE_SATISFIED']))
      || (!expectedStable && (
        !failed.includes('SYMBOL_STABILITY_GATE_SATISFIED')
        || failed.every((code) => code === 'SYMBOL_STABILITY_GATE_SATISFIED')
      ))) {
      throw new Error(`test fixture V2 member report has unexpected failed gates: ${failed.join(', ')}`);
    }
  } else if (!report.gate.ok) throw new Error('test fixture walk-forward report is not promotable');
  const reportFile = join(root, `walk-forward-report-${report.reportHash.replace(':', '-')}.json`);
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return { report, reportFile, bundle };
}
