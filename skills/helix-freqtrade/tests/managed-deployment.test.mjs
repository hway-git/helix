import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { signalArtifactHash } from '../lib/signal-artifact.mjs';
import { walkForwardPortfolioPlanHash } from '../lib/walk-forward-portfolio.mjs';
import { createPromotableWalkForwardReport } from './helpers/promotable-report.mjs';

const execFileAsync = promisify(execFile);
const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY = resolve(SKILL_DIR, 'scripts', 'ft-deploy.mjs');

function sha256(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

async function waitUntil(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return false;
}

function artifactFixture() {
  const first = 1_782_864_000_000;
  const minute = 60_000;
  const payload = {
    schemaVersion: 'helix.signal-artifact/v1',
    identity: {
      strategyId: 'helix_scalp_hunter',
      strategyVersion: '1.0.1',
      strategyRepoCommit: 'a'.repeat(40),
      strategyConfigHash: `sha256:${'b'.repeat(64)}`,
      engineCommit: 'c'.repeat(40),
      marketDataSnapshotId: `sha256:${'d'.repeat(64)}`,
    },
    strategyLifecycle: 'shadow',
    objectModel: 'PRICE_EVENT',
    symbol: 'BTC/USDT:USDT',
    baseTimeframe: '1m',
    marketData: { firstCandleOpenTime: first, lastCandleCloseTime: first + 3 * minute },
    signals: [
      {
        sequence: 0,
        signalId: 'managed-enter-001',
        decisionId: 'managed-decision-001',
        object: { model: 'PRICE_EVENT', id: 'managed-event-001' },
        action: 'ENTER',
        side: 'LONG',
        sourceCandleOpenTime: first,
        decisionTime: first + minute,
        reasonCodes: ['EXECUTION_TRIGGERED'],
      },
      {
        sequence: 1,
        signalId: 'managed-exit-001',
        decisionId: 'managed-decision-002',
        object: { model: 'PRICE_EVENT', id: 'managed-event-001' },
        action: 'EXIT',
        side: 'LONG',
        sourceCandleOpenTime: first + 2 * minute,
        decisionTime: first + 3 * minute,
        reasonCodes: ['TIME_STOP'],
      },
    ],
  };
  return { ...payload, artifactHash: signalArtifactHash(payload) };
}

async function adapterFingerprint() {
  const hash = createHash('sha256');
  for (const name of ['HelixSignalStrategy.py', 'helix_signal_artifact.py', 'helix_signal_batch.py']) {
    hash.update(`/${name}\0`);
    hash.update(await readFile(resolve(SKILL_DIR, 'assets', name)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function listen(configFile, openTrades, apiCalls, {
  latchFile,
  latchOnStart = false,
  failBackupCleanupOnStart = false,
  initialEntryState = 'running',
  stopEntryChangesState = true,
  stopEntryFails = false,
} = {}) {
  let entryState = initialEntryState;
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && request.url === '/api/v1/show_config') {
      const config = JSON.parse(await readFile(configFile, 'utf8'));
      delete config.helix_signal_artifact_path;
      delete config.helix_signal_artifact_hash;
      response.end(JSON.stringify({ ...config, state: entryState }));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/v1/status') {
      response.end(JSON.stringify(openTrades));
      return;
    }
    if (request.method === 'POST' && ['/api/v1/stopentry', '/api/v1/start'].includes(request.url)) {
      apiCalls.push(request.url);
      if (request.url.endsWith('/start')) entryState = 'running';
      else if (stopEntryChangesState) entryState = 'stopped';
      if (latchOnStart && request.url.endsWith('/start')) {
        await writeFile(latchFile, `${JSON.stringify({ id: 'test-emergency', pid: process.pid, createdAt: Date.now() })}\n`);
      }
      if (failBackupCleanupOnStart && request.url.endsWith('/start')) {
        const journal = JSON.parse(await readFile(join(dirname(configFile), 'helix', 'deployment', 'transaction.json'), 'utf8'));
        const backup = journal.snapshots.find((snapshot) => snapshot.backup)?.backup;
        assert.equal(typeof backup, 'string');
        await rm(backup, { force: true });
        await mkdir(backup);
        await writeFile(join(backup, 'keep'), 'force cleanup failure');
      }
      if (stopEntryFails && request.url.endsWith('/stopentry')) {
        response.statusCode = 503;
        response.end('{"error":"ambiguous stop response"}');
        return;
      }
      response.end('{}');
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
    }),
  };
}

async function setupManagedDeployment(t, {
  failFirstUp = false,
  failBackupCleanupOnStart = false,
  openTrades = [],
  latchOnStart = false,
  initialEntryState = 'running',
  stopEntryChangesState = true,
  stopEntryFails = false,
} = {}) {
  const home = await mkdtemp(join(tmpdir(), 'helix-managed-deploy-'));
  const userData = join(home, '.freqtrade', 'user_data');
  t.after(async () => {
    try {
      const roots = await readdir(join(userData, 'helix', 'forward'), { withFileTypes: true });
      for (const root of roots) {
        if (!root.isDirectory()) continue;
        const content = (await readFile(join(userData, 'helix', 'forward', root.name, 'worker.pid'), 'utf8')).trim();
        const pid = content ? JSON.parse(content).pid : null;
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 'SIGTERM'); } catch {}
        }
      }
    } catch {}
    await rm(home, { recursive: true, force: true });
  });
  const resultsDir = join(userData, 'backtest_results');
  const signalDir = join(userData, 'helix', 'signals');
  const configFile = join(userData, 'config.json');
  const binDir = join(home, 'bin');
  const dockerLog = join(home, 'docker.log');
  const dockerState = join(home, 'docker-up.state');
  const failNextUp = join(home, 'fail-next-up');
  await mkdir(resultsDir, { recursive: true });
  await mkdir(signalDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(join(home, '.helix'), { recursive: true });
  await writeFile(join(home, '.helix', '.env'), 'FREQTRADE_PASSWORD=test-only\n');

  const initialConfig = {
    strategy: 'OldStrategy',
    dry_run: true,
    initial_state: initialEntryState,
    timeframe: '5m',
    max_open_trades: 1,
    tradable_balance_ratio: 1,
    dry_run_wallet: 1000,
    exchange: { name: 'okx', pair_whitelist: ['ETH/USDT:USDT'] },
  };
  const initialConfigContent = `${JSON.stringify(initialConfig, null, 2)}\n`;
  await writeFile(configFile, initialConfigContent);

  const artifact = artifactFixture();
  const artifactFile = join(signalDir, `${artifact.artifactHash.replace(':', '-')}.json`);
  const artifactContent = `${JSON.stringify(artifact, null, 2)}\n`;
  await writeFile(artifactFile, artifactContent, { mode: 0o600 });
  const { report, reportFile } = await createPromotableWalkForwardReport(join(home, 'walk-forward'), artifact);
  const reportIndexFile = join(userData, 'helix', 'validation', 'walk-forward-reports.json');
  await mkdir(dirname(reportIndexFile), { recursive: true });
  await writeFile(reportIndexFile, JSON.stringify({
    version: 1,
    records: [{
      reportHash: report.reportHash,
      reportFile,
      candidate: report.candidate,
      createdAt: '2026-07-17T00:00:00.000Z',
    }],
  }));
  const resultFile = 'backtest-result-managed.json';
  const resultMetaFile = 'backtest-result-managed.meta.json';
  const resultContent = JSON.stringify({
    strategy: {
      HelixSignalStrategy: {
        total_trades: 1,
        profit_total: 0.01,
        profit_total_abs: 10,
        trades: [{
          pair: artifact.symbol,
          is_short: false,
          is_open: false,
          open_timestamp: artifact.signals[0].decisionTime,
          close_timestamp: artifact.signals[1].decisionTime,
          enter_tag: artifact.signals[0].signalId,
          exit_reason: artifact.signals[1].signalId,
        }],
      },
    },
  });
  const metaContent = JSON.stringify({ HelixSignalStrategy: { run_id: 'managed-test', timeframe: '1m' } });
  await writeFile(join(resultsDir, resultFile), resultContent);
  await writeFile(join(resultsDir, resultMetaFile), metaContent);
  const evidenceFile = join(resultsDir, '.helix-evidence.json');
  await writeFile(evidenceFile, JSON.stringify({
    version: 2,
    records: [{
      id: 'managed-evidence',
      strategy: 'HelixSignalStrategy',
      strategyHash: await adapterFingerprint(),
      timeframe: '1m',
      timerange: '',
      pairs: [artifact.symbol],
      resultFile,
      resultMetaFile,
      resultHash: sha256(resultContent),
      resultMetaHash: sha256(metaContent),
      metrics: { trades: 1, profitPct: 0.01 },
      signalArtifact: {
        artifactHash: artifact.artifactHash,
        schemaVersion: artifact.schemaVersion,
        strategyLifecycle: artifact.strategyLifecycle,
        identity: {
          strategyId: artifact.identity.strategyId,
          strategyVersion: artifact.identity.strategyVersion,
          strategyRepoCommit: artifact.identity.strategyRepoCommit,
          strategyConfigHash: artifact.identity.strategyConfigHash,
          engineCommit: artifact.identity.engineCommit,
        },
        marketDataSnapshotId: artifact.identity.marketDataSnapshotId,
        symbol: artifact.symbol,
        baseTimeframe: artifact.baseTimeframe,
        marketData: artifact.marketData,
        signalCount: artifact.signals.length,
      },
      marketDataset: { datasetHash: artifact.identity.marketDataSnapshotId },
      executionEnvironment: {
        freqtradeVersion: 'freqtrade test',
        configHash: sha256(initialConfigContent),
        artifactFileHash: sha256(artifactContent),
        riskTraceHash: sha256('managed-risk-trace'),
        riskTraceFileHash: sha256('managed-risk-trace-file'),
        riskUnitRatio: 0.01,
        fee: 0.001,
        dataFormatOhlcv: 'json',
        executionProfile: {
          schemaVersion: 'helix.freqtrade-execution-profile/v1',
          strategy: 'HelixSignalStrategy',
          timeframe: artifact.baseTimeframe,
          pairs: [artifact.symbol],
          exchange: 'okx',
          tradingMode: '',
          marginMode: '',
          maxOpenTrades: 1,
          stakeCurrency: '',
          stakeAmount: null,
          tradableBalanceRatio: 1,
          dryRunWallet: 1000,
          fee: 0.001,
          entryPricing: null,
          exitPricing: null,
          orderTypes: null,
          orderTimeInForce: null,
          unfilledTimeout: null,
          positionAdjustmentEnabled: null,
          maxEntryPositionAdjustment: null,
        },
      },
      createdAt: '2026-07-16T00:00:00.000Z',
    }],
  }));

const dockerScript = `#!/bin/sh
echo "$@" >> "$HELIX_TEST_DOCKER_LOG"
case " $* " in
  *" --version "*)
    echo "freqtrade test"
    exit 0
    ;;
esac
case " $* " in
  *" up "*)
    if [ -f "$HELIX_TEST_FAIL_NEXT_UP" ]; then
      rm "$HELIX_TEST_FAIL_NEXT_UP"
      exit 1
    fi
    if [ "$HELIX_TEST_FAIL_FIRST_UP" = "1" ] && [ ! -f "$HELIX_TEST_DOCKER_STATE" ]; then
      touch "$HELIX_TEST_DOCKER_STATE"
      exit 1
    fi
    ;;
esac
exit 0
`;
  const dockerBin = join(binDir, 'docker');
  await writeFile(dockerBin, dockerScript);
  await chmod(dockerBin, 0o755);
  const forwardWorkerFile = join(home, 'fake-forward-worker.cjs');
  await writeFile(forwardWorkerFile, `
const { readFileSync, writeFileSync } = require('node:fs');
const params = JSON.parse(process.argv.at(-1));
const deployment = JSON.parse(readFileSync(params.deployment, 'utf8'));
writeFileSync(params.status, JSON.stringify({
  schemaVersion: 'helix.forward-worker-status/v1',
  deploymentHash: deployment.deploymentHash,
  state: 'waiting',
  pid: params.statusPid || process.pid,
  updatedAt: Date.now(),
  lastDecisionTime: null,
  lastMarketSnapshotId: null,
  lastBatchHash: null,
  batches: 0,
  error: null,
}));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`);
  const apiCalls = [];
  const latchFile = join(userData, 'helix', 'deployment', 'emergency-stop.json');
  const mock = await listen(configFile, openTrades, apiCalls, {
    latchFile,
    latchOnStart,
    failBackupCleanupOnStart,
    initialEntryState,
    stopEntryChangesState,
    stopEntryFails,
  });
  t.after(mock.close);

  const runAction = (action, params) => {
    const args = [DEPLOY, action];
    if (params !== undefined) args.push(JSON.stringify(params));
    return execFileAsync(process.execPath, args, {
      cwd: SKILL_DIR,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}:${process.env.PATH}`,
        HELIX_FREQTRADE_RUNTIME: 'docker',
        FREQTRADE_URL: mock.url,
        FREQTRADE_USERNAME: 'freqtrade',
        FREQTRADE_PASSWORD: 'test-only',
        HELIX_TEST_DOCKER_LOG: dockerLog,
        HELIX_TEST_DOCKER_STATE: dockerState,
        HELIX_TEST_FAIL_FIRST_UP: failFirstUp ? '1' : '',
        HELIX_TEST_FAIL_NEXT_UP: failNextUp,
        HELIX_TEST_ENTRY_TIMEOUT_MS: '300',
        HELIX_TEST_FORWARD_WORKER_FILE: forwardWorkerFile,
      },
    });
  };
  const run = () => runAction('deploy', {
    signal_artifact_hash: artifact.artifactHash,
    walk_forward_report: reportFile,
    dry_run: true,
    max_open_trades: 1,
  });
  const runForward = run;
  return {
    run,
    runForward,
    runAction,
    home,
    userData,
    configFile,
    dockerLog,
    failNextUp,
    artifact,
    artifactFile,
    reportFile,
    reportIndexFile,
    evidenceFile,
    initialConfig,
    apiCalls,
  };
}

test('managed deployment commits an immutable artifact pointer only after the flat gate', async (t) => {
  const setup = await setupManagedDeployment(t);
  const candidates = JSON.parse((await setup.runAction('backtest_results')).stdout);
  assert.equal(candidates.evidence[0].walkForwardReport.reportFile, setup.reportFile);
  const { stdout } = await setup.run();
  const result = JSON.parse(stdout);
  assert.equal(result.success, true);
  assert.equal(result.signal_artifact.hash, setup.artifact.artifactHash);
  const config = JSON.parse(await readFile(setup.configFile, 'utf8'));
  assert.equal(config.strategy, 'HelixSignalStrategy');
  assert.equal(config.fee, 0.001);
  assert.equal(config.helix_signal_artifact_hash, setup.artifact.artifactHash);
  assert.equal(config.helix_signal_walk_forward_report_hash, result.walk_forward_report.hash);
  assert.equal(
    config.helix_signal_artifact_path,
    `/freqtrade/user_data/helix/signals/${setup.artifact.artifactHash.replace(':', '-')}.json`,
  );
  await assert.rejects(readFile(join(setup.userData, 'helix', 'signals', 'active.json')), /ENOENT/);
  const journal = JSON.parse(await readFile(join(setup.userData, 'helix', 'deployment', 'transaction.json'), 'utf8'));
  assert.equal(journal.phase, 'ACTIVE');
  assert.deepEqual(await readdir(join(setup.userData, 'helix', 'deployment', 'backups')), []);
  const dockerCalls = await readFile(setup.dockerLog, 'utf8');
  assert.match(dockerCalls, / stop freqtrade/);
  assert.match(dockerCalls, / up -d --no-deps freqtrade/);
});

test('managed portfolio deployment stops its watchdog after nested archive tampering', async (t) => {
  const setup = await setupManagedDeployment(t);
  const sources = [
    { provider: 'okx', market: 'futures', instrumentId: 'BTC-USDT-SWAP', symbol: 'BTC/USDT:USDT' },
    { provider: 'okx', market: 'futures', instrumentId: 'ETH-USDT-SWAP', symbol: 'ETH/USDT:USDT' },
  ];
  const members = await Promise.all(sources.map((source, index) => createPromotableWalkForwardReport(
    join(setup.home, `portfolio-source-${index}`),
    { ...setup.artifact, symbol: source.symbol },
    { source, symbolStabilityMembers: sources, minimumStableSymbolRatio: 1 },
  )));
  const reference = members[0].bundle.plan;
  const bySymbol = new Map(members.map((member) => [member.bundle.plan.sourceDataset.source.symbol, member]));
  const planPayload = {
    schemaVersion: 'helix.walk-forward-portfolio-plan/v1',
    mode: 'fixed_candidate_multi_symbol',
    candidate: reference.candidate,
    walkForwardPolicy: reference.walkForwardPolicy,
    members: sources.map((source) => {
      const member = bySymbol.get(source.symbol);
      return {
        source,
        sourceDatasetHash: member.bundle.plan.sourceDataset.datasetHash,
        capturedThrough: member.bundle.plan.sourceDataset.capturedThrough,
        planHash: member.bundle.plan.planHash,
        runHash: member.bundle.run.runHash,
      };
    }),
    baseTimeframe: reference.baseTimeframe,
    requiredTimeframes: reference.requiredTimeframes,
    activationDecisionTime: reference.activationDecisionTime,
    warmupDurationMs: reference.warmupDurationMs,
    folds: reference.folds,
    executionScenarios: reference.executionScenarios,
  };
  const portfolioPlan = { ...planPayload, planHash: walkForwardPortfolioPlanHash(planPayload) };
  const portfolioPlanFile = join(setup.home, 'portfolio-plan.json');
  await writeFile(portfolioPlanFile, `${JSON.stringify(portfolioPlan, null, 2)}\n`);
  const portfolio = JSON.parse((await setup.runAction('walk_forward_portfolio', {
    portfolio_plan: portfolioPlanFile,
    reports: members.map(({ reportFile }) => reportFile).reverse(),
    output_directory: join(setup.home, 'portfolio-report'),
  })).stdout);
  assert.equal(portfolio.promotable, true);

  const result = JSON.parse((await setup.runAction('deploy', {
    signal_artifact_hash: setup.artifact.artifactHash,
    walk_forward_report: portfolio.reportFile,
    dry_run: true,
    max_open_trades: 1,
  })).stdout);
  assert.equal(result.success, true);
  assert.equal(result.walk_forward_report.hash, portfolio.reportHash);
  const config = JSON.parse(await readFile(setup.configFile, 'utf8'));
  assert.equal(config.helix_signal_walk_forward_report_hash, portfolio.reportHash);

  const portfolioReport = JSON.parse(await readFile(portfolio.reportFile, 'utf8'));
  const memberFile = resolve(dirname(portfolio.reportFile), portfolioReport.members[0].reportFile);
  const memberReport = JSON.parse(await readFile(memberFile, 'utf8'));
  const nestedEvidence = resolve(dirname(memberFile), memberReport.coreEvidence.files[0].file);
  await writeFile(nestedEvidence, 'tampered\n');
  assert.equal(await waitUntil(() => !processIsAlive(result.forward_runtime.worker_pid)), true);
});

test('managed Signal deployment rejects a missing promotable walk-forward report', async (t) => {
  const setup = await setupManagedDeployment(t);
  await assert.rejects(setup.runAction('deploy', {
    signal_artifact_hash: setup.artifact.artifactHash,
    dry_run: true,
    max_open_trades: 1,
  }), (error) => {
    assert.match(error.stderr, /requires a promotable walk_forward_report/);
    return true;
  });
});

test('managed forward deployment verifies its worker before activating entries', async (t) => {
  const setup = await setupManagedDeployment(t);
  const { stdout } = await setup.runForward();
  const result = JSON.parse(stdout);
  assert.equal(result.success, true);
  assert.equal(result.forward_runtime.state, 'waiting');
  assert.equal(Number.isSafeInteger(result.forward_runtime.worker_pid), true);
  const config = JSON.parse(await readFile(setup.configFile, 'utf8'));
  assert.equal(config.helix_signal_forward_deployment_hash, result.forward_runtime.deployment_hash);
  assert.match(config.helix_signal_forward_deployment_path, /\/helix\/forward\/[^/]+\/deployment\.json$/);
  assert.match(config.helix_signal_batch_path, /\/helix\/forward\/[^/]+\/batches$/);
  assert.match(config.helix_signal_forward_status_path, /\/helix\/forward\/[^/]+\/status\.json$/);
  const deployment = JSON.parse(await readFile(result.forward_runtime.deployment_file, 'utf8'));
  assert.equal(deployment.deploymentHash, result.forward_runtime.deployment_hash);
  assert.equal(deployment.mode, 'dry_run');
  assert.equal(deployment.walkForwardReportHash, result.walk_forward_report.hash);
  assert.equal(setup.apiCalls.at(-1), '/api/v1/start');
  const status = JSON.parse((await setup.runAction('status')).stdout);
  assert.equal(status.forward_runtime.running, true);
  assert.equal(status.forward_runtime.state, 'waiting');
  assert.equal(status.forward_runtime.deployment_hash, result.forward_runtime.deployment_hash);

  const statusFile = join(dirname(result.forward_runtime.deployment_file), 'status.json');
  const heartbeat = JSON.parse(await readFile(statusFile, 'utf8'));
  await writeFile(statusFile, JSON.stringify({ ...heartbeat, deploymentHash: `sha256:${'f'.repeat(64)}` }));
  const invalidStatus = JSON.parse((await setup.runAction('status')).stdout);
  assert.equal(invalidStatus.forward_runtime.state, 'error');
  assert.match(invalidStatus.forward_runtime.error, /belongs to another deployment/);
  await writeFile(statusFile, JSON.stringify(heartbeat));

  const stopped = JSON.parse((await setup.runAction('stop')).stdout);
  assert.equal(stopped.forward_worker_pid, result.forward_runtime.worker_pid);
  for (let attempt = 0; attempt < 40 && processIsAlive(result.forward_runtime.worker_pid); attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  assert.equal(processIsAlive(result.forward_runtime.worker_pid), false);

  const started = JSON.parse((await setup.runAction('start', {})).stdout);
  assert.equal(started.started, true);
  assert.equal(started.forward_runtime.state, 'waiting');
  assert.notEqual(started.forward_runtime.pid, result.forward_runtime.worker_pid);
  await setup.runAction('stop');
});

test('managed forward rollback restores the previous worker before reopening old entries', async (t) => {
  const setup = await setupManagedDeployment(t);
  const first = JSON.parse((await setup.runForward()).stdout);
  const firstConfig = await readFile(setup.configFile, 'utf8');
  await writeFile(setup.failNextUp, 'fail candidate');

  await assert.rejects(setup.runForward(), (error) => {
    assert.match(error.stderr, /Deployment failed and was rolled back/);
    return true;
  });
  assert.equal(await readFile(setup.configFile, 'utf8'), firstConfig);
  const runtimeRoot = dirname(first.forward_runtime.deployment_file);
  const restoredPid = JSON.parse(await readFile(join(runtimeRoot, 'worker.pid'), 'utf8')).pid;
  assert.equal(processIsAlive(first.forward_runtime.worker_pid), false);
  assert.equal(processIsAlive(restoredPid), true);
  assert.notEqual(restoredPid, first.forward_runtime.worker_pid);
  assert.equal(setup.apiCalls.at(-1), '/api/v1/start');
  await setup.runAction('stop');
});

test('managed forward stop refuses mismatched PID ownership metadata while the watchdog fails closed', async (t) => {
  const setup = await setupManagedDeployment(t);
  const deployed = JSON.parse((await setup.run()).stdout);
  const runtimeRoot = dirname(deployed.forward_runtime.deployment_file);
  const pidFile = join(runtimeRoot, 'worker.pid');
  const owner = JSON.parse(await readFile(pidFile, 'utf8'));
  await writeFile(pidFile, JSON.stringify({ ...owner, deploymentHash: `sha256:${'f'.repeat(64)}` }));

  await assert.rejects(setup.runAction('stop'), (error) => {
    assert.match(error.stderr, /PID metadata does not match its deployment/);
    return true;
  });
  for (let attempt = 0; attempt < 40 && processIsAlive(owner.pid); attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  assert.equal(processIsAlive(owner.pid), false);
  await writeFile(pidFile, JSON.stringify(owner));
  await setup.runAction('stop');
});

test('Docker update recreates the daemon with entries stopped', async (t) => {
  const setup = await setupManagedDeployment(t);
  await setup.run();
  setup.apiCalls.length = 0;
  const { stdout } = await setup.runAction('update');
  const result = JSON.parse(stdout);
  assert.equal(result.updated, true);
  assert.equal(result.entries_stopped, true);
  assert.equal(Number.isSafeInteger(result.forward_worker_pid), true);
  assert.equal(processIsAlive(result.forward_worker_pid), false);
  assert.deepEqual(setup.apiCalls, ['/api/v1/stopentry']);
  assert.equal(JSON.parse(await readFile(setup.configFile, 'utf8')).initial_state, 'stopped');
  const dockerCalls = await readFile(setup.dockerLog, 'utf8');
  assert.match(dockerCalls, / pull freqtrade/);
  assert.match(dockerCalls, / up -d freqtrade/);
});

test('managed deployment rejects stale Freqtrade version, execution profile, and Artifact file evidence', async (t) => {
  const setup = await setupManagedDeployment(t);
  const originalEvidence = JSON.parse(await readFile(setup.evidenceFile, 'utf8'));

  const staleVersion = structuredClone(originalEvidence);
  staleVersion.records[0].executionEnvironment.freqtradeVersion = 'freqtrade old';
  await writeFile(setup.evidenceFile, JSON.stringify(staleVersion));
  await assert.rejects(setup.run(), (error) => {
    assert.match(error.stderr, /used Freqtrade freqtrade old, current runtime is freqtrade test/);
    return true;
  });

  const staleProfile = structuredClone(originalEvidence);
  staleProfile.records[0].executionEnvironment.executionProfile.stakeAmount = 100;
  await writeFile(setup.evidenceFile, JSON.stringify(staleProfile));
  await assert.rejects(setup.run(), (error) => {
    assert.match(error.stderr, /execution profile does not match/);
    return true;
  });

  await writeFile(setup.evidenceFile, JSON.stringify(originalEvidence));
  await writeFile(setup.artifactFile, `${await readFile(setup.artifactFile, 'utf8')}\n`);
  await assert.rejects(setup.run(), (error) => {
    assert.match(error.stderr, /Artifact file hash does not match/);
    return true;
  });
});

test('managed deployment rejects open trades without touching config or service', async (t) => {
  const setup = await setupManagedDeployment(t, { openTrades: [{ trade_id: 1 }] });
  await assert.rejects(setup.run(), (error) => {
    assert.match(error.stderr, /requires a flat bot; 1 open trade/);
    return true;
  });
  assert.deepEqual(JSON.parse(await readFile(setup.configFile, 'utf8')), setup.initialConfig);
  assert.doesNotMatch(await readFile(setup.dockerLog, 'utf8'), / (?:stop|up) /);
  assert.deepEqual(setup.apiCalls, ['/api/v1/stopentry', '/api/v1/start']);
});

test('managed deployment preserves an emergency latch when the flat gate fails', async (t) => {
  const setup = await setupManagedDeployment(t, { openTrades: [{ trade_id: 1 }] });
  const latchFile = join(setup.userData, 'helix', 'deployment', 'emergency-stop.json');
  await mkdir(dirname(latchFile), { recursive: true });
  await writeFile(latchFile, JSON.stringify({ id: 'prior-emergency', pid: 999_999_999, createdAt: 0 }));

  await assert.rejects(setup.run(), /requires a flat bot; 1 open trade/);
  assert.equal(JSON.parse(await readFile(latchFile, 'utf8')).id, 'prior-emergency');
  assert.equal(setup.apiCalls.includes('/api/v1/start'), false);
});

test('managed deployment clears a prior emergency latch only at verified activation', async (t) => {
  const setup = await setupManagedDeployment(t);
  const latchFile = join(setup.userData, 'helix', 'deployment', 'emergency-stop.json');
  await mkdir(dirname(latchFile), { recursive: true });
  await writeFile(latchFile, JSON.stringify({ id: 'prior-emergency', pid: 999_999_999, createdAt: 0 }));

  const { stdout } = await setup.run();
  assert.equal(JSON.parse(stdout).success, true);
  await assert.rejects(readFile(latchFile, 'utf8'), /ENOENT/);
  assert.equal(setup.apiCalls.at(-1), '/api/v1/start');
});

test('managed flat gate accepts an ambiguous stop response only after state confirmation', async (t) => {
  const setup = await setupManagedDeployment(t, { stopEntryFails: true });
  const { stdout } = await setup.run();
  assert.equal(JSON.parse(stdout).success, true);
  assert.equal(setup.apiCalls[0], '/api/v1/stopentry');
});

test('managed flat gate rejects a successful stop response when entries remain running', async (t) => {
  const setup = await setupManagedDeployment(t, { stopEntryChangesState: false });
  await assert.rejects(setup.run(), (error) => {
    assert.match(error.stderr, /entry state confirmation failed/);
    return true;
  });
  assert.deepEqual(JSON.parse(await readFile(setup.configFile, 'utf8')), setup.initialConfig);
  assert.doesNotMatch(await readFile(setup.dockerLog, 'utf8'), / (?:stop|up) /);
});

test('managed deployment restores the prior config when candidate start fails', async (t) => {
  const setup = await setupManagedDeployment(t, { failFirstUp: true });
  await assert.rejects(setup.run(), (error) => {
    assert.match(error.stderr, /Deployment failed and was rolled back/);
    return true;
  });
  assert.deepEqual(JSON.parse(await readFile(setup.configFile, 'utf8')), setup.initialConfig);
  const journal = JSON.parse(await readFile(join(setup.userData, 'helix', 'deployment', 'transaction.json'), 'utf8'));
  assert.equal(journal.phase, 'ROLLED_BACK');
  assert.deepEqual(await readdir(join(setup.userData, 'helix', 'deployment', 'backups')), []);
  const dockerCalls = (await readFile(setup.dockerLog, 'utf8')).split('\n').filter(Boolean);
  assert.equal(dockerCalls.filter((call) => call.includes(' up ')).length, 2);
});

test('managed rollback preserves a previously stopped entry state', async (t) => {
  const setup = await setupManagedDeployment(t, { failFirstUp: true, initialEntryState: 'stopped' });
  await assert.rejects(setup.run(), /Deployment failed and was rolled back/);
  assert.deepEqual(JSON.parse(await readFile(setup.configFile, 'utf8')), setup.initialConfig);
  assert.equal(setup.apiCalls.includes('/api/v1/start'), false);
});

test('managed deployment compensates when emergency stop latches during entry activation', async (t) => {
  const setup = await setupManagedDeployment(t, { latchOnStart: true });
  await assert.rejects(setup.run(), (error) => {
    assert.match(error.stderr, /deployment aborted by emergency stop latch/);
    assert.match(error.stderr, /target remains committed with entries stopped/);
    return true;
  });
  const config = JSON.parse(await readFile(setup.configFile, 'utf8'));
  assert.equal(config.strategy, 'HelixSignalStrategy');
  assert.equal(config.initial_state, 'stopped');
  const journal = JSON.parse(await readFile(join(setup.userData, 'helix', 'deployment', 'transaction.json'), 'utf8'));
  assert.equal(journal.phase, 'ACTIVE');
  assert.deepEqual(await readdir(join(setup.userData, 'helix', 'deployment', 'backups')), []);
  assert.deepEqual(setup.apiCalls.slice(-3), ['/api/v1/start', '/api/v1/stopentry', '/api/v1/stopentry']);
});

test('managed ACTIVE cleanup failure restores the latch and stops entries', async (t) => {
  const setup = await setupManagedDeployment(t, { failBackupCleanupOnStart: true });
  const latchFile = join(setup.userData, 'helix', 'deployment', 'emergency-stop.json');
  await mkdir(dirname(latchFile), { recursive: true });
  await writeFile(latchFile, JSON.stringify({ id: 'prior-emergency', pid: 999_999_999, createdAt: 0 }));

  await assert.rejects(setup.run(), (error) => {
    assert.match(error.stderr, /target remains committed with entries stopped/);
    return true;
  });
  assert.notEqual(JSON.parse(await readFile(latchFile, 'utf8')).id, 'prior-emergency');
  assert.equal(JSON.parse(await readFile(setup.configFile, 'utf8')).initial_state, 'stopped');
  const journal = JSON.parse(await readFile(join(setup.userData, 'helix', 'deployment', 'transaction.json'), 'utf8'));
  assert.equal(journal.phase, 'ACTIVE');
  assert.deepEqual(setup.apiCalls.slice(-2), ['/api/v1/start', '/api/v1/stopentry']);
});

test('managed PREPARED recovery keeps old entries stopped until candidate activation', async (t) => {
  const setup = await setupManagedDeployment(t);
  await setup.run();
  const journalFile = join(setup.userData, 'helix', 'deployment', 'transaction.json');
  const journal = JSON.parse(await readFile(journalFile, 'utf8'));
  await writeFile(journalFile, JSON.stringify({ ...journal, phase: 'PREPARED' }));
  setup.apiCalls.length = 0;

  await setup.run();
  assert.deepEqual(setup.apiCalls, [
    '/api/v1/stopentry',
    '/api/v1/stopentry',
    '/api/v1/start',
  ]);
});

test('managed COMMITTED recovery restarts the previous daemon with entries stopped', async (t) => {
  const setup = await setupManagedDeployment(t);
  const first = JSON.parse((await setup.run()).stdout);
  const journalFile = join(setup.userData, 'helix', 'deployment', 'transaction.json');
  const journal = JSON.parse(await readFile(journalFile, 'utf8'));
  for (const snapshot of journal.snapshots) {
    if (!snapshot.existed || !snapshot.backup) continue;
    await mkdir(dirname(snapshot.backup), { recursive: true });
    const content = snapshot.file === setup.configFile
      ? `${JSON.stringify(setup.initialConfig, null, 2)}\n`
      : await readFile(snapshot.file);
    await writeFile(snapshot.backup, content, { mode: snapshot.mode ?? 0o600 });
  }
  await writeFile(journalFile, JSON.stringify({ ...journal, phase: 'COMMITTED' }));
  setup.apiCalls.length = 0;

  await setup.run();
  assert.equal(processIsAlive(first.forward_runtime.worker_pid), false);
  assert.equal(setup.apiCalls.filter((call) => call === '/api/v1/start').length, 1);
  assert.equal(setup.apiCalls.at(-1), '/api/v1/start');
});

test('managed recovery removes backups left after a terminal transaction', async (t) => {
  const setup = await setupManagedDeployment(t);
  await setup.run();
  const journalFile = join(setup.userData, 'helix', 'deployment', 'transaction.json');
  const journal = JSON.parse(await readFile(journalFile, 'utf8'));
  const backup = journal.snapshots.find((snapshot) => snapshot.backup)?.backup;
  assert.equal(typeof backup, 'string');
  await writeFile(backup, 'sensitive-test-config');

  await setup.run();
  await assert.rejects(readFile(backup), /ENOENT/);
});
