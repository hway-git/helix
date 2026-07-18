import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { historicalRiskTraceHash } from '../lib/historical-risk.mjs';
import { marketDatasetHash } from '../lib/market-dataset.mjs';
import { signalArtifactHash } from '../lib/signal-artifact.mjs';
import {
  verifyWalkForwardReport,
  walkForwardPlanHash,
  walkForwardRunHash,
} from '../lib/walk-forward.mjs';

const execFileAsync = promisify(execFile);
const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(SKILL_DIR, '..', '..');
const DEPLOY = resolve(SKILL_DIR, 'scripts', 'ft-deploy.mjs');
const dockerTest = process.env.HELIX_RUN_DOCKER_E2E === '1' ? test : test.skip;
const sentinel = 'HELIX_SENTINEL_SECRET_DO_NOT_ARCHIVE';
const minute = 60_000;

async function assertZipDoesNotContain(file, forbidden) {
  const needle = Buffer.from(forbidden);
  assert.equal((await readFile(file)).includes(needle), false, 'result ZIP raw bytes contain sentinel');
  const { stdout } = await execFileAsync('unzip', ['-Z1', file]);
  const entries = stdout.split('\n').map((entry) => entry.trim()).filter(Boolean);
  assert.equal(entries.length > 0, true, 'result ZIP has no entries');
  for (const entry of entries) {
    const extracted = await execFileAsync('unzip', ['-p', file, entry], {
      encoding: 'buffer',
      maxBuffer: 50 * 1024 * 1024,
    });
    assert.equal(
      extracted.stdout.includes(needle),
      false,
      `result ZIP entry ${entry} contains sentinel`,
    );
  }
}

function fixtures() {
  const first = 1_782_864_000_000;
  const candles = Array.from({ length: 10 }, (_, index) => {
    const open = 100 + index;
    return {
      time: first + index * minute,
      open,
      high: open + 2,
      low: open - 1,
      close: open + 1,
      volume: 100 + index,
    };
  });
  const datasetPayload = {
    schemaVersion: 'helix.market-dataset/v1',
    source: {
      provider: 'okx',
      market: 'futures',
      instrumentId: 'BTC-USDT-SWAP',
      symbol: 'BTC/USDT:USDT',
    },
    capturedThrough: first + candles.length * minute,
    timeframes: { '1m': candles },
  };
  const dataset = { ...datasetPayload, datasetHash: marketDatasetHash(datasetPayload) };
  const artifactPayload = {
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
    symbol: dataset.source.symbol,
    baseTimeframe: '1m',
    marketData: {
      firstCandleOpenTime: first + 2 * minute,
      lastCandleCloseTime: dataset.capturedThrough,
    },
    signals: [
      {
        sequence: 0,
        signalId: 'docker-e2e-enter',
        decisionId: 'docker-e2e-enter-decision',
        object: { model: 'PRICE_EVENT', id: 'docker-e2e-event' },
        action: 'ENTER',
        side: 'LONG',
        sourceCandleOpenTime: first + 3 * minute,
        decisionTime: first + 4 * minute,
        reasonCodes: ['EXECUTION_TRIGGERED'],
      },
      {
        sequence: 1,
        signalId: 'docker-e2e-exit',
        decisionId: 'docker-e2e-exit-decision',
        object: { model: 'PRICE_EVENT', id: 'docker-e2e-event' },
        action: 'EXIT',
        side: 'LONG',
        sourceCandleOpenTime: first + 6 * minute,
        decisionTime: first + 7 * minute,
        reasonCodes: ['TIME_STOP'],
      },
    ],
  };
  const artifact = { ...artifactPayload, artifactHash: signalArtifactHash(artifactPayload) };
  const riskPayload = {
    schemaVersion: 'helix.historical-risk-trace/v1',
    signalArtifactHash: artifact.artifactHash,
    entries: [{
      entrySignalId: artifact.signals[0].signalId,
      family: 'scalp',
      object: artifact.signals[0].object,
      side: artifact.signals[0].side,
      entryPrice: { source: 'DECISION_CANDLE_CLOSE', price: candles[3].close },
      initialStop: 101,
      initialTarget: 110,
      riskDistance: candles[3].close - 101,
      riskR: 0.35,
      scalp: {
        eventType: 'LIQUIDITY_SWEEP',
        grade: 'A',
        regime: { id: 'docker-e2e-regime', type: 'RANGING' },
      },
    }],
  };
  const riskTrace = { ...riskPayload, traceHash: historicalRiskTraceHash(riskPayload) };
  const planPayload = {
    schemaVersion: 'helix.walk-forward-plan/v1',
    mode: 'fixed_candidate',
    candidate: {
      strategyId: artifact.identity.strategyId,
      strategyVersion: artifact.identity.strategyVersion,
      strategyRepoCommit: artifact.identity.strategyRepoCommit,
      strategyConfigHash: artifact.identity.strategyConfigHash,
      engineCommit: artifact.identity.engineCommit,
      lifecycle: artifact.strategyLifecycle,
      objectModel: artifact.objectModel,
    },
    sourceDataset: {
      datasetHash: dataset.datasetHash,
      source: dataset.source,
      capturedThrough: dataset.capturedThrough,
    },
    baseTimeframe: artifact.baseTimeframe,
    requiredTimeframes: [artifact.baseTimeframe],
    activationDecisionTime: artifact.marketData.firstCandleOpenTime + minute,
    warmupDurationMs: 3 * minute,
    folds: [{
      sequence: 0,
      entryWindowStartTime: artifact.marketData.firstCandleOpenTime + minute,
      entryWindowEndTime: artifact.marketData.lastCandleCloseTime - 2 * minute,
      observationEndTime: artifact.marketData.lastCandleCloseTime,
    }],
    executionScenarios: [
      { id: 'base', fee: 0.001 },
      { id: 'fee_stress', fee: 0.002 },
    ],
  };
  const plan = { ...planPayload, planHash: walkForwardPlanHash(planPayload) };
  const runFold = {
    ...plan.folds[0],
    datasetFile: 'fold-000-dataset.json',
    datasetHash: dataset.datasetHash,
    decisionArtifactFile: 'fold-000-decision-artifact.json',
    decisionArtifactHash: artifact.artifactHash,
    decisionRiskTraceFile: 'fold-000-decision-risk-trace.json',
    decisionRiskTraceHash: riskTrace.traceHash,
    replayArtifactFile: 'fold-000-replay-artifact.json',
    replayArtifactHash: artifact.artifactHash,
    executionArtifactFile: 'fold-000-execution-artifact.json',
    executionArtifactHash: artifact.artifactHash,
    executionRiskTraceFile: 'fold-000-execution-risk-trace.json',
    executionRiskTraceHash: riskTrace.traceHash,
    tradeIds: [artifact.signals[0].signalId],
    censoredEntries: [],
    statistics: {
      decisionSignals: artifact.signals.length,
      entriesInWindow: 1,
      completedTrades: 1,
      censoredEntries: 0,
      evaluator: {},
    },
  };
  const runPayload = {
    schemaVersion: 'helix.walk-forward-run/v1',
    planFile: 'walk-forward-plan.json',
    planHash: plan.planHash,
    folds: [runFold],
  };
  return {
    dataset,
    artifact,
    riskTrace,
    plan,
    run: { ...runPayload, runHash: walkForwardRunHash(runPayload) },
  };
}

dockerTest('real Freqtrade executes a fee-stressed walk-forward bundle with exact reconciliation', async (t) => {
  const home = await mkdtemp(join(REPO_ROOT, '.helix-docker-e2e-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { dataset, artifact, riskTrace, plan, run } = fixtures();
  const datasetFile = join(home, 'source-dataset.json');
  const runFile = join(home, 'walk-forward-run.json');
  const envFile = join(home, '.helix', '.env');
  await mkdir(dirname(envFile), { recursive: true });
  await writeFile(envFile, [
    `FREQTRADE_PASSWORD=${sentinel}`,
    `FREQTRADE_JWT_SECRET=${sentinel}`,
    `OKX_API_KEY=${sentinel}`,
    `OKX_API_SECRET=${sentinel}`,
    `OKX_PASSWORD=${sentinel}`,
    `TELEGRAM_TOKEN=${sentinel}`,
    `WEBHOOK_URL=${sentinel}`,
    `DISCORD_WEBHOOK_URL=${sentinel}`,
    '',
  ].join('\n'), { mode: 0o600 });
  await writeFile(datasetFile, `${JSON.stringify(dataset, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(home, 'walk-forward-plan.json'), `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  await writeFile(runFile, `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(home, run.folds[0].datasetFile), `${JSON.stringify(dataset, null, 2)}\n`, { mode: 0o600 });
  for (const file of [
    run.folds[0].decisionArtifactFile,
    run.folds[0].replayArtifactFile,
    run.folds[0].executionArtifactFile,
  ]) await writeFile(join(home, file), `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  for (const file of [
    run.folds[0].decisionRiskTraceFile,
    run.folds[0].executionRiskTraceFile,
  ]) await writeFile(join(home, file), `${JSON.stringify(riskTrace, null, 2)}\n`, { mode: 0o600 });

  const { stdout } = await execFileAsync(process.execPath, [DEPLOY, 'walk_forward', JSON.stringify({
    walk_forward_run: runFile,
    source_dataset: datasetFile,
  })], {
    cwd: SKILL_DIR,
    env: {
      ...process.env,
      HOME: home,
      DOCKER_CONFIG: process.env.DOCKER_CONFIG || join(process.env.HOME || '', '.docker'),
      HELIX_FREQTRADE_RUNTIME: 'docker',
      FREQTRADE_PASSWORD: sentinel,
      FREQTRADE_JWT_SECRET: sentinel,
      OKX_API_KEY: sentinel,
      OKX_API_SECRET: sentinel,
      OKX_PASSWORD: sentinel,
      TELEGRAM_TOKEN: sentinel,
      WEBHOOK_URL: sentinel,
      DISCORD_WEBHOOK_URL: sentinel,
      FREQTRADE__EXCHANGE__KEY: sentinel,
      FREQTRADE__EXCHANGE__SECRET: sentinel,
      FREQTRADE__EXCHANGE__PASSWORD: sentinel,
      FREQTRADE__API_SERVER__PASSWORD: sentinel,
      FREQTRADE__API_SERVER__JWT_SECRET_KEY: sentinel,
      FREQTRADE__API_SERVER__WS_TOKEN: sentinel,
      FREQTRADE__TELEGRAM__TOKEN: sentinel,
      FREQTRADE__WEBHOOK__URL: sentinel,
      FREQTRADE__DISCORD__WEBHOOK_URL: sentinel,
    },
    timeout: 360_000,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.folds, 1);
  assert.equal(result.scenarios, 2);
  assert.equal(result.promotable, false);
  const report = verifyWalkForwardReport(
    JSON.parse(await readFile(result.reportFile, 'utf8')),
    null,
    dirname(result.reportFile),
  );
  assert.equal(report.reportHash, result.reportHash);
  assert.equal(report.folds[0].executionEvidence.length, 2);
  assert.equal(
    report.gate.checks.find(({ code }) => code === 'REQUIRED_METRICS_PRESENT').ok,
    true,
  );
  assert.equal(
    report.gate.checks.find(({ code }) => code === 'VERSIONED_GATE_POLICY_PRESENT').ok,
    false,
  );
  for (const evidence of report.folds[0].executionEvidence) {
    assert.deepEqual(evidence.reconciliation, {
      trades: 1,
      entries: 1,
      exits: 1,
      matchedSignals: 2,
    });
    assert.deepEqual(evidence.feeObservations, {
      status: 'OBSERVED',
      trades: 1,
      requestedFee: evidence.fee,
      openRates: [evidence.fee],
      closeRates: [evidence.fee],
      matchesRequested: true,
    });
    const resultFile = join(home, evidence.resultFile);
    assert.equal(resultFile.endsWith('.zip'), true);
    await assertZipDoesNotContain(resultFile, sentinel);
    assert.equal((await readFile(join(home, evidence.resultMetaFile))).length > 0, true);
    const runtimeEvidence = await readFile(join(home, evidence.runtimeEvidenceFile));
    assert.equal(runtimeEvidence.length > 0, true);
    assert.equal(runtimeEvidence.includes(Buffer.from(sentinel)), false);
  }
  const [baseEvidence, stressedEvidence] = report.folds[0].executionEvidence;
  assert.notEqual(baseEvidence.resultHash, stressedEvidence.resultHash);
  assert.equal(stressedEvidence.metrics.profitAbs < baseEvidence.metrics.profitAbs, true);
  assert.equal(
    stressedEvidence.metrics.riskNormalized.expectancyR
      < baseEvidence.metrics.riskNormalized.expectancyR,
    true,
  );
  const metrics = report.folds[0].executionEvidence[0].metrics;
  assert.equal(metrics.trades, 1);
  assert.equal(metrics.wins + metrics.draws + metrics.losses, metrics.trades);
  assert.equal(metrics.losses, 0);
  assert.equal(metrics.profitFactor, null);
  assert.equal(metrics.profitFactorStatus, 'NO_LOSSES');
  assert.equal(metrics.expectancyRatio, null);
  assert.equal(typeof metrics.expectancyAbs, 'number');
  assert.equal(typeof metrics.holdingSeconds, 'number');
  assert.equal(metrics.riskNormalized.available, true);
  assert.equal(metrics.riskNormalized.reason, 'NET_ACCOUNT_R_EXECUTION');
  assert.equal(typeof metrics.riskNormalized.expectancyR, 'number');
  assert.equal(typeof metrics.riskNormalized.maxDrawdownR, 'number');
  const [observation] = metrics.riskNormalized.observations;
  const actualAccountRiskR = observation.actualRiskBudget
    / (observation.accountEquity * observation.riskUnitRatio);
  assert.ok(Math.abs(metrics.riskNormalized.mfeR - actualAccountRiskR * (4 / 3)) < 1e-12);
  assert.ok(Math.abs(metrics.riskNormalized.maeR - actualAccountRiskR * (1 / 3)) < 1e-12);

  const evidence = JSON.parse(await readFile(
    join(home, '.freqtrade', 'user_data', 'backtest_results', '.helix-evidence.json'),
    'utf8',
  )).records;
  assert.equal(evidence.length, 2);
  for (const record of evidence) {
    assert.equal(record.marketDataset.datasetHash, dataset.datasetHash);
    assert.equal(record.marketDataset.warmupCandles, 2);
    assert.equal(record.marketDataset.activationCandleOpenTime, artifact.marketData.firstCandleOpenTime);
  }
});
