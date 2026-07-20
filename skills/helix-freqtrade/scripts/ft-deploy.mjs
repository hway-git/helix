#!/usr/bin/env node
// ft-deploy.mjs — strategy lifecycle, backtest, hyperopt.
//
// 三套运行模式自动切换:
//   - CoinClaw 容器内 (OpenClaw / Hermes / Claude Code): freqtrade 已是
//     supervisord 管的常驻 daemon, 本脚本"部署策略" = 写策略文件 +
//     改 config.strategy + 重启 daemon. 不再 git clone freqtrade,
//     不再 nohup 后台进程, 不跟 daemon 抢 8888 端口.
//   - 本机 Docker: daemon 由 docker/freqtrade/compose.yaml 管理, CLI 工作
//     使用同一镜像的一次性容器, 与 daemon 共享 ~/.freqtrade/user_data.
//   - host 模式 (用户本地 macOS / Linux): 沿用老路径, 自己 clone freqtrade,
//     起后台进程, 写 PID file. 这条路在 coinclaw 之外仍然有效.
//
// coinclaw 模式下 strategy / backtest / 配置变更 都通过容器里预装的
// freqtrade CLI + freqtrade REST API 完成, 跟 dashboard 看到的状态保持一致.
import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
  readdirSync, renameSync, chmodSync, openSync, closeSync, unlinkSync,
} from 'node:fs';
import { basename, resolve, dirname } from 'node:path';
import { execFileSync, execSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import {
  coinclawEnv, dockerFreqtradeEnv, hostModeFreqtradePaths, envFileCandidates, supervisorSocket,
} from '../lib/coinclaw-env.mjs';
import { ftGet, ftPost } from '../lib/freqtrade-api.mjs';
import {
  buildStrategyCode,
  AVAILABLE_INDICATORS,
} from '../lib/strategy-builder.mjs';
import {
  HELIX_SIGNAL_STRATEGY,
  loadSignalArtifact,
  pinnedSignalIdentity,
  samePinnedSignalIdentity,
  verifySignalArtifact,
} from '../lib/signal-artifact.mjs';
import {
  freqtradeOhlcvFile,
  loadMarketDataset,
  marketTimeframeMilliseconds,
  requireMarketDatasetArtifactWindow,
} from '../lib/market-dataset.mjs';
import { reconcileSignalBacktest } from '../lib/backtest-reconciliation.mjs';
import { backtestFeeObservations, backtestMetrics } from '../lib/backtest-metrics.mjs';
import { verifyHistoricalRiskTrace } from '../lib/historical-risk.mjs';
import { firstStrategySummary, readBacktestPayload } from '../lib/backtest-result.mjs';
import {
  SIGNAL_ADAPTER_FILE_NAMES,
  createExecutionRuntimeEvidence,
  createSecretFreeBacktestConfig,
  executionConfigIdentity,
  executionConfigIdentityHash,
  secretFreeBacktestEnvironment,
  secretFreeDockerEnvironmentArguments,
  signalAdapterBundleFromDirectory,
  signalExecutionProfile as createRuntimeExecutionProfile,
} from '../lib/execution-runtime-evidence.mjs';
import {
  createWalkForwardReport,
  loadWalkForwardBundle,
  verifyWalkForwardReport,
  walkForwardEvidenceHash,
} from '../lib/walk-forward.mjs';
import {
  createWalkForwardPortfolioReport,
  loadPromotableWalkForwardEvidence,
  verifyWalkForwardPortfolioPlan,
  verifyWalkForwardPortfolioReport,
} from '../lib/walk-forward-portfolio.mjs';
import {
  createForwardDeployment,
  createForwardWorkerOwner,
  createForwardWorkerOwnerToken,
  forwardWorkerOwnerMatchesProcess,
  verifyForwardDeployment,
  verifyForwardWorkerOwner,
} from '../lib/forward-runtime.mjs';
import {
  beginDeploymentTransaction,
  cleanupDeploymentBackups,
  clearEmergencyStopLatch,
  deploymentTransactionIsIncomplete,
  emergencyStopIsLatched,
  readDeploymentTransaction,
  requireHealthyDeploymentTransaction,
  requireNoEmergencyStop,
  restoreDeploymentFiles,
  setEmergencyStopLatch,
  signalArtifactArchivePath,
  updateDeploymentTransaction,
  withBacktestLock,
  withDeploymentLock,
  withEntryTransitionLock,
  writeDeploymentFile,
} from '../lib/deployment-transaction.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const DEPLOY_SCRIPT_FILE = fileURLToPath(import.meta.url);

// ─── 模式 / 路径解析 ─────────────────────────────────────────────
const COINCLAW_ENV = coinclawEnv();
const DOCKER_ENV = COINCLAW_ENV ? null : dockerFreqtradeEnv();
const ENV = COINCLAW_ENV || DOCKER_ENV;
const IS_DOCKER = ENV?.engine === 'docker';
const HOST = hostModeFreqtradePaths();
const SIGNAL_ADAPTER_ASSET_DIR = resolve(__dir, '..', 'assets');
const SIGNAL_ADAPTER_FILES = SIGNAL_ADAPTER_FILE_NAMES;

// 三引擎下 STRAT_DIR / USER_DATA / CONFIG_PATH 直接来自 daemon 启动参数,
// 跟 dashboard / freqtrade /api/v1/show_config 保持完全一致 — 不会出现
// "agent 写到 ~/.freqtrade/user_data/strategies/ 但 daemon 不读" 这种坑.
const STRAT_DIR  = ENV ? ENV.strategyPath      : HOST.strategyPath;
const USER_DATA  = ENV ? ENV.freqtradeUserdir  : HOST.userdir;
const CONFIG_PATH = ENV ? ENV.configPath       : HOST.configPath;
const ENV_FILE   = ENV ? ENV.envFile           : envFileCandidates()[0]; // host: ~/.helix/.env(规范位置, 与读路径最高优先级一致)
const FT_API_URL = process.env.FREQTRADE_URL || process.env.FT_API_URL || 'http://127.0.0.1:8888';
const FT_API_PORT = Number(new URL(FT_API_URL).port || 8888);
const BACKTEST_EVIDENCE_VERSION = 2;
// Research-only walk-forward bundles may omit a versioned policy. They still
// need an explicit account-R scale for execution evidence, while the report's
// VERSIONED_GATE_POLICY_PRESENT check keeps them permanently non-promotable.
const UNVERSIONED_WALK_FORWARD_RISK_UNIT_RATIO = 0.01;
const UNVERSIONED_WALK_FORWARD_ACCOUNT_EQUITY = 1000;
const BACKTEST_EVIDENCE_FILE = resolve(USER_DATA, 'backtest_results', '.helix-evidence.json');
const SIGNAL_ARTIFACT_DIR = resolve(USER_DATA, 'helix', 'signals');
const SIGNAL_BACKTEST_DATA_DIR = resolve(USER_DATA, 'helix', 'backtest-data');
const WALK_FORWARD_REPORT_INDEX = resolve(USER_DATA, 'helix', 'validation', 'walk-forward-reports.json');
const HELIX_REPO_ROOT = resolve(__dir, '..', '..', '..');
const CORE_PACKAGE_DIR = resolve(HELIX_REPO_ROOT, 'packages', 'core');
const FORWARD_WORKER_FILE = resolve(CORE_PACKAGE_DIR, 'src', 'strategy', 'forward-worker.ts');
const FORWARD_RUNTIME_FILE = resolve(__dir, '..', 'lib', 'forward-runtime.mjs');

// FT_BIN 解析顺序:
//   1. coinclaw 容器: 'freqtrade' — image PATH 上已经有 (entrypoint
//      ENV PATH 包含 /home/node/.freqtrade/source/.venv/bin 或者
//      ftuser 的 ~/.local/bin), 直接用最干净.
//   2. host 模式优先 `command -v freqtrade` — 用户本地已经装过的
//      系统 freqtrade (brew / uv / 系统包) 直接复用. 老版本 ft-deploy
//      会 git clone freqtrade 重装一次 setup.sh, 多等几分钟 + 多占
//      ~500MB. 见 commit 50011b8.
//   3. host fallback: ~/.freqtrade/source/.venv/bin/freqtrade — 真
//      没有时才走 setup.sh 装到 venv.
const FT_BIN = ENV ? (IS_DOCKER ? 'docker' : 'freqtrade') : (() => {
  try {
    const sys = execFileSync('which', ['freqtrade'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (sys && existsSync(sys)) return sys;
  } catch {}
  return HOST.ftBin;
})();

// ─── 通用辅助 ─────────────────────────────────────────────────────
function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf-8', timeout: 600000, ...opts }).trim();
}

function runFile(file, args = [], opts = {}) {
  return execFileSync(file, args, { encoding: 'utf-8', timeout: 600000, ...opts }).trim();
}

function runtimeMode() {
  return IS_DOCKER ? 'docker' : ENV ? 'coinclaw' : 'host';
}

function dockerCompose(args, opts = {}) {
  if (!IS_DOCKER) throw new Error('Docker Freqtrade runtime is not enabled.');
  if (!existsSync(ENV.composeFile)) throw new Error(`Freqtrade compose file not found: ${ENV.composeFile}`);
  return runFile('docker', [
    'compose', '--env-file', ENV.envFile, '-f', ENV.composeFile, ...args,
  ], opts);
}

function dockerCliPath(value) {
  if (!IS_DOCKER || typeof value !== 'string') return value;
  if (value === STRAT_DIR || value.startsWith(`${STRAT_DIR}/`)) {
    return `${ENV.containerStrategyPath}${value.slice(STRAT_DIR.length)}`;
  }
  if (value === USER_DATA || value.startsWith(`${USER_DATA}/`)) {
    return `${ENV.containerUserdir}${value.slice(USER_DATA.length)}`;
  }
  return value;
}

function hostCliPath(value) {
  if (!IS_DOCKER || typeof value !== 'string') return value;
  if (value === ENV.containerUserdir || value.startsWith(`${ENV.containerUserdir}/`)) {
    return `${USER_DATA}${value.slice(ENV.containerUserdir.length)}`;
  }
  return value;
}

function forwardRuntimePaths(deployment) {
  const root = resolve(USER_DATA, 'helix', 'forward', deployment.deploymentId);
  return {
    root,
    deploymentFile: resolve(root, 'deployment.json'),
    batchesDirectory: resolve(root, 'batches'),
    marketDataFile: resolve(root, 'market-data.json'),
    checkpointFile: resolve(root, 'checkpoint.json'),
    noSignalJournalFile: resolve(root, 'no-signal-journal.json'),
    statusFile: resolve(root, 'status.json'),
    pidFile: resolve(root, 'worker.pid'),
    logFile: resolve(root, 'worker.log'),
    deploymentHash: deployment.deploymentHash,
  };
}

function forwardRuntimeFromConfig(config) {
  const deploymentPath = config?.helix_signal_forward_deployment_path;
  const batchPath = config?.helix_signal_batch_path;
  const deploymentHash = config?.helix_signal_forward_deployment_hash;
  const statusPath = config?.helix_signal_forward_status_path;
  if (!deploymentPath && !batchPath && !deploymentHash && !statusPath) return null;
  if (typeof deploymentPath !== 'string' || typeof batchPath !== 'string'
    || typeof deploymentHash !== 'string' || typeof statusPath !== 'string') {
    throw new Error('Stored forward Signal deployment is incomplete.');
  }
  const deploymentFile = hostCliPath(deploymentPath);
  const root = dirname(deploymentFile);
  const managedRoot = resolve(USER_DATA, 'helix', 'forward');
  if (root !== managedRoot && !root.startsWith(`${managedRoot}/`)) {
    throw new Error('Stored forward Signal deployment path escapes the managed runtime directory.');
  }
  if (hostCliPath(batchPath) !== resolve(root, 'batches')) {
    throw new Error('Stored forward Signal batch path does not match its deployment directory.');
  }
  if (hostCliPath(statusPath) !== resolve(root, 'status.json')) {
    throw new Error('Stored forward Signal status path does not match its deployment directory.');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(deploymentHash)) {
    throw new Error('Stored forward Signal deployment hash is invalid.');
  }
  return {
    root,
    deploymentFile,
    batchesDirectory: hostCliPath(batchPath),
    marketDataFile: resolve(root, 'market-data.json'),
    checkpointFile: resolve(root, 'checkpoint.json'),
    noSignalJournalFile: resolve(root, 'no-signal-journal.json'),
    statusFile: resolve(root, 'status.json'),
    pidFile: resolve(root, 'worker.pid'),
    logFile: resolve(root, 'worker.log'),
    deploymentHash,
  };
}

function readForwardWorkerOwner(paths) {
  if (!existsSync(paths.pidFile)) return null;
  const content = readFileSync(paths.pidFile, 'utf8').trim();
  if (!content) return null;
  let owner;
  try { owner = JSON.parse(content); } catch { throw new Error('Forward worker PID metadata is invalid.'); }
  if (owner?.deploymentHash !== paths.deploymentHash) {
    throw new Error('Forward worker PID metadata does not match its deployment.');
  }
  return verifyForwardWorkerOwner(owner, paths.deploymentHash);
}

function readForwardWorkerPid(paths) {
  return readForwardWorkerOwner(paths)?.pid ?? null;
}

async function stopForwardWorker(paths) {
  if (!paths) return null;
  const owner = readForwardWorkerOwner(paths);
  const pid = owner?.pid ?? null;
  if (pid && hostPidIsAlive(pid)) {
    if (!forwardWorkerOwnerMatchesProcess(owner, paths.deploymentHash)) {
      throw new Error(`Forward worker PID ${pid} no longer matches its ownership token; refusing to signal it.`);
    }
    process.kill(pid, 'SIGTERM');
    await waitForHostPidExit(pid);
  }
  try { writeDeploymentFile(paths.pidFile, ''); } catch {}
  return pid;
}

function startForwardWorker(paths) {
  const workerFile = process.env.HELIX_TEST_FORWARD_WORKER_FILE?.trim()
    ? resolve(process.env.HELIX_TEST_FORWARD_WORKER_FILE.trim())
    : FORWARD_WORKER_FILE;
  if (!existsSync(workerFile)) {
    throw new Error(`Helix forward worker is unavailable at ${workerFile}`);
  }
  const existing = readForwardWorkerOwner(paths);
  if (existing && hostPidIsAlive(existing.pid)) {
    if (!forwardWorkerOwnerMatchesProcess(existing, paths.deploymentHash)) {
      throw new Error(`Forward worker PID ${existing.pid} no longer matches its ownership token.`);
    }
    return existing.pid;
  }
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  mkdirSync(paths.batchesDirectory, { recursive: true, mode: 0o700 });
  const logFd = openSync(paths.logFile, 'a', 0o600);
  const ownerToken = createForwardWorkerOwnerToken();
  const emergencyStopFile = resolve(USER_DATA, 'helix', 'deployment', 'emergency-stop.json');
  const allowedInitialEmergencyStopHash = existsSync(emergencyStopFile)
    ? `sha256:${createHash('sha256').update(readFileSync(emergencyStopFile)).digest('hex')}`
    : null;
  try {
    const child = spawn(process.execPath, [
      FORWARD_RUNTIME_FILE, 'watchdog', JSON.stringify({
        deploymentHash: paths.deploymentHash,
        ownerToken,
        pidFile: paths.pidFile,
        emergencyStopFile,
        allowedInitialEmergencyStopHash,
        deploymentFile: paths.deploymentFile,
        configFile: CONFIG_PATH,
        workerFile,
        workerParams: {
          deployment: paths.deploymentFile,
          batches: paths.batchesDirectory,
          marketData: paths.marketDataFile,
          checkpoint: paths.checkpointFile,
          noSignalJournal: paths.noSignalJournalFile,
          status: paths.statusFile,
        },
        cwd: CORE_PACKAGE_DIR,
      }),
    ], {
      cwd: CORE_PACKAGE_DIR,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: proxyEnv(),
    });
    if (!Number.isSafeInteger(child.pid) || child.pid < 1) throw new Error('Unable to start Helix forward worker.');
    child.unref();
    let owner;
    try {
      owner = createForwardWorkerOwner({
        pid: child.pid,
        deploymentHash: paths.deploymentHash,
        ownerToken,
      });
      writeDeploymentFile(paths.pidFile, `${JSON.stringify(owner)}\n`);
    } catch (error) {
      try { process.kill(child.pid, 'SIGTERM'); } catch {}
      throw error;
    }
    chmodSync(paths.logFile, 0o600);
    return child.pid;
  } finally {
    closeSync(logFd);
  }
}

async function waitForForwardWorker(
  paths,
  deploymentHash,
  timeoutMs = Number(process.env.HELIX_TEST_FORWARD_TIMEOUT_MS) || 180_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'forward worker has not published a heartbeat';
  while (Date.now() < deadline) {
    const owner = readForwardWorkerOwner(paths);
    const pid = owner?.pid ?? null;
    if (!pid || !hostPidIsAlive(pid)
      || !forwardWorkerOwnerMatchesProcess(owner, paths.deploymentHash)) {
      throw new Error('Helix forward worker exited or lost ownership before readiness');
    }
    const status = readJsonFile(paths.statusFile);
    if (status?.deploymentHash && status.deploymentHash !== deploymentHash) {
      throw new Error('Helix forward worker heartbeat belongs to another deployment');
    }
    if (status?.state === 'error') throw new Error(`Helix forward worker failed: ${status.error || 'unknown error'}`);
    if ((status?.state === 'waiting' || status?.state === 'ready')
      && status.deploymentHash === deploymentHash
      && status.pid === pid
      && Number.isSafeInteger(status.updatedAt)
      && Date.now() - status.updatedAt < 30_000) {
      return status;
    }
    lastError = status?.error || lastError;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Helix forward worker readiness failed: ${lastError}`);
}

async function startStoredForwardWorker(config) {
  const paths = forwardRuntimeFromConfig(config);
  if (!paths) return null;
  const deployment = verifyForwardDeployment(readJsonFile(paths.deploymentFile));
  if (deployment.deploymentHash !== paths.deploymentHash) {
    throw new Error('Stored forward deployment hash does not match before worker start.');
  }
  const pid = startForwardWorker(paths);
  const status = await waitForForwardWorker(paths, paths.deploymentHash);
  return { pid, status };
}

function configureForwardRuntime(config, deployment, paths) {
  config.helix_signal_forward_deployment_path = dockerCliPath(paths.deploymentFile);
  config.helix_signal_forward_deployment_hash = deployment.deploymentHash;
  config.helix_signal_batch_path = dockerCliPath(paths.batchesDirectory);
  config.helix_signal_forward_status_path = dockerCliPath(paths.statusFile);
}

function clearForwardRuntimeConfig(config) {
  delete config.helix_signal_forward_deployment_path;
  delete config.helix_signal_forward_deployment_hash;
  delete config.helix_signal_batch_path;
  delete config.helix_signal_forward_status_path;
}

function readForwardRuntimeStatus(config) {
  try {
    const paths = forwardRuntimeFromConfig(config);
    if (!paths) return null;
    const deployment = verifyForwardDeployment(readJsonFile(paths.deploymentFile));
    if (deployment.deploymentHash !== paths.deploymentHash) {
      throw new Error('Forward deployment file does not match the configured hash.');
    }
    const owner = readForwardWorkerOwner(paths);
    const pid = owner?.pid ?? null;
    const status = readJsonFile(paths.statusFile);
    if (status) {
      const fields = [
        'schemaVersion', 'deploymentHash', 'state', 'pid', 'updatedAt', 'lastDecisionTime',
        'lastMarketSnapshotId', 'lastBatchHash', 'batches', 'error',
      ];
      const actual = Object.keys(status).sort();
      const expected = [...fields].sort();
      if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
        throw new Error('Forward worker heartbeat contains unexpected fields.');
      }
      if (status.schemaVersion !== 'helix.forward-worker-status/v1') {
        throw new Error('Forward worker heartbeat schema is unsupported.');
      }
      if (status.deploymentHash !== paths.deploymentHash) {
        throw new Error('Forward worker heartbeat belongs to another deployment.');
      }
      if (!['waiting', 'ready', 'error'].includes(status.state)
        || !Number.isSafeInteger(status.pid) || status.pid < 1
        || !Number.isSafeInteger(status.updatedAt) || status.updatedAt < 0
        || !Number.isSafeInteger(status.batches) || status.batches < 0) {
        throw new Error('Forward worker heartbeat is invalid.');
      }
      if (pid && status.pid !== pid) {
        throw new Error('Forward worker heartbeat PID does not match its owner metadata.');
      }
    }
    const heartbeatAgeMs = Number.isSafeInteger(status?.updatedAt) ? Date.now() - status.updatedAt : null;
    const running = Boolean(pid && hostPidIsAlive(pid)
      && forwardWorkerOwnerMatchesProcess(owner, paths.deploymentHash));
    let state = status?.state || (running ? 'starting' : 'stopped');
    if (running && (heartbeatAgeMs == null || heartbeatAgeMs > 300_000)) state = 'stale';
    if (!running && status?.state !== 'error') state = 'stopped';
    return {
      deployment_hash: paths.deploymentHash,
      pid,
      running,
      state,
      heartbeat_age_ms: heartbeatAgeMs,
      last_decision_time: status?.lastDecisionTime ?? null,
      last_market_snapshot_id: status?.lastMarketSnapshotId ?? null,
      last_batch_hash: status?.lastBatchHash ?? null,
      batches: status?.batches ?? 0,
      error: status?.error ?? null,
    };
  } catch (error) {
    return {
      deployment_hash: config?.helix_signal_forward_deployment_hash ?? null,
      pid: null,
      running: false,
      state: 'error',
      heartbeat_age_ms: null,
      last_decision_time: null,
      last_market_snapshot_id: null,
      last_batch_hash: null,
      batches: 0,
      error: error.message,
    };
  }
}

function runFreqtrade(args, opts = {}) {
  if (IS_DOCKER) {
    return dockerCompose([
      'run', '--rm', '--no-deps', 'freqtrade', ...args.map(dockerCliPath),
    ], opts);
  }
  return runFile(FT_BIN, args, opts);
}

function hasCommand(cmd) {
  try { runFile('which', [cmd]); return true; } catch { return false; }
}

function proxyEnv() {
  const proxyUrl = process.env.PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  return proxyUrl ? { ...process.env, HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl } : process.env;
}

function runSecretFreeSignalBacktest(args, opts = {}) {
  const environment = secretFreeBacktestEnvironment(opts.env || proxyEnv());
  if (IS_DOCKER) {
    return dockerCompose([
      'run', '--rm', '--no-deps',
      ...secretFreeDockerEnvironmentArguments(environment),
      'freqtrade',
      ...args.map(dockerCliPath),
    ], { ...opts, env: environment });
  }
  return runFile(FT_BIN, args, { ...opts, env: environment });
}

function parseTailLines(lines, fallback = 50) {
  const n = Number(lines ?? fallback);
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    throw new Error('lines 必须是 1-1000 的整数');
  }
  return n;
}

function numberOrNull(value) {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const n = numberOrNull(value);
    if (n != null) return n;
  }
  return null;
}

function readJsonFile(file) {
  try { return JSON.parse(readFileSync(file, 'utf-8')); } catch { return null; }
}

function fileHash(file) {
  return existsSync(file)
    ? `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`
    : null;
}

function requireUnchangedFile(file, expectedHash, name) {
  const actualHash = fileHash(file);
  if (!expectedHash || actualHash !== expectedHash) {
    throw new Error(`${name} changed during backtest. Run the backtest again with immutable inputs.`);
  }
}

function runBacktestSubprocess(params) {
  try {
    const output = runFile(process.execPath, [
      DEPLOY_SCRIPT_FILE,
      'backtest',
      JSON.stringify(params),
    ], { maxBuffer: 20 * 1024 * 1024 });
    return JSON.parse(output);
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr).trim() : '';
    throw new Error(`walk-forward backtest failed: ${stderr || error.message}`);
  }
}

function reusableWalkForwardEvidence({
  fold,
  scenario,
  adapterHash,
  freqtradeVersion,
  riskUnitRatio,
  accountEquity,
}) {
  const artifact = fold.executionArtifact;
  for (const record of readBacktestEvidence()) {
    const environment = record?.executionEnvironment;
    if (record?.strategy !== HELIX_SIGNAL_STRATEGY
      || `sha256:${record.strategyHash}` !== adapterHash
      || record.timeframe !== artifact.baseTimeframe
      || !isDeepStrictEqual(record.pairs, [artifact.symbol])
      || record.signalArtifact?.artifactHash !== artifact.artifactHash
      || record.marketDataset?.datasetHash !== fold.dataset.datasetHash
      || environment?.riskTraceHash !== fold.executionRiskTrace.traceHash
      || environment?.riskUnitRatio !== riskUnitRatio
      || environment?.fee !== scenario.fee
      || typeof environment?.freqtradeVersion !== 'string'
      || environment.freqtradeVersion.trim() !== freqtradeVersion.trim()
      || environment?.configIdentity?.dryRunWallet !== accountEquity
      || environment?.executionProfile?.dryRunWallet !== accountEquity
      || environment?.executionProfile?.fee !== scenario.fee) continue;
    try {
      const verified = verifyBacktestEvidenceResult(record, artifact, scenario.fee, {
        signalArtifact: artifact,
        riskTrace: fold.executionRiskTrace,
        marketDataset: fold.dataset,
        riskUnitRatio,
        accountEquity,
      });
      if (verified.feeObservations.status !== 'OBSERVED'
        || !verified.feeObservations.matchesRequested) continue;
      return { record, verified };
    } catch {}
  }
  return null;
}

function archiveWalkForwardEvidence(directory, sourceFile, expectedHash, suffix) {
  if (fileHash(sourceFile) !== expectedHash) throw new Error(`walk-forward evidence changed: ${sourceFile}`);
  const evidenceDirectory = resolve(directory, 'evidence');
  mkdirSync(evidenceDirectory, { recursive: true });
  const name = `${expectedHash.replace(':', '-')}${suffix}`;
  const destination = resolve(evidenceDirectory, name);
  if (existsSync(destination)) {
    if (fileHash(destination) !== expectedHash) {
      throw new Error(`walk-forward evidence archive is corrupt: ${destination}`);
    }
  } else {
    const temporary = `${destination}.tmp.${process.pid}`;
    writeFileSync(temporary, readFileSync(sourceFile), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, destination);
  }
  return `evidence/${name}`;
}

function archiveWalkForwardRuntimeEvidence(directory, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const expectedHash = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  const evidenceDirectory = resolve(directory, 'evidence');
  mkdirSync(evidenceDirectory, { recursive: true });
  const name = `${expectedHash.replace(':', '-')}.runtime.json`;
  const destination = resolve(evidenceDirectory, name);
  if (existsSync(destination)) {
    if (fileHash(destination) !== expectedHash) {
      throw new Error(`walk-forward runtime evidence archive is corrupt: ${destination}`);
    }
  } else {
    const temporary = `${destination}.tmp.${process.pid}`;
    writeFileSync(temporary, content, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, destination);
  }
  return { file: `evidence/${name}`, hash: expectedHash };
}

function writeImmutableJsonFile(file, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const expectedHash = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) {
    if (fileHash(file) !== expectedHash) throw new Error(`immutable JSON archive is corrupt: ${file}`);
    return expectedHash;
  }
  const temporary = `${file}.tmp.${process.pid}`;
  writeFileSync(temporary, content, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
  return expectedHash;
}

function archiveWalkForwardCoreBundle(bundle) {
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
  const files = entries.map(([name, value]) => {
    const relative = `${root}/${name}`;
    return {
      file: relative,
      fileHash: writeImmutableJsonFile(resolve(bundle.directory, relative), value),
    };
  });
  const coreEvidence = {
    root,
    sourceDatasetFile: `${root}/source-dataset.json`,
    runFile: `${root}/walk-forward-run.json`,
    files,
  };
  const archived = loadWalkForwardBundle(
    resolve(bundle.directory, coreEvidence.runFile),
    resolve(bundle.directory, coreEvidence.sourceDatasetFile),
  );
  if (archived.plan.planHash !== bundle.plan.planHash || archived.run.runHash !== bundle.run.runHash) {
    throw new Error('archived walk-forward Core bundle identity mismatch');
  }
  return coreEvidence;
}

function writeImmutableWalkForwardReport(directory, report) {
  const file = resolve(directory, `walk-forward-report-${report.reportHash.replace(':', '-')}.json`);
  const content = `${JSON.stringify(report, null, 2)}\n`;
  const expectedFileHash = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  if (existsSync(file)) {
    if (fileHash(file) !== expectedFileHash) throw new Error(`walk-forward report archive is corrupt: ${file}`);
    return file;
  }
  const temporary = `${file}.tmp.${process.pid}`;
  writeFileSync(temporary, content, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
  return file;
}

function writeImmutableRawFile(file, content, expectedHash) {
  if (`sha256:${createHash('sha256').update(content).digest('hex')}` !== expectedHash) {
    throw new Error(`immutable archive source hash mismatch: ${file}`);
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (existsSync(file)) {
    if (fileHash(file) !== expectedHash) throw new Error(`immutable archive is corrupt: ${file}`);
    return;
  }
  const temporary = `${file}.tmp.${process.pid}`;
  writeFileSync(temporary, content, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}

function archiveWalkForwardMemberReport(portfolioDirectory, reportFileValue) {
  const reportFile = resolve(reportFileValue);
  const sourceDirectory = dirname(reportFile);
  const report = verifyWalkForwardReport(
    JSON.parse(readFileSync(reportFile, 'utf8')),
    null,
    sourceDirectory,
  );
  const expectedName = `walk-forward-report-${report.reportHash.replace(':', '-')}.json`;
  if (basename(reportFile) !== expectedName) throw new Error(`walk-forward member report file must equal ${expectedName}`);
  const memberDirectory = resolve(portfolioDirectory, 'members', report.reportHash.replace(':', '-'));
  const files = new Map([[basename(reportFile), fileHash(reportFile)]]);
  for (const entry of report.coreEvidence.files) files.set(entry.file, entry.fileHash);
  for (const fold of report.folds) {
    for (const evidence of fold.executionEvidence) {
      files.set(evidence.resultFile, evidence.resultHash);
      files.set(evidence.resultMetaFile, evidence.resultMetaHash);
      files.set(evidence.runtimeEvidenceFile, evidence.runtimeEvidenceHash);
    }
  }
  for (const [relativeFile, expectedHash] of files) {
    if (!relativeFile || relativeFile.includes('..') || relativeFile.includes('\\')) {
      throw new Error(`walk-forward member archive path is invalid: ${relativeFile}`);
    }
    const sourceFile = resolve(sourceDirectory, relativeFile);
    if (fileHash(sourceFile) !== expectedHash) {
      throw new Error(`walk-forward member archive changed: ${sourceFile}`);
    }
    writeImmutableRawFile(resolve(memberDirectory, relativeFile), readFileSync(sourceFile), expectedHash);
  }
  const archivedReport = resolve(memberDirectory, expectedName);
  verifyWalkForwardReport(JSON.parse(readFileSync(archivedReport, 'utf8')), null, memberDirectory);
  return archivedReport;
}

function writeImmutableWalkForwardPortfolioReport(directory, report) {
  const file = resolve(
    directory,
    `walk-forward-portfolio-report-${report.reportHash.replace(':', '-')}.json`,
  );
  writeImmutableJsonFile(file, report);
  return file;
}

function strategyFingerprint(strategy) {
  const file = resolve(STRAT_DIR, `${strategy}.py`);
  if (strategy === HELIX_SIGNAL_STRATEGY) {
    try {
      return signalAdapterBundleFromDirectory(SIGNAL_ADAPTER_ASSET_DIR).adapterHash.slice('sha256:'.length);
    } catch {
      return null;
    }
  }
  if (!existsSync(file)) return null;
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function signalExecutionProfile(config, { timeframe, pairs, fee = null }) {
  const configuredFee = fee ?? numberOrNull(config?.fee);
  const maxOpenTrades = numberOrNull(config?.max_open_trades);
  return {
    schemaVersion: 'helix.freqtrade-execution-profile/v1',
    strategy: HELIX_SIGNAL_STRATEGY,
    timeframe: String(timeframe || ''),
    pairs: [...pairs].map(String).sort(),
    exchange: String(config?.exchange?.name || '').toLowerCase(),
    tradingMode: String(config?.trading_mode || ''),
    marginMode: String(config?.margin_mode || ''),
    maxOpenTrades,
    stakeCurrency: String(config?.stake_currency || ''),
    stakeAmount: config?.stake_amount ?? null,
    tradableBalanceRatio: numberOrNull(config?.tradable_balance_ratio),
    dryRunWallet: numberOrNull(config?.dry_run_wallet),
    fee: configuredFee,
    entryPricing: config?.entry_pricing ?? null,
    exitPricing: config?.exit_pricing ?? null,
    orderTypes: config?.order_types ?? null,
    orderTimeInForce: config?.order_time_in_force ?? null,
    unfilledTimeout: config?.unfilledtimeout ?? null,
    positionAdjustmentEnabled: config?.position_adjustment_enable ?? null,
    maxEntryPositionAdjustment: numberOrNull(config?.max_entry_position_adjustment),
  };
}

function hasSignalExecutionEnvironment(evidence) {
  const environment = evidence?.executionEnvironment;
  return typeof environment?.freqtradeVersion === 'string'
    && environment.freqtradeVersion.trim().length > 0
    && typeof environment.configHash === 'string'
    && environment.configHash.startsWith('sha256:')
    && typeof environment.artifactFileHash === 'string'
    && environment.artifactFileHash.startsWith('sha256:')
    && typeof environment.riskTraceHash === 'string'
    && environment.riskTraceHash.startsWith('sha256:')
    && typeof environment.riskTraceFileHash === 'string'
    && environment.riskTraceFileHash.startsWith('sha256:')
    && typeof environment.riskUnitRatio === 'number'
    && Number.isFinite(environment.riskUnitRatio)
    && environment.riskUnitRatio > 0
    && environment.riskUnitRatio <= 1
    && environment.dataFormatOhlcv === 'json'
    && environment.executionProfile?.schemaVersion === 'helix.freqtrade-execution-profile/v1';
}

let cachedFreqtradeVersion;
function currentFreqtradeVersion() {
  if (cachedFreqtradeVersion === undefined) {
    cachedFreqtradeVersion = runFreqtrade(['--version'], { timeout: 60_000, env: proxyEnv() }).trim();
  }
  if (!cachedFreqtradeVersion) throw new Error('Freqtrade did not report a version');
  return cachedFreqtradeVersion;
}

function requireSignalExecutionCompatibility(evidence, config, archivedArtifact) {
  if (!hasSignalExecutionEnvironment(evidence)) {
    throw new Error(`Backtest evidence "${evidence.id}" predates the execution identity gate. Run the exact Signal backtest again.`);
  }
  const environment = evidence.executionEnvironment;
  const version = currentFreqtradeVersion();
  if (environment.freqtradeVersion.trim() !== version) {
    throw new Error(`Backtest evidence "${evidence.id}" used Freqtrade ${environment.freqtradeVersion.trim()}, current runtime is ${version}.`);
  }
  const profileOptions = {
    timeframe: archivedArtifact.artifact.baseTimeframe,
    pairs: [archivedArtifact.artifact.symbol],
  };
  const expectedProfile = typeof environment.executionProfile?.configHash === 'string'
    && typeof environment.fee === 'number'
    ? createRuntimeExecutionProfile(
        createSecretFreeBacktestConfig(config, profileOptions),
        { ...profileOptions, fee: environment.fee },
      )
    : signalExecutionProfile(config, profileOptions);
  if (!isDeepStrictEqual(environment.executionProfile, expectedProfile)) {
    throw new Error(`Backtest evidence "${evidence.id}" execution profile does not match the deployment target.`);
  }
  if (environment.artifactFileHash !== fileHash(archivedArtifact.hashFile)) {
    throw new Error(`Backtest evidence "${evidence.id}" Artifact file hash does not match the immutable archive.`);
  }
  return evidence;
}

function readBacktestEvidence() {
  const payload = readJsonFile(BACKTEST_EVIDENCE_FILE);
  return (payload?.version === 1 || payload?.version === BACKTEST_EVIDENCE_VERSION) && Array.isArray(payload.records)
    ? payload.records
    : [];
}

function backtestMetaFiles(resultsDir) {
  if (!existsSync(resultsDir)) return [];
  return readdirSync(resultsDir).filter((file) => file.endsWith('.meta.json'));
}

function findNewBacktestResult(resultsDir, beforeFiles, strategy) {
  const metaFile = backtestMetaFiles(resultsDir)
    .filter((file) => !beforeFiles.has(file))
    .sort((a, b) => b.localeCompare(a))
    .find((file) => {
      const meta = readJsonFile(resolve(resultsDir, file));
      return meta && Object.prototype.hasOwnProperty.call(meta, strategy);
    });
  if (!metaFile) return null;
  const baseFile = metaFile.slice(0, -'.meta.json'.length);
  const resultFile = [`${baseFile}.json`, `${baseFile}.zip`]
    .find((file) => existsSync(resolve(resultsDir, file)));
  return resultFile ? { resultFile, resultMetaFile: metaFile } : null;
}

function signalArtifactEvidence(artifact) {
  if (!artifact) return null;
  return {
    artifactHash: artifact.artifactHash,
    schemaVersion: artifact.schemaVersion,
    strategyLifecycle: artifact.strategyLifecycle,
    identity: pinnedSignalIdentity(artifact),
    marketDataSnapshotId: artifact.identity.marketDataSnapshotId,
    symbol: artifact.symbol,
    baseTimeframe: artifact.baseTimeframe,
    marketData: artifact.marketData,
    signalCount: artifact.signals.length,
  };
}

function recordBacktestEvidence({
  strategy,
  strategyHash,
  timeframe,
  timerange,
  pairs,
  resultFile,
  resultMetaFile,
  metrics,
  signalArtifact = null,
  marketDataset = null,
  executionEnvironment = null,
  resultHash = null,
  resultMetaHash = null,
  reconciliation = null,
}) {
  const resultsDir = dirname(BACKTEST_EVIDENCE_FILE);
  mkdirSync(resultsDir, { recursive: true });
  const record = {
    id: `${Date.now()}-${strategyHash.slice(0, 12)}`,
    strategy,
    strategyHash,
    timeframe,
    timerange: timerange || '',
    pairs,
    resultFile,
    resultMetaFile,
    metrics,
    signalArtifact: signalArtifactEvidence(signalArtifact),
    marketDataset,
    executionEnvironment,
    resultHash,
    resultMetaHash,
    reconciliation,
    createdAt: new Date().toISOString(),
  };
  const payload = {
    version: BACKTEST_EVIDENCE_VERSION,
    records: [record, ...readBacktestEvidence()].slice(0, 100),
  };
  const tempFile = `${BACKTEST_EVIDENCE_FILE}.tmp.${process.pid}`;
  writeFileSync(tempFile, `${JSON.stringify(payload, null, 2)}\n`);
  chmodSync(tempFile, 0o600);
  renameSync(tempFile, BACKTEST_EVIDENCE_FILE);
  return record;
}

function requireCurrentBacktestEvidence(strategy, signalArtifact = null) {
  const strategyHash = strategyFingerprint(strategy);
  const evidence = strategyHash ? readBacktestEvidence().find((record) => {
    if (record.strategy !== strategy || record.strategyHash !== strategyHash) return false;
    if (strategy !== HELIX_SIGNAL_STRATEGY) return true;
    if (!signalArtifact || !record.signalArtifact?.identity || !hasSignalExecutionEnvironment(record)) return false;
    return record.signalArtifact.artifactHash === signalArtifact.artifactHash
      && record.signalArtifact.marketDataSnapshotId === signalArtifact.identity.marketDataSnapshotId
      && record.marketDataset?.datasetHash === signalArtifact.identity.marketDataSnapshotId
      && samePinnedSignalIdentity(
        { identity: record.signalArtifact.identity },
        signalArtifact,
      );
  }) : null;
  if (!evidence) {
    if (strategy === HELIX_SIGNAL_STRATEGY) {
      throw new Error(`Current Helix adapter and exact signal artifact have not been backtested. Run backtest with signal_artifact before deploy.`);
    }
    throw new Error(`Current code for strategy "${strategy}" has not been backtested. Run backtest before deploy.`);
  }
  return evidence;
}

function installSignalAdapter() {
  ensureStrategyDir();
  for (const name of SIGNAL_ADAPTER_FILES) {
    const source = resolve(SIGNAL_ADAPTER_ASSET_DIR, name);
    const destination = resolve(STRAT_DIR, name);
    if (!existsSync(source)) throw new Error(`Helix signal adapter asset is missing: ${source}`);
    if (source !== destination) writeDeploymentFile(destination, readFileSync(source), 0o644);
    try { chmodSync(destination, 0o644); } catch {}
  }
}

function requireInstalledSignalAdapter() {
  for (const name of SIGNAL_ADAPTER_FILES) {
    const source = resolve(SIGNAL_ADAPTER_ASSET_DIR, name);
    const destination = resolve(STRAT_DIR, name);
    if (fileHash(source) !== fileHash(destination)) {
      throw new Error(`installed Helix signal adapter does not match Engine asset: ${name}`);
    }
  }
}

function archiveSignalArtifact(file) {
  if (typeof file !== 'string' || !file.trim()) throw new Error('signal_artifact must be a JSON file path');
  const source = resolve(file.trim());
  let artifact;
  try {
    artifact = verifySignalArtifact(JSON.parse(readFileSync(source, 'utf8')));
  } catch (error) {
    throw new Error(`cannot read signal artifact ${source}: ${error.message}`);
  }
  mkdirSync(SIGNAL_ARTIFACT_DIR, { recursive: true });
  const hashFile = signalArtifactArchivePath(USER_DATA, artifact.artifactHash);
  const content = `${JSON.stringify(artifact, null, 2)}\n`;
  if (existsSync(hashFile)) {
    const staged = loadSignalArtifact(hashFile);
    if (staged.artifactHash !== artifact.artifactHash) throw new Error(`staged signal artifact is corrupt: ${hashFile}`);
  } else {
    const tempFile = `${hashFile}.tmp.${process.pid}`;
    writeFileSync(tempFile, content);
    chmodSync(tempFile, 0o600);
    renameSync(tempFile, hashFile);
  }
  return { artifact, hashFile };
}

function loadArchivedSignalArtifact(artifactHash) {
  const hashFile = signalArtifactArchivePath(USER_DATA, artifactHash);
  if (!existsSync(hashFile)) throw new Error(`Archived signal artifact is missing: ${artifactHash}`);
  const artifact = loadSignalArtifact(hashFile);
  if (artifact.artifactHash !== artifactHash) throw new Error(`Archived signal artifact hash mismatch: ${artifactHash}`);
  return { artifact, hashFile };
}

function resolveSignalArtifact(params) {
  const hasSource = typeof params.signal_artifact === 'string' && params.signal_artifact.trim();
  const hasHash = typeof params.signal_artifact_hash === 'string' && params.signal_artifact_hash.trim();
  if (hasSource && hasHash) throw new Error('Use signal_artifact or signal_artifact_hash, not both.');
  if (hasSource) return archiveSignalArtifact(params.signal_artifact);
  if (hasHash) {
    return loadArchivedSignalArtifact(params.signal_artifact_hash.trim());
  }
  return null;
}

function archiveHistoricalRiskTrace(file, artifact) {
  if (typeof file !== 'string' || !file.trim()) {
    throw new Error('HelixSignalStrategy backtest requires historical_risk_trace.');
  }
  const source = resolve(file.trim());
  let riskTrace;
  try {
    riskTrace = verifyHistoricalRiskTrace(JSON.parse(readFileSync(source, 'utf8')), artifact);
  } catch (error) {
    throw new Error(`cannot read historical risk trace ${source}: ${error.message}`);
  }
  const directory = resolve(USER_DATA, 'helix', 'risk-traces');
  mkdirSync(directory, { recursive: true });
  const hashFile = resolve(directory, `${riskTrace.traceHash.replace(':', '-')}.json`);
  const content = `${JSON.stringify(riskTrace, null, 2)}\n`;
  const expectedFileHash = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  if (existsSync(hashFile)) {
    if (fileHash(hashFile) !== expectedFileHash) throw new Error(`archived historical risk trace is corrupt: ${hashFile}`);
    verifyHistoricalRiskTrace(JSON.parse(readFileSync(hashFile, 'utf8')), artifact);
  } else {
    const temporary = `${hashFile}.tmp.${process.pid}`;
    writeFileSync(temporary, content, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, hashFile);
  }
  return { riskTrace, hashFile, fileHash: expectedFileHash };
}

function resolveSignalWalkForwardReport(params, artifact) {
  const value = params.walk_forward_report;
  if (value == null || value === '') return null;
  if (!artifact) throw new Error('walk_forward_report can only be used with a Signal Artifact deployment.');
  if (typeof value !== 'string' || !value.trim()) throw new Error('walk_forward_report must be a JSON file path.');
  return loadPromotableWalkForwardEvidence(value.trim(), artifact);
}

function requireSignalWalkForwardReport(artifact, evidence) {
  if (artifact && !evidence) {
    throw new Error('Helix Signal deployment requires a promotable walk_forward_report for the exact Artifact identity.');
  }
  return evidence;
}

function requireUnchangedWalkForwardReport(evidence, artifact) {
  if (!evidence) return null;
  const current = loadPromotableWalkForwardEvidence(evidence.file, artifact);
  if (current.report.reportHash !== evidence.report.reportHash) {
    throw new Error('walk-forward report changed during deployment.');
  }
  return current;
}

function configureWalkForwardReport(config, evidence) {
  if (!evidence) {
    delete config.helix_signal_walk_forward_report_path;
    delete config.helix_signal_walk_forward_report_hash;
    return;
  }
  config.helix_signal_walk_forward_report_path = evidence.file;
  config.helix_signal_walk_forward_report_hash = evidence.report.reportHash;
}

function walkForwardReferenceAccountEquity(evidence) {
  const value = evidence?.walkForwardPolicy?.plan?.referenceAccountEquity;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error('walk-forward report has no valid reference account equity.');
  }
  return value;
}

function walkForwardDeploymentFee(evidence) {
  const scenarios = evidence?.walkForwardPolicy?.plan?.executionScenarios;
  if (!Array.isArray(scenarios) || scenarios.length < 2) {
    throw new Error('walk-forward report has no valid fee scenarios.');
  }
  const fees = scenarios.map((scenario) => scenario?.fee);
  if (fees.some((fee) => typeof fee !== 'number' || !Number.isFinite(fee) || fee < 0)) {
    throw new Error('walk-forward report has an invalid fee scenario.');
  }
  return Math.max(...fees);
}

function requireStoredWalkForwardReport(config, artifact) {
  const file = config?.helix_signal_walk_forward_report_path;
  const reportHash = config?.helix_signal_walk_forward_report_hash;
  if (file == null && reportHash == null) return null;
  if (typeof file !== 'string' || typeof reportHash !== 'string') {
    throw new Error('Stored Signal walk-forward report pin is incomplete.');
  }
  const evidence = loadPromotableWalkForwardEvidence(file, artifact);
  if (evidence.report.reportHash !== reportHash) {
    throw new Error('Stored Signal walk-forward report hash does not match its verified report.');
  }
  return evidence;
}

function readWalkForwardReportIndex() {
  const payload = readJsonFile(WALK_FORWARD_REPORT_INDEX);
  return payload?.version === 1 && Array.isArray(payload.records) ? payload.records : [];
}

function recordWalkForwardReport(evidence) {
  const record = {
    schemaVersion: evidence.report.schemaVersion,
    reportHash: evidence.report.reportHash,
    reportFile: evidence.file,
    candidate: evidence.report.candidate,
    symbols: evidence.report.members
      ? evidence.report.members.map(({ source: memberSource }) => memberSource.symbol)
      : evidence.member?.source?.symbol ? [evidence.member.source.symbol] : [],
    createdAt: new Date().toISOString(),
  };
  const records = [record, ...readWalkForwardReportIndex().filter(
    (item) => item?.reportHash !== record.reportHash,
  )].slice(0, 100);
  mkdirSync(dirname(WALK_FORWARD_REPORT_INDEX), { recursive: true, mode: 0o700 });
  const temporary = `${WALK_FORWARD_REPORT_INDEX}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, records }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, WALK_FORWARD_REPORT_INDEX);
  return record;
}

function walkForwardCandidateMatchesArtifact(candidate, artifact) {
  return candidate?.strategyId === artifact.identity.strategyId
    && candidate?.strategyVersion === artifact.identity.strategyVersion
    && candidate?.strategyRepoCommit === artifact.identity.strategyRepoCommit
    && candidate?.strategyConfigHash === artifact.identity.strategyConfigHash
    && candidate?.engineCommit === artifact.identity.engineCommit
    && candidate?.lifecycle === artifact.strategyLifecycle
    && candidate?.objectModel === artifact.objectModel;
}

function findWalkForwardReportForArtifact(artifact) {
  for (const record of readWalkForwardReportIndex()) {
    if (typeof record?.reportFile !== 'string' || typeof record?.reportHash !== 'string'
      || !walkForwardCandidateMatchesArtifact(record.candidate, artifact)) continue;
    try {
      const evidence = loadPromotableWalkForwardEvidence(record.reportFile, artifact);
      if (evidence.report.reportHash === record.reportHash) return evidence;
    } catch {}
  }
  return null;
}

function requireStoredDeploymentIdentity(config) {
  const strategy = assertStrategyName(config?.strategy);
  let archivedArtifact = null;
  if (strategy === HELIX_SIGNAL_STRATEGY) {
    const artifactHash = config?.helix_signal_artifact_hash;
    const artifactPath = config?.helix_signal_artifact_path;
    if (typeof artifactHash !== 'string' || typeof artifactPath !== 'string') {
      throw new Error('Stored HelixSignalStrategy config is missing its immutable Artifact pin.');
    }
    archivedArtifact = loadArchivedSignalArtifact(artifactHash);
    const expectedPath = dockerCliPath(archivedArtifact.hashFile);
    if (artifactPath !== expectedPath) {
      throw new Error(`Stored signal artifact path does not match its hash: expected ${expectedPath}`);
    }
    requireInstalledSignalAdapter();
    const walkForwardEvidence = requireSignalWalkForwardReport(
      archivedArtifact.artifact,
      requireStoredWalkForwardReport(config, archivedArtifact.artifact),
    );
    const forwardRuntime = forwardRuntimeFromConfig(config);
    if (forwardRuntime) {
      const deployment = verifyForwardDeployment(readJsonFile(forwardRuntime.deploymentFile));
      if (deployment.deploymentHash !== forwardRuntime.deploymentHash) {
        throw new Error('Stored forward Signal deployment hash does not match its file.');
      }
      const pin = deployment.strategy;
      const artifact = archivedArtifact.artifact;
      if (pin.id !== artifact.identity.strategyId
        || pin.version !== artifact.identity.strategyVersion
        || pin.repoCommit !== artifact.identity.strategyRepoCommit
        || pin.configHash !== artifact.identity.strategyConfigHash
        || pin.engineCommit !== artifact.identity.engineCommit
        || pin.lifecycle !== artifact.strategyLifecycle
        || pin.objectModel !== artifact.objectModel
        || pin.baseTimeframe !== artifact.baseTimeframe
        || deployment.symbol !== artifact.symbol) {
        throw new Error('Stored forward Signal deployment does not match its backtested Artifact identity.');
      }
      if ((walkForwardEvidence?.report.reportHash ?? null) !== (deployment.walkForwardReportHash ?? null)) {
        throw new Error('Stored forward Signal deployment does not match its walk-forward report pin.');
      }
    }
  } else if (config?.helix_signal_artifact_hash || config?.helix_signal_artifact_path) {
    throw new Error('Stored non-signal strategy config contains an unexpected signal Artifact pin.');
  } else if (forwardRuntimeFromConfig(config)) {
    throw new Error('Stored non-signal strategy config contains an unexpected forward Signal deployment.');
  }
  const evidence = requireDeployableBacktestEvidence(
    requireCurrentBacktestEvidence(strategy, archivedArtifact?.artifact || null),
    archivedArtifact?.artifact || null,
  );
  if (archivedArtifact) requireSignalExecutionCompatibility(evidence, config, archivedArtifact);
  return { strategy, archivedArtifact, evidence };
}

function stageSignalBacktestDataset(file, artifact) {
  if (typeof file !== 'string' || !file.trim()) throw new Error('market_dataset must be a JSON file path');
  const source = resolve(file.trim());
  const dataset = loadMarketDataset(source);
  if (dataset.datasetHash !== artifact.identity.marketDataSnapshotId) {
    throw new Error('market_dataset hash does not match signal artifact marketDataSnapshotId');
  }
  if (dataset.source.symbol !== artifact.symbol) {
    throw new Error(`market_dataset symbol ${dataset.source.symbol} does not match signal artifact ${artifact.symbol}`);
  }
  const rendered = freqtradeOhlcvFile(dataset, artifact.baseTimeframe);
  const candles = dataset.timeframes[artifact.baseTimeframe];
  const marketWindow = requireMarketDatasetArtifactWindow(dataset, artifact);
  const lastCandleCloseTime = marketWindow.lastCandleCloseTime;
  const dataRoot = resolve(SIGNAL_BACKTEST_DATA_DIR, dataset.datasetHash.replace(':', '-'));
  const destination = resolve(dataRoot, rendered.relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  if (existsSync(destination)) {
    if (fileHash(destination) !== rendered.dataHash) {
      throw new Error(`staged market dataset is corrupt: ${destination}`);
    }
  } else {
    const temporary = `${destination}.tmp.${process.pid}`;
    writeFileSync(temporary, rendered.content);
    chmodSync(temporary, 0o600);
    renameSync(temporary, destination);
  }
  return {
    dataset,
    dataRoot,
    dataFile: destination,
    evidence: {
      datasetHash: dataset.datasetHash,
      provider: dataset.source.provider,
      market: dataset.source.market,
      instrumentId: dataset.source.instrumentId,
      symbol: dataset.source.symbol,
      baseTimeframe: artifact.baseTimeframe,
      dataHash: rendered.dataHash,
      candleCount: candles.length,
      firstCandleOpenTime: candles[0].time,
      activationCandleOpenTime: marketWindow.activationCandleOpenTime,
      warmupCandles: marketWindow.warmupCandles,
      lastCandleCloseTime,
    },
  };
}

function requireSignalDeploymentLifecycle(artifact, dryRun) {
  const allowed = dryRun
    ? new Set(['shadow', 'canary', 'production'])
    : new Set(['canary', 'production']);
  if (!allowed.has(artifact.strategyLifecycle)) {
    throw new Error(
      `Signal artifact lifecycle ${artifact.strategyLifecycle} cannot be deployed to ${dryRun ? 'dry-run' : 'live'}; `
      + `expected ${[...allowed].join(' or ')}.`,
    );
  }
}

function evidenceFilePath(resultsDir, file, name, validSuffixes) {
  if (typeof file !== 'string' || !file || basename(file) !== file
    || !validSuffixes.some((suffix) => file.endsWith(suffix))) {
    throw new Error(`${name} is invalid`);
  }
  return resolve(resultsDir, file);
}

function evidenceSignalArtifact(evidence, signalArtifact = null) {
  const expectedHash = evidence.signalArtifact?.artifactHash;
  if (typeof expectedHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(expectedHash)) {
    throw new Error(`Backtest evidence "${evidence.id}" has no valid signal artifact hash.`);
  }
  const artifact = signalArtifact || (() => {
    const file = resolve(SIGNAL_ARTIFACT_DIR, `${expectedHash.replace(':', '-')}.json`);
    if (!existsSync(file)) {
      throw new Error(`Backtest evidence "${evidence.id}" archived signal artifact is missing.`);
    }
    return loadSignalArtifact(file);
  })();
  if (artifact.artifactHash !== expectedHash
    || !isDeepStrictEqual(evidence.signalArtifact, signalArtifactEvidence(artifact))
    || evidence.marketDataset?.datasetHash !== artifact.identity.marketDataSnapshotId) {
    throw new Error(`Backtest evidence "${evidence.id}" does not match its signal artifact identity.`);
  }
  return artifact;
}

function verifyBacktestEvidenceResult(evidence, signalArtifact = null, requestedFee = null, riskContext = null) {
  if (!evidence?.resultFile) {
    throw new Error(`Backtest evidence "${evidence?.id || 'unknown'}" has no result file. Run backtest again before deploy.`);
  }
  if (!evidence.resultMetaFile) {
    throw new Error(`Backtest evidence "${evidence.id}" has no result metadata file. Run backtest again before deploy.`);
  }
  const resultsDir = dirname(BACKTEST_EVIDENCE_FILE);
  const resultFile = evidenceFilePath(resultsDir, evidence.resultFile, 'resultFile', ['.json', '.zip']);
  const resultBase = evidence.resultFile.replace(/\.(?:json|zip)$/, '');
  const expectedMetaFile = `${resultBase}.meta.json`;
  if (evidence.resultMetaFile !== expectedMetaFile) {
    throw new Error(`Backtest evidence "${evidence.id}" result metadata does not match its result file.`);
  }
  const resultMetaFile = evidenceFilePath(resultsDir, evidence.resultMetaFile, 'resultMetaFile', ['.meta.json']);
  const actualResultHash = fileHash(resultFile);
  if (!actualResultHash) throw new Error(`Backtest evidence "${evidence.id}" result file is missing.`);
  if (actualResultHash !== evidence.resultHash) {
    throw new Error(`Backtest evidence "${evidence.id}" result hash mismatch.`);
  }
  const actualResultMetaHash = fileHash(resultMetaFile);
  if (!actualResultMetaHash) throw new Error(`Backtest evidence "${evidence.id}" result metadata file is missing.`);
  if (actualResultMetaHash !== evidence.resultMetaHash) {
    throw new Error(`Backtest evidence "${evidence.id}" result metadata hash mismatch.`);
  }
  const meta = readJsonFile(resultMetaFile);
  if (!meta || !Object.prototype.hasOwnProperty.call(meta, evidence.strategy)) {
    throw new Error(`Backtest evidence "${evidence.id}" result metadata does not contain strategy "${evidence.strategy}".`);
  }
  const summary = firstStrategySummary(readBacktestPayload(resultsDir, evidence.resultFile), evidence.strategy);
  if (!summary) {
    throw new Error(`Backtest evidence "${evidence.id}" result payload does not contain strategy "${evidence.strategy}".`);
  }
  const verifiedSignalArtifact = evidence.strategy === HELIX_SIGNAL_STRATEGY
    ? evidenceSignalArtifact(evidence, signalArtifact)
    : null;
  const reconciliation = verifiedSignalArtifact
    ? reconcileSignalBacktest(summary, verifiedSignalArtifact)
    : null;
  if (fileHash(resultFile) !== actualResultHash || fileHash(resultMetaFile) !== actualResultMetaHash) {
    throw new Error(`Backtest evidence "${evidence.id}" result files changed during verification.`);
  }
  return {
    metrics: backtestMetrics(summary, riskContext),
    feeObservations: requestedFee === null ? null : backtestFeeObservations(summary, requestedFee),
    resultHash: actualResultHash,
    resultMetaHash: actualResultMetaHash,
    reconciliation,
    signalArtifact: verifiedSignalArtifact ? signalArtifactEvidence(verifiedSignalArtifact) : null,
  };
}

function requireDeployableBacktestEvidence(evidence, signalArtifact = null) {
  const verified = verifyBacktestEvidenceResult(evidence, signalArtifact);
  const metrics = verified.metrics;
  if (metrics.trades == null) {
    throw new Error(`Backtest evidence "${evidence.id}" has no verifiable trade/profit metrics. Run backtest again before deploy.`);
  }
  if (metrics.trades < 1) {
    throw new Error(`Backtest evidence "${evidence.id}" has 0 trades and cannot be deployed.`);
  }
  if (metrics.profitRatio == null) {
    throw new Error(`Backtest evidence "${evidence.id}" has no verifiable trade/profit metrics. Run backtest again before deploy.`);
  }
  if (metrics.profitRatio <= 0) {
    throw new Error(`Backtest evidence "${evidence.id}" is not profitable (${(metrics.profitRatio * 100).toFixed(2)}%). Deployment blocked.`);
  }
  return { ...evidence, ...verified, metrics };
}

function assertStrategyName(strategy) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(strategy || ''))) {
    throw new Error(`strategy 必须是 Python class 名称,例如 MyStrategy; 收到: ${strategy}`);
  }
  return strategy;
}

function startHostTrade(strategy) {
  const logFd = openSync(HOST.logFile, 'a');
  try {
    const child = spawn(FT_BIN, [
      'trade',
      '--config', CONFIG_PATH,
      '--strategy', strategy,
      '--userdir', USER_DATA,
    ], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: proxyEnv(),
    });
    child.unref();
    writeFileSync(HOST.pidFile, `${child.pid}\n`);
    return child.pid;
  } finally {
    closeSync(logFd);
  }
}

function writeHostApiEnvironment(config) {
  const values = {
    FREQTRADE_URL: FT_API_URL,
    FREQTRADE_USERNAME: String(config.api_server.username),
    FREQTRADE_PASSWORD: String(config.api_server.password),
  };
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8').split('\n') : [];
  for (const [key, value] of Object.entries(values)) {
    const index = lines.findIndex((line) => line.trim().startsWith(`${key}=`));
    if (index >= 0) lines[index] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  writeDeploymentFile(ENV_FILE, `${lines.filter((line, index) => line || index < lines.length - 1).join('\n').trimEnd()}\n`, 0o600);
}

async function rollbackHostDeployment(transaction, previous, originalError) {
  try {
    await stopHostDaemon();
    if (previous.running && !emergencyStopIsLatched(USER_DATA)) {
      await restartPreviousHostDeployment(transaction, previous);
    } else {
      restoreDeploymentFiles(transaction);
      if (emergencyStopIsLatched(USER_DATA)) persistStoppedDeploymentConfig();
    }
    updateDeploymentTransaction(USER_DATA, transaction, 'ROLLED_BACK', originalError.message);
  } catch (rollbackError) {
    try { await stopHostDaemon(); } catch {}
    try {
      updateDeploymentTransaction(
        USER_DATA,
        transaction,
        'FAILED_ROLLBACK',
        `${originalError.message}; rollback: ${rollbackError.message}`,
      );
    } catch {}
    throw new Error(`FAILED_ROLLBACK: ${originalError.message}; rollback failed: ${rollbackError.message}`);
  }
  try {
    discardDeploymentBackups(transaction);
  } catch (cleanupError) {
    throw new Error(`Deployment failed and was rolled back, but backup cleanup failed: ${cleanupError.message}`);
  }
  throw new Error(`Deployment failed and was rolled back: ${originalError.message}`);
}

async function recoverHostDeployment() {
  const transaction = readDeploymentTransaction(USER_DATA);
  if (transaction?.phase === 'FAILED_ROLLBACK') {
    throw new Error('FAILED_ROLLBACK requires operator intervention; automatic deployment is blocked');
  }
  if (!deploymentTransactionIsIncomplete(transaction)) {
    if (transaction) discardDeploymentBackups(transaction);
    return null;
  }
  if (transaction.phase === 'PREPARING' || transaction.phase === 'PREPARED') {
    if (transaction.previous?.running) {
      const previousConfig = readJsonFile(CONFIG_PATH);
      if (!previousConfig) throw new Error('host config is unreadable during prepared recovery');
      await requestHostEntryState(previousConfig, false);
      writeDeploymentFile(
        CONFIG_PATH,
        `${JSON.stringify({ ...previousConfig, initial_state: 'stopped' }, null, 4)}\n`,
        0o600,
      );
    }
    updateDeploymentTransaction(USER_DATA, transaction, 'ROLLED_BACK', 'recovered prepared host deployment');
    discardDeploymentBackups(transaction);
    return transaction.id;
  }
  const candidateForwardRuntime = forwardRuntimeFromConfig(readJsonFile(CONFIG_PATH));
  await stopHostDaemon();
  await stopForwardWorker(candidateForwardRuntime);
  await restartPreviousHostDeployment(transaction, transaction.previous, { restoreEntries: false });
  updateDeploymentTransaction(USER_DATA, transaction, 'ROLLED_BACK', 'recovered incomplete host deployment');
  discardDeploymentBackups(transaction);
  return transaction.id;
}

// 轻量 env 读取 — freqtrade-api.mjs 已经 loadEnv() 一次, 这里是为了 host
// 模式下的 detectExchange / appendEnv 等动作能拿到最新值.
function loadEnv() {
  for (const file of envFileCandidates()) {
    if (!existsSync(file)) continue;
    try {
      for (const line of readFileSync(file, 'utf-8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq < 1) continue;
        const key = t.slice(0, eq).trim();
        let val = t.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
        if (!process.env[key]) process.env[key] = val;
      }
    } catch {}
  }
}
loadEnv();

function appendEnv(key, val) {
  try { mkdirSync(dirname(ENV_FILE), { recursive: true }); } catch {} // ~/.helix 可能还不存在
  if (!existsSync(ENV_FILE)) {
    writeFileSync(ENV_FILE, `${key}=${val}\n`);
    try { chmodSync(ENV_FILE, 0o600); } catch {}
    return;
  }
  const content = readFileSync(ENV_FILE, 'utf-8');
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
  if (idx >= 0) {
    lines[idx] = `${key}=${val}`;
    writeFileSync(ENV_FILE, lines.join('\n'));
  } else {
    writeFileSync(ENV_FILE, content.trimEnd() + `\n${key}=${val}\n`);
  }
}

// 在三引擎容器里 .env 同时承载交易所 key + DRY_RUN + SELECTED_EXCHANGE,
// agent 直接告诉用户去 EnvSection 改, 不在脚本里写.
// host 模式下沿用老的"自己 nohup freqtrade"流程, 才需要这个 detectExchange.
function detectExchange() {
  const exchanges = ['BINANCE', 'OKX', 'BYBIT', 'BITGET', 'GATE', 'HTX', 'KUCOIN', 'MEXC'];
  for (const ex of exchanges) {
    if (process.env[`${ex}_API_KEY`] && process.env[`${ex}_API_SECRET`]) {
      return {
        name: ex.toLowerCase(),
        key: process.env[`${ex}_API_KEY`],
        secret: process.env[`${ex}_API_SECRET`],
        password: process.env[`${ex}_PASSWORD`] || '',
      };
    }
  }
  return null;
}

function requireMaxOpenTrades(value) {
  const maxOpenTrades = Number(value);
  if (!Number.isInteger(maxOpenTrades) || maxOpenTrades < 1 || maxOpenTrades > 2) {
    throw new Error('Deployment requires max_open_trades between 1 and 2.');
  }
  return maxOpenTrades;
}

function requireLiveAuthorization(params, cfg) {
  if (process.env.HELIX_LIVE_TRADING_ENABLED !== 'true') {
    throw new Error('Live trading is disabled. Set HELIX_LIVE_TRADING_ENABLED=true locally before authorization.');
  }
  if (process.env.HELIX_LIVE_AUTHORIZED !== '1') {
    throw new Error('Live deployment requires a fresh Dashboard live authorization session.');
  }

  requireMaxOpenTrades(params.max_open_trades ?? cfg.max_open_trades ?? 0);

  const configured = detectExchange();
  const exchange = String(cfg.exchange?.name || '').toLowerCase();
  if (!configured || configured.name !== exchange) {
    throw new Error(`Live deployment requires configured API credentials for ${exchange || 'the selected exchange'}.`);
  }
  if (exchange === 'okx' && !configured.password) {
    throw new Error('Live deployment on OKX requires the API passphrase.');
  }
}

// ─── coinclaw 模式: daemon 操作 ──────────────────────────────────
function readDaemonConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

function persistStoppedDeploymentConfig() {
  const config = readJsonFile(CONFIG_PATH);
  if (!config) throw new Error('Freqtrade config is unreadable while persisting stopped entry state');
  config.initial_state = 'stopped';
  writeDeploymentFile(CONFIG_PATH, `${JSON.stringify(config, null, 4)}\n`, 0o600);
}

function configPairs(cfg) {
  if (Array.isArray(cfg?.whitelist) && cfg.whitelist.length) return cfg.whitelist;
  if (Array.isArray(cfg?.pair_whitelist) && cfg.pair_whitelist.length) return cfg.pair_whitelist;
  return Array.isArray(cfg?.exchange?.pair_whitelist) ? cfg.exchange.pair_whitelist : [];
}

function managedDeploymentState(cfg) {
  return {
    strategy: String(cfg?.strategy || ''),
    dryRun: typeof cfg?.dry_run === 'boolean' ? cfg.dry_run : null,
    pairs: configPairs(cfg).map(String).sort(),
    timeframe: String(cfg?.timeframe || ''),
    maxOpenTrades: Number(cfg?.max_open_trades),
    artifactHash: typeof cfg?.helix_signal_artifact_hash === 'string'
      ? cfg.helix_signal_artifact_hash
      : null,
    artifactPath: typeof cfg?.helix_signal_artifact_path === 'string'
      ? cfg.helix_signal_artifact_path
      : null,
  };
}

function daemonEntriesRunning(cfg) {
  const state = String(cfg?.state || '').toLowerCase();
  if (!state) throw new Error('Freqtrade show_config did not report an entry state');
  return state !== 'stopped' && state !== 'stop';
}

function configuredInitialEntriesRunning(cfg) {
  const state = String(cfg?.initial_state || 'running').toLowerCase();
  if (state === 'running' || state === 'run') return true;
  if (state === 'stopped' || state === 'stop') return false;
  throw new Error(`Stored Freqtrade initial_state is invalid: ${state}`);
}

function sameManagedDeploymentState(actual, expected, { includeArtifact = false } = {}) {
  const baseMatches = actual.strategy === expected.strategy
    && actual.dryRun === expected.dryRun
    && actual.timeframe === expected.timeframe
    && actual.maxOpenTrades === expected.maxOpenTrades
    && actual.pairs.length === expected.pairs.length
    && actual.pairs.every((pair, index) => pair === expected.pairs[index]);
  return baseMatches && (!includeArtifact || (
    actual.artifactHash === expected.artifactHash
    && actual.artifactPath === expected.artifactPath
  ));
}

function discardDeploymentBackups(transaction) {
  cleanupDeploymentBackups(transaction);
}

function stopManagedDaemon() {
  if (IS_DOCKER) {
    dockerCompose(['stop', 'freqtrade'], { timeout: 60_000 });
    return { method: 'docker compose stop' };
  }
  if (!ENV) throw new Error('managed daemon stop is unavailable in host mode');
  const sock = supervisorSocket();
  execFileSync('supervisorctl', ['-s', `unix://${sock}`, 'stop', 'freqtrade'], {
    stdio: 'pipe', timeout: 30000,
  });
  return { method: 'supervisorctl stop' };
}

function startManagedDaemon() {
  if (IS_DOCKER) {
    dockerCompose(['up', '-d', '--no-deps', 'freqtrade'], { timeout: 60_000 });
    return { method: 'docker compose up' };
  }
  if (!ENV) throw new Error('managed daemon start is unavailable in host mode');
  const sock = supervisorSocket();
  execFileSync('supervisorctl', ['-s', `unix://${sock}`, 'start', 'freqtrade'], {
    stdio: 'pipe', timeout: 30000,
  });
  return { method: 'supervisorctl start' };
}

async function guardDaemonStart(operation, startCallback, stopCallback) {
  return withEntryTransitionLock(USER_DATA, operation, async () => {
    requireNoEmergencyStop(USER_DATA);
    try {
      const result = await startCallback();
      requireNoEmergencyStop(USER_DATA);
      return result;
    } catch (error) {
      try { await stopCallback(); } catch {}
      throw error;
    }
  });
}

async function waitForManagedDaemon(expected, timeoutMs = 60_000, abortOnEmergency = false) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'daemon did not respond';
  while (Date.now() < deadline) {
    if (abortOnEmergency) requireNoEmergencyStop(USER_DATA);
    try {
      const config = await ftGet('show_config', {}, { timeoutMs: 2_000 });
      const actual = managedDeploymentState(config);
      if (sameManagedDeploymentState(actual, expected)) return actual;
      lastError = `effective config mismatch: ${JSON.stringify({ actual, expected })}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`daemon readiness failed: ${lastError}`);
}

async function waitForManagedEntryState(
  expectedRunning,
  timeoutMs = Number(process.env.HELIX_TEST_ENTRY_TIMEOUT_MS) || 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'daemon entry state was not available';
  while (Date.now() < deadline) {
    try {
      const config = await ftGet('show_config', {}, { timeoutMs: 2_000 });
      if (daemonEntriesRunning(config) === expectedRunning) return config;
      lastError = `entry state remained ${String(config?.state || 'unknown')}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`entry state confirmation failed: ${lastError}`);
}

async function requestManagedEntryState(expectedRunning) {
  let response = null;
  let requestError = null;
  try {
    response = await ftPost(expectedRunning ? 'start' : 'stopentry', {}, { timeoutMs: 5_000 });
  } catch (error) {
    requestError = error;
  }
  try {
    await waitForManagedEntryState(expectedRunning);
  } catch (confirmationError) {
    const prefix = requestError ? `${requestError.message}; ` : '';
    throw new Error(`${prefix}${confirmationError.message}`);
  }
  return response;
}

async function activateManagedEntries(operation) {
  return withEntryTransitionLock(USER_DATA, operation, async () => {
    requireNoEmergencyStop(USER_DATA);
    const response = await requestManagedEntryState(true);
    if (emergencyStopIsLatched(USER_DATA)) {
      await requestManagedEntryState(false);
      throw new Error('entry activation was canceled by emergency stop latch');
    }
    return response;
  });
}

async function commitManagedEntryActivation(config) {
  return withEntryTransitionLock(USER_DATA, 'commit managed entry activation', async () => {
    requireNoEmergencyStop(USER_DATA);
    try {
      const response = await requestManagedEntryState(true);
      config.initial_state = 'running';
      writeDeploymentFile(CONFIG_PATH, `${JSON.stringify(config, null, 4)}\n`);
      requireNoEmergencyStop(USER_DATA);
      return response;
    } catch (error) {
      const convergenceErrors = [];
      try { await requestManagedEntryState(false); } catch (stopError) { convergenceErrors.push(stopError.message); }
      try {
        config.initial_state = 'stopped';
        writeDeploymentFile(CONFIG_PATH, `${JSON.stringify(config, null, 4)}\n`);
      } catch (writeError) {
        convergenceErrors.push(writeError.message);
      }
      const suffix = convergenceErrors.length > 0
        ? `; entry state could not be made safe: ${convergenceErrors.join('; ')}`
        : '; target remains committed with entries stopped';
      throw new Error(`${error.message}${suffix}`);
    }
  });
}

async function restartPreviousManagedDeployment(transaction, previous, { restoreEntries = true } = {}) {
  restoreDeploymentFiles(transaction);
  const restored = readJsonFile(CONFIG_PATH);
  if (!restored) throw new Error('restored managed config is unreadable');
  writeDeploymentFile(CONFIG_PATH, `${JSON.stringify({ ...restored, initial_state: 'stopped' }, null, 4)}\n`);
  startManagedDaemon();
  await waitForManagedDaemon(previous);
  await waitForManagedEntryState(false);
  await startStoredForwardWorker(restored);
  if (restoreEntries && previous.entriesRunning && !emergencyStopIsLatched(USER_DATA)) {
    await activateManagedEntries('restore managed entry state');
    restoreDeploymentFiles(transaction);
  } else if (restoreEntries && !previous.entriesRunning) {
    restoreDeploymentFiles(transaction);
  }
}

async function stopEntries() {
  return requestManagedEntryState(false);
}

async function requireFlatBot() {
  const openTrades = await ftGet('status', {}, { timeoutMs: 5_000 });
  if (!Array.isArray(openTrades)) throw new Error('Freqtrade status did not return open trades');
  if (openTrades.length > 0) {
    throw new Error(`Deployment requires a flat bot; ${openTrades.length} open trade(s) remain.`);
  }
}

function managedAdapterDestinations(signalArtifact) {
  if (!signalArtifact) return [];
  return SIGNAL_ADAPTER_FILES
    .map((name) => resolve(STRAT_DIR, name))
    .filter((destination) => !SIGNAL_ADAPTER_FILES
      .map((name) => resolve(SIGNAL_ADAPTER_ASSET_DIR, name))
      .includes(destination));
}

async function rollbackManagedDeployment(transaction, previous, originalError) {
  try {
    stopManagedDaemon();
    if (!emergencyStopIsLatched(USER_DATA)) {
      await restartPreviousManagedDeployment(transaction, previous);
    } else {
      restoreDeploymentFiles(transaction);
      persistStoppedDeploymentConfig();
    }
    updateDeploymentTransaction(USER_DATA, transaction, 'ROLLED_BACK', originalError.message);
  } catch (rollbackError) {
    try { stopManagedDaemon(); } catch {}
    try {
      updateDeploymentTransaction(
        USER_DATA,
        transaction,
        'FAILED_ROLLBACK',
        `${originalError.message}; rollback: ${rollbackError.message}`,
      );
    } catch {}
    throw new Error(`FAILED_ROLLBACK: ${originalError.message}; rollback failed: ${rollbackError.message}`);
  }
  try {
    discardDeploymentBackups(transaction);
  } catch (cleanupError) {
    throw new Error(`Deployment failed and was rolled back, but backup cleanup failed: ${cleanupError.message}`);
  }
  throw new Error(`Deployment failed and was rolled back: ${originalError.message}`);
}

async function recoverManagedDeployment() {
  const transaction = readDeploymentTransaction(USER_DATA);
  if (transaction?.phase === 'FAILED_ROLLBACK') {
    throw new Error('FAILED_ROLLBACK requires operator intervention; automatic deployment is blocked');
  }
  if (!deploymentTransactionIsIncomplete(transaction)) {
    if (transaction) discardDeploymentBackups(transaction);
    return null;
  }
  if (transaction.phase === 'PREPARING' || transaction.phase === 'PREPARED') {
    await requestManagedEntryState(false);
    const config = readDaemonConfig();
    config.initial_state = 'stopped';
    writeDeploymentFile(CONFIG_PATH, `${JSON.stringify(config, null, 4)}\n`);
    updateDeploymentTransaction(USER_DATA, transaction, 'ROLLED_BACK', 'recovered prepared deployment');
    discardDeploymentBackups(transaction);
    return transaction.id;
  }
  try {
    await stopEntries();
    await requireFlatBot();
  } catch (error) {
    if (/flat bot|did not return open trades/.test(String(error.message))) throw error;
  }
  const candidateForwardRuntime = forwardRuntimeFromConfig(readJsonFile(CONFIG_PATH));
  stopManagedDaemon();
  await stopForwardWorker(candidateForwardRuntime);
  await restartPreviousManagedDeployment(transaction, transaction.previous, { restoreEntries: false });
  updateDeploymentTransaction(USER_DATA, transaction, 'ROLLED_BACK', 'recovered incomplete deployment');
  discardDeploymentBackups(transaction);
  return transaction.id;
}

// 通过 dump+grep ps 拿 daemon 当前用的 strategy / pair_whitelist 等运行
// 时配置. /api/v1/show_config 是最稳的来源, 跟 freqtrade UI/dashboard 一致.
async function fetchDaemonState() {
  try {
    const cfg = await ftGet('show_config');
    return { online: true, ...cfg };
  } catch (e) {
    return { online: false, error: e.message };
  }
}

// ─── host 模式: 自己管 freqtrade 进程 ───────────────────────────
function getHostPid() {
  if (!HOST.pidFile || !existsSync(HOST.pidFile)) return null;
  const pid = readFileSync(HOST.pidFile, 'utf-8').trim();
  if (!pid) return null;
  try { process.kill(Number(pid), 0); return Number(pid); } catch { return null; }
}

function hostPidIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

async function waitForHostPidExit(pid, timeoutMs = Number(process.env.HELIX_TEST_DEPLOY_TIMEOUT_MS) || 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!hostPidIsAlive(pid)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`host Freqtrade process ${pid} did not exit after SIGTERM`);
}

async function stopHostDaemon() {
  const pid = getHostPid();
  if (pid) {
    process.kill(pid, 'SIGTERM');
    await waitForHostPidExit(pid);
  }
  try { writeFileSync(HOST.pidFile, ''); } catch {}
  return pid;
}

function hostApiCredentials(config) {
  const username = String(config?.api_server?.username || 'freqtrade');
  const password = String(config?.api_server?.password || '');
  if (!password) throw new Error('host Freqtrade config has no API password');
  return { username, password };
}

async function hostApiRequest(config, path, { method = 'GET', body, timeoutMs = 3_000 } = {}) {
  const { username, password } = hostApiCredentials(config);
  const response = await fetch(`${FT_API_URL}/api/v1/${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Freqtrade ${response.status}: ${await response.text()}`);
  return response.json();
}

async function waitForHostDaemon(
  expected,
  config,
  timeoutMs = Number(process.env.HELIX_TEST_DEPLOY_TIMEOUT_MS) || 30_000,
  abortOnEmergency = false,
) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'host daemon did not respond';
  while (Date.now() < deadline) {
    if (abortOnEmergency) requireNoEmergencyStop(USER_DATA);
    try {
      if (!getHostPid()) throw new Error('host daemon process exited');
      const actual = managedDeploymentState(await hostApiRequest(config, 'show_config'));
      if (sameManagedDeploymentState(actual, expected)) return actual;
      lastError = `effective config mismatch: ${JSON.stringify({ actual, expected })}`;
    } catch (error) {
      lastError = error.message;
      if (lastError === 'host daemon process exited') break;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`host daemon readiness failed: ${lastError}`);
}

async function waitForHostEntryState(
  config,
  expectedRunning,
  timeoutMs = Number(process.env.HELIX_TEST_ENTRY_TIMEOUT_MS) || 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'host daemon entry state was not available';
  while (Date.now() < deadline) {
    try {
      const effective = await hostApiRequest(config, 'show_config');
      if (daemonEntriesRunning(effective) === expectedRunning) return effective;
      lastError = `entry state remained ${String(effective?.state || 'unknown')}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`host entry state confirmation failed: ${lastError}`);
}

async function requestHostEntryState(config, expectedRunning) {
  let response = null;
  let requestError = null;
  try {
    response = await hostApiRequest(config, expectedRunning ? 'start' : 'stopentry', { method: 'POST', body: {} });
  } catch (error) {
    requestError = error;
  }
  try {
    await waitForHostEntryState(config, expectedRunning);
  } catch (confirmationError) {
    const prefix = requestError ? `${requestError.message}; ` : '';
    throw new Error(`${prefix}${confirmationError.message}`);
  }
  return response;
}

async function activateHostEntries(config, operation) {
  return withEntryTransitionLock(USER_DATA, operation, async () => {
    requireNoEmergencyStop(USER_DATA);
    const response = await requestHostEntryState(config, true);
    if (emergencyStopIsLatched(USER_DATA)) {
      await requestHostEntryState(config, false);
      throw new Error('host entry activation was canceled by emergency stop latch');
    }
    return response;
  });
}

async function commitHostEntryActivation(config) {
  return withEntryTransitionLock(USER_DATA, 'commit host entry activation', async () => {
    requireNoEmergencyStop(USER_DATA);
    try {
      const response = await requestHostEntryState(config, true);
      config.initial_state = 'running';
      writeDeploymentFile(CONFIG_PATH, `${JSON.stringify(config, null, 4)}\n`, 0o600);
      requireNoEmergencyStop(USER_DATA);
      return response;
    } catch (error) {
      const convergenceErrors = [];
      try { await requestHostEntryState(config, false); } catch (stopError) { convergenceErrors.push(stopError.message); }
      try {
        config.initial_state = 'stopped';
        writeDeploymentFile(CONFIG_PATH, `${JSON.stringify(config, null, 4)}\n`, 0o600);
      } catch (writeError) {
        convergenceErrors.push(writeError.message);
      }
      const suffix = convergenceErrors.length > 0
        ? `; host entry state could not be made safe: ${convergenceErrors.join('; ')}`
        : '; target remains committed with entries stopped';
      throw new Error(`${error.message}${suffix}`);
    }
  });
}

async function restartPreviousHostDeployment(transaction, previous, { restoreEntries = true } = {}) {
  restoreDeploymentFiles(transaction);
  if (!previous.running) return;
  const restoredConfig = readJsonFile(CONFIG_PATH);
  if (!restoredConfig) throw new Error('restored host config is unreadable');
  const stoppedConfig = { ...restoredConfig, initial_state: 'stopped' };
  writeDeploymentFile(CONFIG_PATH, `${JSON.stringify(stoppedConfig, null, 4)}\n`, 0o600);
  startHostTrade(previous.state.strategy);
  await waitForHostDaemon(previous.state, stoppedConfig);
  await waitForHostEntryState(stoppedConfig, false);
  await startStoredForwardWorker(restoredConfig);
  if (restoreEntries && previous.state.entriesRunning && !emergencyStopIsLatched(USER_DATA)) {
    await activateHostEntries(restoredConfig, 'restore host entry state');
    restoreDeploymentFiles(transaction);
  } else if (restoreEntries && !previous.state.entriesRunning) {
    restoreDeploymentFiles(transaction);
  }
}

async function stopHostEntries(config) {
  return requestHostEntryState(config, false);
}

async function requireFlatHostBot(config) {
  const openTrades = await hostApiRequest(config, 'status');
  if (!Array.isArray(openTrades)) throw new Error('Freqtrade status did not return open trades');
  if (openTrades.length > 0) {
    throw new Error(`Deployment requires a flat bot; ${openTrades.length} open trade(s) remain.`);
  }
}

function findPython() {
  const names = ['python3.13', 'python3.12', 'python3.11', 'python3'];
  const extraDirs = ['/opt/homebrew/bin', '/usr/local/bin', `${process.env.HOME}/.local/bin`];
  const candidates = [...names];
  for (const dir of extraDirs) {
    for (const n of names.slice(0, 3)) candidates.push(resolve(dir, n));
  }
  for (const bin of candidates) {
    try {
      const version = runFile(bin, ['--version']);
      const match = version.match(/(\d+)\.(\d+)/);
      if (match) {
        const major = Number(match[1]); const minor = Number(match[2]);
        if (major === 3 && minor >= 11) return { bin, major, minor, version };
      }
    } catch {}
  }
  return null;
}

function ensureModernPython() {
  let py = findPython();
  if (py) return py;

  if (process.platform === 'darwin') {
    try {
      const uvBin = resolve(process.env.HOME || '', '.local', 'bin', 'uv');
      if (!existsSync(uvBin)) {
        console.error('Installing uv (fast Python manager)...');
        run('curl -LsSf https://astral.sh/uv/install.sh | sh', { timeout: 60000 });
      }
      if (existsSync(uvBin)) {
        console.error('Installing Python 3.12 via uv...');
        runFile(uvBin, ['python', 'install', '3.12'], { timeout: 300000 });
        try {
          const pyPath = runFile(uvBin, ['python', 'find', '3.12']);
          if (pyPath) {
            const ver = runFile(pyPath, ['--version']);
            const m = ver.match(/(\d+)\.(\d+)/);
            if (m && Number(m[1]) === 3 && Number(m[2]) >= 11) {
              return { bin: pyPath, major: Number(m[1]), minor: Number(m[2]), version: ver };
            }
          }
        } catch {}
      }
    } catch (e) { console.error(`uv: ${e.message}`); }

    try {
      if (hasCommand('brew')) {
        console.error('Trying brew install python@3.12...');
        const brewEnv = { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1' };
        runFile('brew', ['install', 'python@3.12'], { timeout: 300000, env: brewEnv });
        py = findPython();
        if (py) return py;
      }
    } catch (e) { console.error(`brew: ${e.message}`); }
  }

  throw new Error('Python 3.11+ required. Install options:\n• curl -LsSf https://astral.sh/uv/install.sh | sh && uv python install 3.12\n• brew install python@3.12\n• https://www.python.org/downloads/');
}

function generateHostConfig(exchangeInfo, apiPassword, params = {}) {
  const config = {
    ...(params.timeframe ? { timeframe: params.timeframe } : {}),
    ...(params.helix_signal_artifact_path ? {
      helix_signal_artifact_path: params.helix_signal_artifact_path,
      helix_signal_artifact_hash: params.helix_signal_artifact_hash,
    } : {}),
    ...(params.fee !== undefined ? { fee: params.fee } : {}),
    trading_mode: params.trading_mode || 'futures',
    margin_mode: params.margin_mode || 'isolated',
    max_open_trades: params.max_open_trades || 2,
    stake_currency: 'USDT',
    stake_amount: params.stake_amount || 'unlimited',
    tradable_balance_ratio: params.tradable_balance_ratio ?? (params.helix_signal_artifact_path ? 1 : 0.5),
    dry_run: params.dry_run !== false,
    dry_run_wallet: params.dry_run_wallet ?? 1000,
    cancel_open_orders_on_exit: false,
    exchange: {
      name: exchangeInfo.name,
      key: exchangeInfo.key,
      secret: exchangeInfo.secret,
      ...(exchangeInfo.password ? { password: exchangeInfo.password } : {}),
      ccxt_config: {},
      ccxt_async_config: {},
      pair_whitelist: params.pairs || ['BTC/USDT:USDT', 'ETH/USDT:USDT'],
      pair_blacklist: [],
    },
    pairlists: [{ method: 'StaticPairList' }],
    entry_pricing: { price_side: 'same', use_order_book: true, order_book_top: 1 },
    exit_pricing: { price_side: 'same', use_order_book: true, order_book_top: 1 },
    api_server: {
      enabled: true,
      listen_ip_address: IS_DOCKER ? '0.0.0.0' : '127.0.0.1',
      listen_port: IS_DOCKER ? 8080 : FT_API_PORT,
      verbosity: 'error',
      enable_openapi: false,
      jwt_secret_key: randomBytes(16).toString('hex'),
      CORS_origins: [],
      // freqtrade 三引擎容器里 daemon user 都是 'freqtrade', host 模式跟齐 —
      // 老版本默认 'freqtrader' 跟容器不一致, 历史 bug.
      username: 'freqtrade',
      password: apiPassword,
    },
    bot_name: 'helix-freqtrade',
    initial_state: 'running',
    force_entry_enable: true,
    internals: { process_throttle_secs: 5 },
  };
  const proxyUrl = process.env.PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (proxyUrl) {
    config.exchange.ccxt_config.proxies = { https: proxyUrl, http: proxyUrl };
    config.exchange.ccxt_async_config.aiohttp_proxy = proxyUrl;
    config.exchange.enable_ws = false;
  }
  return config;
}

// ─── 公共: 确保 strategy 目录存在 ────────────────────────────────
function ensureStrategyDir() {
  mkdirSync(STRAT_DIR, { recursive: true });
}

function ensureHostFreqtradeInstalled() {
  if (IS_DOCKER) {
    if (!hasCommand('docker')) throw new Error('Docker is required for the configured Freqtrade runtime.');
    if (!existsSync(ENV.composeFile)) throw new Error(`Freqtrade compose file not found: ${ENV.composeFile}`);
    return;
  }
  if (ENV || existsSync(FT_BIN)) return;
  const py = ensureModernPython();
  console.error(`Using ${py.version} (${py.bin})`);
  if (!hasCommand('git')) throw new Error('git not found.');

  ensureStrategyDir();
  if (!existsSync(resolve(HOST.sourceDir, 'setup.sh'))) {
    console.error('Cloning Freqtrade repository...');
    runFile('git', ['clone', 'https://github.com/freqtrade/freqtrade.git', HOST.sourceDir], { timeout: 120000 });
    runFile('git', ['checkout', 'stable'], { cwd: HOST.sourceDir, timeout: 30000 });
  }

  console.error('Running Freqtrade setup.sh (this may take a few minutes)...');
  const pyDir = dirname(py.bin);
  const setupEnv = { ...process.env, PATH: `${pyDir}:${process.env.PATH}` };
  runFile(resolve(HOST.sourceDir, 'setup.sh'), ['-i'], { cwd: HOST.sourceDir, timeout: 600000, env: setupEnv });
  if (!existsSync(FT_BIN)) throw new Error('Freqtrade installation failed.');
}

// ─── Actions ─────────────────────────────────────────────────────
const actions = {
  // ── check ──────────────────────────────────────────────────────
  // coinclaw 模式: ping daemon + show_config + balance.
  // host 模式: 检查 python / git / freqtrade installed / pid.
  check: async () => {
    if (ENV) {
      const checks = { mode: runtimeMode(), engine: ENV.engine, paths: {
        userdir: USER_DATA, strategy_path: STRAT_DIR, config: CONFIG_PATH,
      }};
      const state = await fetchDaemonState();
      checks.daemon_online = state.online;
      if (state.online) {
        checks.strategy = state.strategy;
        checks.exchange = state.exchange;
        checks.dry_run = state.dry_run;
        checks.timeframe = state.timeframe;
        checks.trading_mode = state.trading_mode;
        try {
          const bal = await ftGet('balance');
          checks.total = bal.total;
          checks.starting_capital = bal.starting_capital;
          checks.stake_currency = bal.stake;
        } catch (e) { checks.balance_error = e.message; }
      } else {
        checks.note = IS_DOCKER
          ? 'Docker daemon 未响应; 使用 ft-deploy.mjs logs 查看容器日志。'
          : '在 coinclaw 容器里 daemon 由 supervisord 管理, 它没起来通常是 cold-start 卡住或 config 写错; 看 /workspace/logs/freqtrade-error.log 或 /home/node/.openclaw/workspace/.freqtrade/logs/';
      }
      return checks;
    }
    // host mode
    const checks = { mode: 'host' };
    const py = findPython();
    checks.python = py ? `${py.version} (${py.bin})` : false;
    if (!py) {
      try {
        const v = runFile('python3', ['--version']);
        checks.python_warning = `${v} found but Freqtrade requires 3.11+. Deploy will auto-install 3.12.`;
      } catch {}
    }
    checks.git = hasCommand('git');
    checks.source_cloned = existsSync(resolve(HOST.sourceDir, 'setup.sh'));
    checks.freqtrade_installed = existsSync(FT_BIN);
    if (checks.freqtrade_installed) {
      try { checks.freqtrade_version = runFile(FT_BIN, ['--version']); } catch {}
    }
    const ex = detectExchange();
    checks.exchange = ex ? { name: ex.name, configured: true } : { configured: false };
    const pid = getHostPid();
    checks.running = !!pid;
    if (pid) checks.pid = pid;
    checks.ready = (!!py || process.platform === 'darwin') && checks.git && checks.exchange?.configured;
    if (!checks.ready) {
      checks.missing = [];
      if (!py && process.platform !== 'darwin') checks.missing.push('Python 3.11+ not found');
      if (!checks.git) checks.missing.push('git not found');
      if (!checks.exchange?.configured) checks.missing.push('No exchange API keys in .env');
    }
    return checks;
  },

  // ── deploy ─────────────────────────────────────────────────────
  // coinclaw 模式: 写策略 (如果 caller 已 create_strategy 就是 no-op) +
  //   改 config.strategy + 重启 daemon. 不再 git clone, 不再 nohup.
  // host 模式: 沿用老路径 (clone + setup.sh + nohup).
  deploy: async (params = {}) => {
    const archivedArtifact = resolveSignalArtifact(params);
    const signalArtifact = archivedArtifact?.artifact || null;
    const walkForwardEvidence = resolveSignalWalkForwardReport(params, signalArtifact);
    const strategy = params.strategy
      ? assertStrategyName(params.strategy)
      : signalArtifact ? HELIX_SIGNAL_STRATEGY : null;
    if (!strategy) throw new Error('strategy 必填, 例: {"strategy":"MyStrat"}');
    if (strategy === HELIX_SIGNAL_STRATEGY && !signalArtifact) {
      throw new Error('HelixSignalStrategy deployment requires signal_artifact so its pinned identity can be verified.');
    }
    if (signalArtifact && strategy !== HELIX_SIGNAL_STRATEGY) {
      throw new Error(`signal_artifact can only be deployed with ${HELIX_SIGNAL_STRATEGY}.`);
    }
    const deploymentPairs = params.pairs
      ? (Array.isArray(params.pairs) ? params.pairs : [params.pairs])
      : [];
    if (signalArtifact && deploymentPairs.length && (
      deploymentPairs.length !== 1 || deploymentPairs[0] !== signalArtifact.symbol
    )) {
      throw new Error(`Signal artifact deployment pair must be exactly ${signalArtifact.symbol}.`);
    }
    const stratFile = resolve(STRAT_DIR, `${strategy}.py`);
    if (strategy !== HELIX_SIGNAL_STRATEGY && !existsSync(stratFile)) {
      throw new Error(`策略文件不存在: ${stratFile}. 先用 create_strategy 创建策略并完成回测。`);
    }
    requireDeployableBacktestEvidence(
      requireCurrentBacktestEvidence(strategy, signalArtifact),
      signalArtifact,
    );

    if (ENV) {
      return withDeploymentLock(USER_DATA, 'deploy', async () => {
        const hadEmergencyLatch = emergencyStopIsLatched(USER_DATA);
        let emergencyLatchCleared = false;
        await recoverManagedDeployment();
        let evidence = requireDeployableBacktestEvidence(
          requireCurrentBacktestEvidence(strategy, signalArtifact),
          signalArtifact,
        );
        const cfg = readDaemonConfig();
        const effectiveConfigBefore = await ftGet('show_config', {}, { timeoutMs: 5_000 });
        const effectiveBefore = {
          ...managedDeploymentState(effectiveConfigBefore),
          entriesRunning: daemonEntriesRunning(effectiveConfigBefore),
        };
        const configuredBefore = managedDeploymentState(cfg);
        if (!sameManagedDeploymentState(configuredBefore, effectiveBefore)) {
          throw new Error('Stored Freqtrade config does not match the running daemon; reconcile before deployment.');
        }
        if (configuredInitialEntriesRunning(cfg) !== effectiveBefore.entriesRunning) {
          throw new Error('Stored Freqtrade initial_state does not match the running daemon entry state; reconcile before deployment.');
        }
        const targetDryRun = typeof params.dry_run === 'boolean' ? params.dry_run : cfg.dry_run;
        const maxOpenTrades = requireMaxOpenTrades(params.max_open_trades ?? cfg.max_open_trades ?? 2);
        if (signalArtifact) requireSignalDeploymentLifecycle(signalArtifact, targetDryRun);
        requireSignalWalkForwardReport(signalArtifact, walkForwardEvidence);
        if (targetDryRun === false) requireLiveAuthorization({ ...params, max_open_trades: maxOpenTrades }, cfg);
        const previousForwardRuntime = forwardRuntimeFromConfig(cfg);
        let forwardDeployment = null;
        let forwardPaths = null;
        if (signalArtifact) {
          if (targetDryRun !== true) throw new Error('Helix Signal forward deployment currently supports dry-run only.');
          if (String(cfg.exchange?.name || '').toLowerCase() !== 'okx') {
            throw new Error('Forward Signal deployment currently requires the OKX futures market data identity.');
          }
          const duration = marketTimeframeMilliseconds(signalArtifact.baseTimeframe);
          const activatedAt = (Math.floor(Date.now() / duration) + 3) * duration;
          forwardDeployment = createForwardDeployment(signalArtifact, {
            activatedAt,
            walkForwardReportHash: walkForwardEvidence?.report.reportHash ?? null,
          });
          forwardPaths = forwardRuntimePaths(forwardDeployment);
        }

        const next = structuredClone(cfg);
        next.strategy = strategy;
        next.dry_run = targetDryRun;
        if (deploymentPairs.length) {
          if (!next.exchange) next.exchange = {};
          next.exchange.pair_whitelist = deploymentPairs;
        } else if (signalArtifact) {
          if (!next.exchange) next.exchange = {};
          next.exchange.pair_whitelist = [signalArtifact.symbol];
        }
        if (signalArtifact) {
          next.timeframe = signalArtifact.baseTimeframe;
          next.tradable_balance_ratio = 1;
          next.dry_run_wallet = walkForwardReferenceAccountEquity(walkForwardEvidence);
          next.fee = walkForwardDeploymentFee(walkForwardEvidence);
          next.helix_signal_artifact_path = dockerCliPath(archivedArtifact.hashFile);
          next.helix_signal_artifact_hash = signalArtifact.artifactHash;
          if (forwardDeployment) configureForwardRuntime(next, forwardDeployment, forwardPaths);
          else clearForwardRuntimeConfig(next);
          configureWalkForwardReport(next, walkForwardEvidence);
        } else {
          delete next.helix_signal_artifact_path;
          delete next.helix_signal_artifact_hash;
          clearForwardRuntimeConfig(next);
          configureWalkForwardReport(next, null);
        }
        next.max_open_trades = maxOpenTrades;
        next.initial_state = 'stopped';
        const target = managedDeploymentState(next);
        if (archivedArtifact) requireSignalExecutionCompatibility(evidence, next, archivedArtifact);
        const adapterDestinations = managedAdapterDestinations(signalArtifact);
        const transaction = beginDeploymentTransaction(USER_DATA, {
          operation: 'deploy',
          files: [CONFIG_PATH, ...adapterDestinations, ...(forwardPaths ? [forwardPaths.deploymentFile] : [])],
          previous: effectiveBefore,
          target,
        });
        let entriesStopped = false;
        let previousForwardStopped = false;
        let forwardWorkerStarted = false;
        try {
          await stopEntries();
          entriesStopped = true;
          await requireFlatBot();
          if (previousForwardRuntime) {
            await stopForwardWorker(previousForwardRuntime);
            previousForwardStopped = true;
          }
          updateDeploymentTransaction(USER_DATA, transaction, 'FLAT');
          stopManagedDaemon();
          updateDeploymentTransaction(USER_DATA, transaction, 'STOPPED');
          if (signalArtifact) installSignalAdapter();
          if (forwardDeployment) {
            writeDeploymentFile(forwardPaths.deploymentFile, `${JSON.stringify(forwardDeployment, null, 2)}\n`);
          }
          evidence = requireDeployableBacktestEvidence(
            requireCurrentBacktestEvidence(strategy, signalArtifact),
            signalArtifact,
          );
          if (archivedArtifact) requireSignalExecutionCompatibility(evidence, next, archivedArtifact);
          requireUnchangedWalkForwardReport(walkForwardEvidence, signalArtifact);
          const configContent = `${JSON.stringify(next, null, 4)}\n`;
          const targetConfigHash = `sha256:${createHash('sha256').update(configContent).digest('hex')}`;
          if (writeDeploymentFile(CONFIG_PATH, configContent) !== targetConfigHash) {
            throw new Error('candidate config hash mismatch after commit');
          }
          updateDeploymentTransaction(USER_DATA, transaction, 'COMMITTED');
          const start = startManagedDaemon();
          const effective = await waitForManagedDaemon(target, 60_000, !hadEmergencyLatch);
          if (signalArtifact) requireInstalledSignalAdapter();
          evidence = requireDeployableBacktestEvidence(
            requireCurrentBacktestEvidence(strategy, signalArtifact),
            signalArtifact,
          );
          if (archivedArtifact) requireSignalExecutionCompatibility(evidence, next, archivedArtifact);
          requireUnchangedWalkForwardReport(walkForwardEvidence, signalArtifact);
          const stored = readDaemonConfig();
          if (!sameManagedDeploymentState(managedDeploymentState(stored), target, { includeArtifact: true })) {
            throw new Error('stored signal artifact hash does not match deployment target');
          }
          if (signalArtifact && loadSignalArtifact(archivedArtifact.hashFile).artifactHash !== signalArtifact.artifactHash) {
            throw new Error('deployed signal artifact archive failed postcondition verification');
          }
          let forwardStatus = null;
          let forwardPid = null;
          if (forwardDeployment) {
            const firstDecisionTime = forwardDeployment.activatedAt
              + marketTimeframeMilliseconds(forwardDeployment.strategy.baseTimeframe);
            if (Date.now() >= firstDecisionTime) {
              throw new Error('Candidate readiness missed the first forward decision boundary; deploy again.');
            }
            forwardPid = startForwardWorker(forwardPaths);
            forwardWorkerStarted = true;
            forwardStatus = await waitForForwardWorker(forwardPaths, forwardDeployment.deploymentHash);
          }
          if (hadEmergencyLatch) {
            clearEmergencyStopLatch(USER_DATA);
            emergencyLatchCleared = true;
          }
          requireNoEmergencyStop(USER_DATA);
          updateDeploymentTransaction(USER_DATA, transaction, 'ACTIVE');
          try {
            await commitManagedEntryActivation(next);
          } catch (startError) {
            try { discardDeploymentBackups(transaction); } catch (cleanupError) {
              throw new Error(`Deployment committed but entry activation failed: ${startError.message}; backup cleanup failed: ${cleanupError.message}`);
            }
            throw new Error(`Deployment committed but entry activation failed: ${startError.message}`);
          }
          discardDeploymentBackups(transaction);
          return {
            success: true,
            mode: runtimeMode(),
            engine: ENV.engine,
            strategy,
            dry_run: targetDryRun,
            pairs: target.pairs,
            max_open_trades: maxOpenTrades,
            before: effectiveBefore,
            effective,
            start,
            transaction_id: transaction.id,
            backtest_evidence: evidence.id,
            signal_artifact: signalArtifact ? {
              hash: signalArtifact.artifactHash,
              identity: pinnedSignalIdentity(signalArtifact),
              lifecycle: signalArtifact.strategyLifecycle,
              active_file: archivedArtifact.hashFile,
            } : null,
            walk_forward_report: walkForwardEvidence ? {
              hash: walkForwardEvidence.report.reportHash,
              file: walkForwardEvidence.file,
            } : null,
            forward_runtime: forwardDeployment ? {
              deployment_hash: forwardDeployment.deploymentHash,
              activated_at: forwardDeployment.activatedAt,
              worker_pid: forwardPid,
              state: forwardStatus.state,
              deployment_file: forwardPaths.deploymentFile,
              batches: forwardPaths.batchesDirectory,
            } : null,
            config_path: CONFIG_PATH,
            strategy_file: stratFile,
            note: 'Deployment is active and verified against the daemon effective config.',
            warning: targetDryRun === false
              ? '⚠️ 已切到实盘 — 真实交易, 真实亏损. 确认 .env 里交易所 key 正确, 余额可控.'
              : null,
          };
        } catch (error) {
          if (forwardWorkerStarted) {
            try { await stopForwardWorker(forwardPaths); } catch (stopError) {
              error = new Error(`${error.message}; failed to stop forward worker: ${stopError.message}`);
            }
          }
          if (emergencyLatchCleared && !emergencyStopIsLatched(USER_DATA)) {
            setEmergencyStopLatch(USER_DATA);
          }
          const phase = readDeploymentTransaction(USER_DATA)?.phase;
          if (phase === 'ACTIVE') {
            const convergenceErrors = [];
            try { await requestManagedEntryState(false); } catch (stopError) { convergenceErrors.push(stopError.message); }
            try { persistStoppedDeploymentConfig(); } catch (writeError) { convergenceErrors.push(writeError.message); }
            const suffix = convergenceErrors.length > 0
              ? `; ACTIVE deployment could not be made safe: ${convergenceErrors.join('; ')}`
              : '; target remains committed with entries stopped';
            throw new Error(`${error.message}${suffix}`);
          }
          if (phase === 'PREPARED') {
            if (entriesStopped && effectiveBefore.entriesRunning && !emergencyStopIsLatched(USER_DATA)) {
              try {
                if (previousForwardStopped) await startStoredForwardWorker(cfg);
                await activateManagedEntries('restore entry state after rejected deployment');
              } catch (resumeError) {
                throw new Error(`${error.message}; failed to restore entry state: ${resumeError.message}`);
              }
            }
            if (emergencyStopIsLatched(USER_DATA)) persistStoppedDeploymentConfig();
            updateDeploymentTransaction(USER_DATA, transaction, 'ROLLED_BACK', error.message);
            discardDeploymentBackups(transaction);
            throw error;
          }
          return rollbackManagedDeployment(transaction, effectiveBefore, error);
        }
      });
    }
    // host mode
    const targetDryRun = params.dry_run !== false;
    const maxOpenTrades = requireMaxOpenTrades(params.max_open_trades ?? 2);
    if (signalArtifact) requireSignalDeploymentLifecycle(signalArtifact, targetDryRun);
    requireSignalWalkForwardReport(signalArtifact, walkForwardEvidence);
    if (!targetDryRun) {
      requireLiveAuthorization({ ...params, max_open_trades: maxOpenTrades }, {
        max_open_trades: maxOpenTrades,
        exchange: { name: params.exchange || detectExchange()?.name || '' },
      });
    }
    return withDeploymentLock(USER_DATA, 'deploy', async () => {
      const hadEmergencyLatch = emergencyStopIsLatched(USER_DATA);
      let emergencyLatchCleared = false;
      await recoverHostDeployment();
      ensureHostFreqtradeInstalled();
      const previousConfig = readJsonFile(CONFIG_PATH);
      const wasRunning = Boolean(getHostPid());
      let effectiveBefore = previousConfig
        ? { ...managedDeploymentState(previousConfig), entriesRunning: false }
        : null;
      let entriesStopped = false;
      let transaction = null;
      let forwardDeployment = null;
      let forwardPaths = null;
      let forwardWorkerStarted = false;
      let previousForwardStopped = false;

      try {
        if (wasRunning) {
          if (!previousConfig) throw new Error('running host daemon has no readable config');
          const effectiveConfig = await hostApiRequest(previousConfig, 'show_config');
          effectiveBefore = {
            ...managedDeploymentState(effectiveConfig),
            entriesRunning: daemonEntriesRunning(effectiveConfig),
          };
          if (!sameManagedDeploymentState(managedDeploymentState(previousConfig), effectiveBefore)) {
            throw new Error('Stored Freqtrade config does not match the running host daemon; reconcile before deployment.');
          }
          if (configuredInitialEntriesRunning(previousConfig) !== effectiveBefore.entriesRunning) {
            throw new Error('Stored host Freqtrade initial_state does not match the running daemon entry state; reconcile before deployment.');
          }
        }

        let exchangeInfo = detectExchange();
        if (!exchangeInfo) {
          if (targetDryRun) {
            const exName = params.exchange || 'binance';
            exchangeInfo = { name: exName, key: 'dry-run', secret: 'dry-run' };
            console.error(`No exchange API keys found — using dummy keys for dry-run (${exName})`);
          } else {
            throw new Error('No exchange API keys found in .env (required for live trading)');
          }
        }

        mkdirSync(STRAT_DIR, { recursive: true });
        const apiPassword = String(
          previousConfig?.api_server?.password
          || process.env.FREQTRADE_PASSWORD
          || randomBytes(16).toString('hex'),
        );
        const config = generateHostConfig(exchangeInfo, apiPassword, {
          ...params,
          dry_run: targetDryRun,
          ...(signalArtifact ? {
            dry_run_wallet: walkForwardReferenceAccountEquity(walkForwardEvidence),
            fee: walkForwardDeploymentFee(walkForwardEvidence),
          } : {}),
          max_open_trades: maxOpenTrades,
          ...(signalArtifact ? {
            timeframe: signalArtifact.baseTimeframe,
            pairs: deploymentPairs.length ? deploymentPairs : [signalArtifact.symbol],
            helix_signal_artifact_path: archivedArtifact.hashFile,
            helix_signal_artifact_hash: signalArtifact.artifactHash,
          } : {}),
        });
        config.strategy = strategy;
        config.initial_state = 'stopped';
        configureWalkForwardReport(config, walkForwardEvidence);
        const previousForwardRuntime = forwardRuntimeFromConfig(previousConfig);
        if (signalArtifact) {
          if (targetDryRun !== true) throw new Error('Helix Signal forward deployment currently supports dry-run only.');
          if (String(exchangeInfo.name || '').toLowerCase() !== 'okx') {
            throw new Error('Forward Signal deployment currently requires the OKX futures market data identity.');
          }
          const duration = marketTimeframeMilliseconds(signalArtifact.baseTimeframe);
          const activatedAt = (Math.floor(Date.now() / duration) + 3) * duration;
          forwardDeployment = createForwardDeployment(signalArtifact, {
            activatedAt,
            walkForwardReportHash: walkForwardEvidence?.report.reportHash ?? null,
          });
          forwardPaths = forwardRuntimePaths(forwardDeployment);
          configureForwardRuntime(config, forwardDeployment, forwardPaths);
        } else {
          clearForwardRuntimeConfig(config);
        }
        const target = managedDeploymentState(config);
        let evidence = requireDeployableBacktestEvidence(
          requireCurrentBacktestEvidence(strategy, signalArtifact),
          signalArtifact,
        );
        if (archivedArtifact) requireSignalExecutionCompatibility(evidence, config, archivedArtifact);
        const adapterDestinations = managedAdapterDestinations(signalArtifact);
        transaction = beginDeploymentTransaction(USER_DATA, {
          operation: 'deploy',
          files: [CONFIG_PATH, ENV_FILE, ...adapterDestinations, ...(forwardPaths ? [forwardPaths.deploymentFile] : [])],
          previous: { running: wasRunning, state: effectiveBefore },
          target: { running: true, state: target },
        });

        if (wasRunning) {
          await stopHostEntries(previousConfig);
          entriesStopped = true;
          await requireFlatHostBot(previousConfig);
        } else if (previousConfig) {
          const inspectionConfig = { ...previousConfig, initial_state: 'stopped' };
          writeDeploymentFile(CONFIG_PATH, `${JSON.stringify(inspectionConfig, null, 4)}\n`, 0o600);
          try {
            startHostTrade(assertStrategyName(previousConfig.strategy));
            await waitForHostDaemon(managedDeploymentState(previousConfig), inspectionConfig);
            await requestHostEntryState(inspectionConfig, false);
            entriesStopped = true;
            await requireFlatHostBot(inspectionConfig);
          } finally {
            try { await stopHostDaemon(); } finally { restoreDeploymentFiles(transaction); }
          }
        } else if (existsSync(USER_DATA)) {
          const orphanDatabases = readdirSync(USER_DATA)
            .filter((file) => /^tradesv3.*\.sqlite(?:-(?:wal|shm))?$/.test(file));
          if (orphanDatabases.length > 0) {
            throw new Error(`Host deployment cannot prove flat state without the previous config; found ${orphanDatabases.join(', ')}.`);
          }
        }
        updateDeploymentTransaction(USER_DATA, transaction, 'FLAT');
        if (previousForwardRuntime) {
          await stopForwardWorker(previousForwardRuntime);
          previousForwardStopped = true;
        }
        if (wasRunning) await stopHostDaemon();
        updateDeploymentTransaction(USER_DATA, transaction, 'STOPPED');
        if (signalArtifact) installSignalAdapter();
        if (forwardDeployment) {
          writeDeploymentFile(forwardPaths.deploymentFile, `${JSON.stringify(forwardDeployment, null, 2)}\n`);
        }
        evidence = requireDeployableBacktestEvidence(
          requireCurrentBacktestEvidence(strategy, signalArtifact),
          signalArtifact,
        );
        if (archivedArtifact) requireSignalExecutionCompatibility(evidence, config, archivedArtifact);
        requireUnchangedWalkForwardReport(walkForwardEvidence, signalArtifact);
        writeDeploymentFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 0o600);
        updateDeploymentTransaction(USER_DATA, transaction, 'COMMITTED');
        const pid = startHostTrade(strategy);
        const effective = await waitForHostDaemon(target, config, undefined, !hadEmergencyLatch);
        if (signalArtifact) requireInstalledSignalAdapter();
        evidence = requireDeployableBacktestEvidence(
          requireCurrentBacktestEvidence(strategy, signalArtifact),
          signalArtifact,
        );
        if (archivedArtifact) requireSignalExecutionCompatibility(evidence, config, archivedArtifact);
        requireUnchangedWalkForwardReport(walkForwardEvidence, signalArtifact);
        const stored = readJsonFile(CONFIG_PATH);
        if (!stored || !sameManagedDeploymentState(managedDeploymentState(stored), target, { includeArtifact: true })) {
          throw new Error('stored signal artifact hash does not match deployment target');
        }
        if (signalArtifact && loadSignalArtifact(archivedArtifact.hashFile).artifactHash !== signalArtifact.artifactHash) {
          throw new Error('deployed signal artifact archive failed postcondition verification');
        }
        let forwardStatus = null;
        let forwardPid = null;
        if (forwardDeployment) {
          const firstDecisionTime = forwardDeployment.activatedAt
            + marketTimeframeMilliseconds(forwardDeployment.strategy.baseTimeframe);
          if (Date.now() >= firstDecisionTime) {
            throw new Error('Candidate readiness missed the first forward decision boundary; deploy again.');
          }
          forwardPid = startForwardWorker(forwardPaths);
          forwardWorkerStarted = true;
          forwardStatus = await waitForForwardWorker(forwardPaths, forwardDeployment.deploymentHash);
        }
        writeHostApiEnvironment(config);
        if (hadEmergencyLatch) {
          clearEmergencyStopLatch(USER_DATA);
          emergencyLatchCleared = true;
        }
        requireNoEmergencyStop(USER_DATA);
        updateDeploymentTransaction(USER_DATA, transaction, 'ACTIVE');
        try {
          await commitHostEntryActivation(config);
        } catch (startError) {
          try { discardDeploymentBackups(transaction); } catch (cleanupError) {
            throw new Error(`Deployment committed but host entry activation failed: ${startError.message}; backup cleanup failed: ${cleanupError.message}`);
          }
          throw new Error(`Deployment committed but host entry activation failed: ${startError.message}`);
        }
        discardDeploymentBackups(transaction);
        return {
          success: true,
          mode: 'host',
          backtest_evidence: evidence.id,
          signal_artifact: signalArtifact ? {
            hash: signalArtifact.artifactHash,
            identity: pinnedSignalIdentity(signalArtifact),
            lifecycle: signalArtifact.strategyLifecycle,
            active_file: archivedArtifact.hashFile,
          } : null,
          walk_forward_report: walkForwardEvidence ? {
            hash: walkForwardEvidence.report.reportHash,
            file: walkForwardEvidence.file,
          } : null,
          forward_runtime: forwardDeployment ? {
            deployment_hash: forwardDeployment.deploymentHash,
            activated_at: forwardDeployment.activatedAt,
            worker_pid: forwardPid,
            state: forwardStatus.state,
            deployment_file: forwardPaths.deploymentFile,
            batches: forwardPaths.batchesDirectory,
          } : null,
          exchange: exchangeInfo.name,
          strategy,
          dry_run: config.dry_run,
          pairs: config.exchange.pair_whitelist,
          max_open_trades: maxOpenTrades,
          api_url: FT_API_URL,
          api_auth: 'stored in .env (FREQTRADE_PASSWORD)',
          pid,
          ready: true,
          effective,
          transaction_id: transaction.id,
          log_file: HOST.logFile,
          config_path: CONFIG_PATH,
          strategies_dir: STRAT_DIR,
          note: config.dry_run ? 'Running in DRY-RUN mode' : 'WARNING: Running in LIVE mode',
          warning: targetDryRun === false
            ? '⚠️ 已切到实盘 — 真实交易, 真实亏损. 确认 .env 里交易所 key 正确, 余额可控.'
            : null,
        };
      } catch (error) {
        if (forwardWorkerStarted) {
          try { await stopForwardWorker(forwardPaths); } catch (stopError) {
            error = new Error(`${error.message}; failed to stop forward worker: ${stopError.message}`);
          }
        }
        if (emergencyLatchCleared && !emergencyStopIsLatched(USER_DATA)) {
          setEmergencyStopLatch(USER_DATA);
        }
        const phase = transaction ? readDeploymentTransaction(USER_DATA)?.phase : null;
        if (phase === 'ACTIVE') {
          const convergenceErrors = [];
          try {
            const activeConfig = readJsonFile(CONFIG_PATH);
            if (!activeConfig) throw new Error('active host config is unreadable');
            await requestHostEntryState(activeConfig, false);
          } catch (stopError) { convergenceErrors.push(stopError.message); }
          try { persistStoppedDeploymentConfig(); } catch (writeError) { convergenceErrors.push(writeError.message); }
          const suffix = convergenceErrors.length > 0
            ? `; ACTIVE host deployment could not be made safe: ${convergenceErrors.join('; ')}`
            : '; target remains committed with entries stopped';
          throw new Error(`${error.message}${suffix}`);
        }
        if (transaction && phase === 'PREPARED') {
          if (entriesStopped && effectiveBefore?.entriesRunning && previousConfig && !emergencyStopIsLatched(USER_DATA)) {
            try {
              if (previousForwardStopped) await startStoredForwardWorker(previousConfig);
              await activateHostEntries(previousConfig, 'restore entry state after rejected host deployment');
            } catch (resumeError) {
              throw new Error(`${error.message}; failed to restore entry state: ${resumeError.message}`);
            }
          }
          if (emergencyStopIsLatched(USER_DATA)) persistStoppedDeploymentConfig();
          updateDeploymentTransaction(USER_DATA, transaction, 'ROLLED_BACK', error.message);
          discardDeploymentBackups(transaction);
          throw error;
        }
        if (transaction) return rollbackHostDeployment(transaction, transaction.previous, error);
        if (entriesStopped && previousConfig) {
          await activateHostEntries(previousConfig, 'restore host entry state after preflight failure');
        }
        throw error;
      }
    });
  },

  // ── update ─────────────────────────────────────────────────────
  update: async () => withDeploymentLock(USER_DATA, 'update', async () => {
    requireHealthyDeploymentTransaction(USER_DATA);
    requireNoEmergencyStop(USER_DATA);
    if (IS_DOCKER) {
      const config = readDaemonConfig();
      const effectiveConfig = await ftGet('show_config', {}, { timeoutMs: 5_000 });
      const effective = managedDeploymentState(effectiveConfig);
      if (!sameManagedDeploymentState(managedDeploymentState(config), effective)) {
        throw new Error('Stored Freqtrade config does not match the running daemon; reconcile before update.');
      }
      if (configuredInitialEntriesRunning(config) !== daemonEntriesRunning(effectiveConfig)) {
        throw new Error('Stored Freqtrade initial_state does not match the running daemon entry state; reconcile before update.');
      }
      await requestManagedEntryState(false);
      config.initial_state = 'stopped';
      writeDeploymentFile(CONFIG_PATH, `${JSON.stringify(config, null, 4)}\n`, 0o600);
      await requireFlatBot();
      const forwardWorkerPid = await stopForwardWorker(forwardRuntimeFromConfig(config));
      requireNoEmergencyStop(USER_DATA);
      dockerCompose(['pull', 'freqtrade']);
      const target = managedDeploymentState(config);
      const restarted = await guardDaemonStart(
        'update docker daemon',
        async () => {
          const start = dockerCompose(['up', '-d', 'freqtrade']);
          const ready = await waitForManagedDaemon(target, 60_000, true);
          await waitForManagedEntryState(false);
          return { start, ready };
        },
        () => dockerCompose(['stop', 'freqtrade']),
      );
      return {
        updated: true,
        mode: 'docker',
        entries_stopped: true,
        forward_worker_pid: forwardWorkerPid,
        effective: restarted.ready,
        note: 'Pulled the stable image and recreated the daemon with entries stopped. Re-run backtest evidence before activation.',
      };
    }
    if (ENV) {
      return {
        skipped: true, mode: 'coinclaw',
        note: '在 coinclaw 容器里 freqtrade 由 image 预装, 升级请 helm upgrade 整个 instance (web 端有"升级"按钮), 不能在容器里 git pull',
      };
    }
    if (!existsSync(resolve(HOST.sourceDir, 'setup.sh'))) {
      return { error: 'Freqtrade not installed. Run deploy first.' };
    }
    const pid = getHostPid();
    const config = readJsonFile(CONFIG_PATH);
    if (pid) {
      if (!config) throw new Error('running host daemon has no readable config');
      await requestHostEntryState(config, false);
      persistStoppedDeploymentConfig();
      await requireFlatHostBot(config);
      await stopHostDaemon();
    } else if (config) {
      persistStoppedDeploymentConfig();
    }
    const forwardWorkerPid = await stopForwardWorker(forwardRuntimeFromConfig(config));
    console.error('Updating Freqtrade...');
    runFile(resolve(HOST.sourceDir, 'setup.sh'), ['-u'], { cwd: HOST.sourceDir, timeout: 600000 });
    return { updated: true, mode: 'host', forward_worker_pid: forwardWorkerPid, note: 'Run start to restart Freqtrade.' };
  }),

  // ── status ─────────────────────────────────────────────────────
  status: async () => {
    if (IS_DOCKER) {
      const state = await fetchDaemonState();
      let lastLogs = '';
      try { lastLogs = dockerCompose(['logs', '--tail', '10', '--no-color', 'freqtrade']); } catch {}
      return {
        mode: 'docker', engine: ENV.engine, ...state,
        forward_runtime: readForwardRuntimeStatus(readJsonFile(CONFIG_PATH)),
        last_logs: lastLogs,
      };
    }
    if (ENV) {
      const state = await fetchDaemonState();
      const result = {
        mode: 'coinclaw', engine: ENV.engine, ...state,
        forward_runtime: readForwardRuntimeStatus(readJsonFile(CONFIG_PATH)),
      };
      // tail freqtrade 日志, 三引擎日志位置不同.
      const logCandidates = [
        '/workspace/logs/freqtrade.log',
        '/workspace/logs/freqtrade-error.log',
      ];
      for (const log of logCandidates) {
        if (existsSync(log)) {
          try { result.last_logs = runFile('tail', ['-10', log]); break; } catch {}
        }
      }
      return result;
    }
    const pid = getHostPid();
    const forwardRuntime = readForwardRuntimeStatus(readJsonFile(CONFIG_PATH));
    if (!pid) return { mode: 'host', running: false, forward_runtime: forwardRuntime };
    let lastLogs = '';
    try { lastLogs = runFile('tail', ['-5', HOST.logFile]); } catch {}
    return { mode: 'host', running: true, pid, forward_runtime: forwardRuntime, log_file: HOST.logFile, last_logs: lastLogs };
  },

  // ── stop / start ───────────────────────────────────────────────
  // coinclaw 模式: supervisorctl. host 模式: SIGTERM pid.
  stop: async () => withDeploymentLock(USER_DATA, 'stop', async () => {
    const forwardRuntime = forwardRuntimeFromConfig(readJsonFile(CONFIG_PATH));
    if (IS_DOCKER) {
      dockerCompose(['stop', 'freqtrade'], { timeout: 60_000 });
      const workerPid = await stopForwardWorker(forwardRuntime);
      return { stopped: true, mode: 'docker', method: 'docker compose stop', forward_worker_pid: workerPid };
    }
    if (ENV) {
      const sock = supervisorSocket();
      try {
        runFile('supervisorctl', ['-s', `unix://${sock}`, 'stop', 'freqtrade']);
        const workerPid = await stopForwardWorker(forwardRuntime);
        return { stopped: true, mode: 'coinclaw', method: 'supervisorctl', forward_worker_pid: workerPid };
      } catch (e) {
        return { stopped: false, error: e.message, note: 'supervisorctl 不可达, 试试 ft.mjs stop (REST)' };
      }
    }
    const pid = getHostPid();
    if (pid) await stopHostDaemon();
    const workerPid = await stopForwardWorker(forwardRuntime);
    if (!pid && !workerPid) return { stopped: false, mode: 'host', reason: 'Not running' };
    return { stopped: true, mode: 'host', pid, forward_worker_pid: workerPid };
  }),

  start: async (params = {}) => withDeploymentLock(USER_DATA, 'start', async () => {
    requireHealthyDeploymentTransaction(USER_DATA);
    requireNoEmergencyStop(USER_DATA);
    if (Object.prototype.hasOwnProperty.call(params, 'strategy')) {
      throw new Error('start does not accept a strategy override; deploy the intended strategy first');
    }
    if (!existsSync(CONFIG_PATH)) throw new Error('No config found. Run deploy first.');
    const config = readJsonFile(CONFIG_PATH);
    if (!config) throw new Error('Stored Freqtrade config is unreadable.');
    const identity = requireStoredDeploymentIdentity(config);
    const target = managedDeploymentState(config);
    if (!ENV && !getHostPid() && !existsSync(FT_BIN)) {
      throw new Error('Freqtrade not installed. Run deploy first.');
    }
    const forwardRuntime = forwardRuntimeFromConfig(config);
    let forwardStatus = null;
    let forwardPid = null;
    if (forwardRuntime) {
      forwardPid = startForwardWorker(forwardRuntime);
      forwardStatus = await waitForForwardWorker(forwardRuntime, forwardRuntime.deploymentHash);
    }
    if (IS_DOCKER) {
      const started = await guardDaemonStart(
        'start docker daemon',
        async () => {
          const start = dockerCompose(['up', '-d', 'freqtrade'], { timeout: 60_000 });
          const effective = await waitForManagedDaemon(target, 60_000, true);
          await waitForManagedEntryState(configuredInitialEntriesRunning(config));
          requireStoredDeploymentIdentity(config);
          if (!sameManagedDeploymentState(effective, target)) {
            throw new Error('started daemon does not match the stored deployment identity');
          }
          return { start, effective };
        },
        async () => {
          dockerCompose(['stop', 'freqtrade'], { timeout: 60_000 });
          await stopForwardWorker(forwardRuntime);
        },
      );
      return {
        started: true,
        mode: 'docker',
        method: 'docker compose up',
        strategy: identity.strategy,
        effective: started.effective,
        forward_runtime: forwardStatus ? { pid: forwardPid, state: forwardStatus.state } : null,
      };
    }
    if (ENV) {
      const started = await guardDaemonStart('start managed daemon', async () => {
        const start = startManagedDaemon();
        const effective = await waitForManagedDaemon(target, 60_000, true);
        await waitForManagedEntryState(configuredInitialEntriesRunning(config));
        requireStoredDeploymentIdentity(config);
        if (!sameManagedDeploymentState(effective, target)) {
          throw new Error('started daemon does not match the stored deployment identity');
        }
        return { start, effective };
      }, async () => {
        stopManagedDaemon();
        await stopForwardWorker(forwardRuntime);
      });
      return {
        started: true,
        mode: 'coinclaw',
        method: 'supervisorctl',
        strategy: identity.strategy,
        effective: started.effective,
        forward_runtime: forwardStatus ? { pid: forwardPid, state: forwardStatus.state } : null,
      };
    }
    if (getHostPid()) {
      return {
        started: false,
        mode: 'host',
        reason: 'Already running',
        forward_runtime: forwardStatus ? { pid: forwardPid, state: forwardStatus.state } : null,
      };
    }
    const started = await guardDaemonStart('start host daemon', async () => {
      const pid = startHostTrade(identity.strategy);
      const effective = await waitForHostDaemon(target, config, undefined, true);
      await waitForHostEntryState(config, configuredInitialEntriesRunning(config));
      requireStoredDeploymentIdentity(config);
      if (!sameManagedDeploymentState(effective, target)) {
        throw new Error('started host daemon does not match the stored deployment identity');
      }
      return { pid, effective };
    }, async () => {
      await stopHostDaemon();
      await stopForwardWorker(forwardRuntime);
    });
    return {
      started: true,
      mode: 'host',
      pid: started.pid,
      strategy: identity.strategy,
      effective: started.effective,
      forward_runtime: forwardStatus ? { pid: forwardPid, state: forwardStatus.state } : null,
    };
  }),

  // ── logs ───────────────────────────────────────────────────────
  // coinclaw 模式: tail /workspace/logs/freqtrade.log (supervisord 写在那).
  // host 模式: tail freqtrade.log.
  logs: async ({ lines = 50 } = {}) => {
    const n = parseTailLines(lines);
    if (IS_DOCKER) {
      try {
        return { mode: 'docker', logs: dockerCompose(['logs', '--tail', String(n), '--no-color', 'freqtrade']) };
      } catch {
        return { mode: 'docker', logs: 'No container logs available' };
      }
    }
    if (ENV) {
      for (const log of ['/workspace/logs/freqtrade.log', '/workspace/logs/freqtrade-error.log']) {
        if (existsSync(log)) {
          try { return { mode: 'coinclaw', log_file: log, logs: runFile('tail', [`-${n}`, log]) }; } catch {}
        }
      }
      return { mode: 'coinclaw', logs: '(no log file found in /workspace/logs)' };
    }
    try { return { mode: 'host', logs: runFile('tail', [`-${n}`, HOST.logFile]) }; }
    catch { return { mode: 'host', logs: 'No log file found' }; }
  },

  // ── backtest ───────────────────────────────────────────────────
  // 两边都用 freqtrade backtesting CLI; 区别只在路径.
  // coinclaw 模式跑 backtest 不影响 daemon: backtesting 走自己的进程,
  // 跟 daemon 共用 user_data 但不共用 :8888.
  backtest: async (params = {}) => withBacktestLock(USER_DATA, 'backtest', async () => {
    const archivedArtifact = resolveSignalArtifact(params);
    const signalArtifact = archivedArtifact?.artifact || null;
    const strategy = assertStrategyName(params.strategy || (signalArtifact ? HELIX_SIGNAL_STRATEGY : 'SampleStrategy'));
    if (strategy === HELIX_SIGNAL_STRATEGY && !signalArtifact) {
      throw new Error('HelixSignalStrategy backtest requires signal_artifact.');
    }
    if (signalArtifact && strategy !== HELIX_SIGNAL_STRATEGY) {
      throw new Error(`signal_artifact can only be backtested with ${HELIX_SIGNAL_STRATEGY}.`);
    }
    const timeframe = params.timeframe || signalArtifact?.baseTimeframe || '1h';
    if (signalArtifact && timeframe !== signalArtifact.baseTimeframe) {
      throw new Error(`Backtest timeframe ${timeframe} does not match signal artifact baseTimeframe ${signalArtifact.baseTimeframe}.`);
    }
    const requestedPairs = params.pairs
      ? (Array.isArray(params.pairs) ? params.pairs : [params.pairs])
      : [];
    if (signalArtifact && requestedPairs.length && (
      requestedPairs.length !== 1 || requestedPairs[0] !== signalArtifact.symbol
    )) {
      throw new Error(`Signal artifact backtest pair must be exactly ${signalArtifact.symbol}.`);
    }
    const pairList = signalArtifact ? [signalArtifact.symbol] : requestedPairs;
    if (signalArtifact && params.timerange) {
      throw new Error('Signal artifact backtest uses the exact market_dataset window and does not accept timerange.');
    }
    if (signalArtifact && !params.market_dataset) {
      throw new Error('HelixSignalStrategy backtest requires market_dataset matching the signal artifact identity.');
    }
    if (!signalArtifact && params.market_dataset) {
      throw new Error('market_dataset can only be used with a signal_artifact backtest.');
    }
    const feeMissing = params.fee === undefined
      || params.fee === null
      || (typeof params.fee === 'string' && !params.fee.trim());
    const fee = feeMissing ? null : Number(params.fee);
    if (signalArtifact && fee === null) {
      throw new Error('HelixSignalStrategy backtest requires an explicit non-negative fee.');
    }
    if (fee !== null && (!Number.isFinite(fee) || fee < 0)) {
      throw new Error('fee must be a non-negative number');
    }
    const stagedDataset = signalArtifact
      ? stageSignalBacktestDataset(String(params.market_dataset), signalArtifact)
      : null;
    const riskUnitRatio = signalArtifact ? Number(params.risk_unit_ratio) : null;
    if (signalArtifact && (!Number.isFinite(riskUnitRatio) || riskUnitRatio <= 0 || riskUnitRatio > 1)) {
      throw new Error('HelixSignalStrategy backtest requires risk_unit_ratio in (0, 1].');
    }
    if (!signalArtifact && (params.historical_risk_trace != null || params.risk_unit_ratio != null)) {
      throw new Error('historical_risk_trace and risk_unit_ratio require a signal_artifact backtest.');
    }
    const accountEquity = signalArtifact && params.account_equity != null
      ? Number(params.account_equity)
      : null;
    if (accountEquity !== null && (!Number.isFinite(accountEquity) || accountEquity <= 0)) {
      throw new Error('account_equity must be a positive number.');
    }
    if (!signalArtifact && params.account_equity != null) {
      throw new Error('account_equity requires a signal_artifact backtest.');
    }
    const archivedRiskTrace = signalArtifact
      ? archiveHistoricalRiskTrace(params.historical_risk_trace, signalArtifact)
      : null;
    ensureHostFreqtradeInstalled();
    if (!existsSync(CONFIG_PATH)) {
      mkdirSync(dirname(CONFIG_PATH), { recursive: true });
      const exchange = stagedDataset?.dataset.source.provider || params.exchange || 'binance';
      const cfg = generateHostConfig(
        { name: exchange, key: 'backtest-only', secret: 'backtest-only' },
        randomBytes(8).toString('hex'),
        { dry_run: true, timeframe, pairs: pairList.length ? pairList : ['BTC/USDT:USDT'] },
      );
      writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
      console.error(`Auto-created backtest config (exchange: ${exchange})`);
    }
    const backtestConfig = readJsonFile(CONFIG_PATH);
    if (stagedDataset) {
      const configuredExchange = String(backtestConfig?.exchange?.name || '').toLowerCase();
      const datasetProvider = stagedDataset.dataset.source.provider.toLowerCase();
      if (configuredExchange !== datasetProvider) {
        throw new Error(`Freqtrade exchange ${configuredExchange || 'unknown'} does not match market_dataset provider ${datasetProvider}`);
      }
      if (backtestConfig?.trading_mode !== stagedDataset.dataset.source.market) {
        throw new Error(`Freqtrade trading_mode ${backtestConfig?.trading_mode || 'unknown'} does not match market_dataset market ${stagedDataset.dataset.source.market}`);
      }
    }
    const backtestStrategyDir = signalArtifact ? SIGNAL_ADAPTER_ASSET_DIR : STRAT_DIR;
    const stratFile = resolve(backtestStrategyDir, `${strategy}.py`);
    if (!existsSync(stratFile)) {
      throw new Error(`Strategy "${strategy}" not found at ${stratFile}. Use create_strategy or list with strategy_list.`);
    }
    const timerange = signalArtifact ? '' : params.timerange || '';
    const safeBacktestConfig = signalArtifact
      ? createSecretFreeBacktestConfig(backtestConfig, {
          timeframe,
          pairs: pairList,
          dryRunWallet: accountEquity,
        })
      : null;
    const backtestConfigPath = safeBacktestConfig
      ? resolve(USER_DATA, 'helix', 'backtest-runtime', `${process.pid}-${randomBytes(8).toString('hex')}.json`)
      : CONFIG_PATH;
    if (safeBacktestConfig) {
      mkdirSync(dirname(backtestConfigPath), { recursive: true, mode: 0o700 });
      writeFileSync(backtestConfigPath, `${JSON.stringify(safeBacktestConfig, null, 2)}\n`, { mode: 0o600 });
      chmodSync(backtestConfigPath, 0o600);
    }
    const recordedExecutionProfile = safeBacktestConfig
      ? createRuntimeExecutionProfile(safeBacktestConfig, { timeframe, pairs: pairList, fee })
      : null;
    const resultsDir = resolve(USER_DATA, 'backtest_results');
    const previousResultFiles = new Set(backtestMetaFiles(resultsDir));
    const strategyHash = strategyFingerprint(strategy);
    if (!strategyHash) throw new Error(`Unable to fingerprint strategy: ${stratFile}`);
    const configFileHash = fileHash(backtestConfigPath);
    if (!configFileHash) throw new Error(`Unable to fingerprint Freqtrade config: ${backtestConfigPath}`);
    const configHash = safeBacktestConfig
      ? executionConfigIdentityHash(executionConfigIdentity(safeBacktestConfig))
      : configFileHash;
    const stagedDataHash = stagedDataset ? fileHash(stagedDataset.dataFile) : null;
    if (stagedDataset && stagedDataHash !== stagedDataset.evidence.dataHash) {
      throw new Error(`Staged market dataset is corrupt: ${stagedDataset.dataFile}`);
    }
    const archivedArtifactFileHash = archivedArtifact ? fileHash(archivedArtifact.hashFile) : null;
    if (archivedArtifact && !archivedArtifactFileHash) {
      throw new Error(`Unable to fingerprint archived signal artifact: ${archivedArtifact.hashFile}`);
    }

    if (stagedDataset) {
      console.error(`Using exact Helix market dataset ${stagedDataset.dataset.datasetHash}`);
    } else {
      console.error('Downloading historical data...');
      try {
        const args = ['download-data', '--config', CONFIG_PATH, '--timeframe', timeframe, '--userdir', USER_DATA];
        if (timerange) args.push('--timerange', timerange);
        if (pairList.length) args.push('-p', ...pairList);
        runFreqtrade(args, { timeout: 300000, env: proxyEnv() });
      } catch (e) {
        console.error(`Data download warning: ${e.message}`);
      }
    }

    console.error(`Running backtest: strategy=${strategy}, timeframe=${timeframe}${timerange ? `, timerange=${timerange}` : ''}...`);
    const backtestArgs = [
      'backtesting',
      '--config', backtestConfigPath,
      '--strategy', strategy,
      '--strategy-path', backtestStrategyDir,
      '--timeframe', timeframe,
      '--userdir', USER_DATA,
    ];
    if (timerange) backtestArgs.push('--timerange', timerange);
    if (pairList.length) backtestArgs.push('-p', ...pairList);
    if (stagedDataset) {
      backtestArgs.push('--datadir', stagedDataset.dataRoot, '--data-format-ohlcv', 'json', '--cache', 'none');
    }
    if (fee !== null) backtestArgs.push('--fee', String(fee));
    const backtestEnv = archivedArtifact ? {
      ...proxyEnv(),
      HELIX_SIGNAL_ARTIFACT_PATH: dockerCliPath(archivedArtifact.hashFile),
      HELIX_SIGNAL_ARTIFACT_HASH: signalArtifact.artifactHash,
      HELIX_SIGNAL_ARTIFACT_OVERRIDE: '1',
      HELIX_SIGNAL_TIMEFRAME: signalArtifact.baseTimeframe,
      HELIX_SIGNAL_RISK_TRACE_PATH: dockerCliPath(archivedRiskTrace.hashFile),
      HELIX_SIGNAL_RISK_TRACE_HASH: archivedRiskTrace.riskTrace.traceHash,
      HELIX_SIGNAL_RISK_TRACE_FILE_HASH: archivedRiskTrace.fileHash,
      HELIX_SIGNAL_RISK_UNIT_RATIO: String(riskUnitRatio),
    } : proxyEnv();
    let rawOutput;
    try {
      rawOutput = signalArtifact
        ? runSecretFreeSignalBacktest(backtestArgs, { timeout: 600000, env: backtestEnv })
        : runFreqtrade(backtestArgs, { timeout: 600000, env: backtestEnv });
      requireUnchangedFile(backtestConfigPath, configFileHash, 'Freqtrade backtest config');
    } finally {
      if (safeBacktestConfig && existsSync(backtestConfigPath)) {
        try { unlinkSync(backtestConfigPath); } catch {}
      }
    }
    const backtestResult = findNewBacktestResult(resultsDir, previousResultFiles, strategy);
    if (!backtestResult) {
      throw new Error(`Freqtrade did not create a verifiable result and metadata file for strategy "${strategy}".`);
    }
    const { resultFile, resultMetaFile } = backtestResult;
    const resultPath = resolve(resultsDir, resultFile);
    const resultMetaPath = resolve(resultsDir, resultMetaFile);
    const resultHash = fileHash(resultPath);
    const resultMetaHash = fileHash(resultMetaPath);
    const summary = firstStrategySummary(readBacktestPayload(resultsDir, resultFile), strategy);
    if (!resultHash || !resultMetaHash || !summary) {
      throw new Error(`Freqtrade result for strategy "${strategy}" is incomplete or unreadable.`);
    }
    const metrics = backtestMetrics(summary);
    const reconciliation = signalArtifact
      ? reconcileSignalBacktest(summary, signalArtifact)
      : null;
    const freqtradeVersion = currentFreqtradeVersion();
    if (strategyFingerprint(strategy) !== strategyHash) {
      throw new Error(`Strategy "${strategy}" changed during backtest. Run the backtest again for the current code.`);
    }
    if (!signalArtifact) requireUnchangedFile(CONFIG_PATH, configFileHash, 'Freqtrade config');
    if (stagedDataset) requireUnchangedFile(stagedDataset.dataFile, stagedDataHash, 'Staged market dataset');
    if (archivedArtifact) {
      requireUnchangedFile(archivedArtifact.hashFile, archivedArtifactFileHash, 'Archived signal artifact');
    }
    if (archivedRiskTrace) {
      requireUnchangedFile(archivedRiskTrace.hashFile, archivedRiskTrace.fileHash, 'Archived historical risk trace');
    }
    requireUnchangedFile(resultPath, resultHash, 'Freqtrade result');
    requireUnchangedFile(resultMetaPath, resultMetaHash, 'Freqtrade result metadata');
    const evidence = recordBacktestEvidence({
      strategy,
      strategyHash,
      timeframe,
      timerange,
      pairs: pairList,
      resultFile,
      resultMetaFile,
      metrics,
      signalArtifact,
      marketDataset: stagedDataset?.evidence || null,
      executionEnvironment: {
        freqtradeVersion,
        configHash,
        artifactFileHash: archivedArtifactFileHash,
        riskTraceHash: archivedRiskTrace?.riskTrace.traceHash ?? null,
        riskTraceFileHash: archivedRiskTrace?.fileHash ?? null,
        riskUnitRatio,
        fee,
        dataFormatOhlcv: stagedDataset ? 'json' : null,
        configIdentity: safeBacktestConfig ? executionConfigIdentity(safeBacktestConfig) : null,
        executionProfile: recordedExecutionProfile,
      },
      resultHash,
      resultMetaHash,
      reconciliation,
    });
    const output = rawOutput
      .split('\n')
      .filter((l) => !l.includes('INFO') || l.includes('TOTAL') || l.includes('Result') || l.includes('trades') || l.includes('Profit') || l.includes('Drawdown') || l.includes('Win') || l.includes('Avg'))
      .join('\n')
      .replace(/\b127\.0\.0\.1:\d+\b/g, '[local]')
      .replace(/https?:\/\/\d+\.\d+\.\d+\.\d+:\d+/g, '[proxy]');
    return {
      mode: runtimeMode(),
      strategy,
      timeframe,
      timerange: timerange || 'all available',
      output,
      evidence: {
        id: evidence.id,
        resultFile: evidence.resultFile,
        resultHash: evidence.resultHash,
        resultMetaFile: evidence.resultMetaFile,
        resultMetaHash: evidence.resultMetaHash,
        metrics,
        reconciliation,
        current: true,
        signalArtifact: evidence.signalArtifact,
      },
    };
  }),

  // ── walk_forward ──────────────────────────────────────────────
  walk_forward: async (params = {}) => {
    if (typeof params.walk_forward_run !== 'string' || !params.walk_forward_run.trim()) {
      throw new Error('walk_forward requires walk_forward_run.');
    }
    if (typeof params.source_dataset !== 'string' || !params.source_dataset.trim()) {
      throw new Error('walk_forward requires source_dataset.');
    }
    const runFile = resolve(params.walk_forward_run.trim());
    const sourceDatasetFile = resolve(params.source_dataset.trim());
    const bundle = loadWalkForwardBundle(runFile, sourceDatasetFile);
    const censoredEntries = bundle.run.folds.flatMap((fold) => fold.censoredEntries);
    if (censoredEntries.length) {
      throw new Error(
        `walk-forward run has ${censoredEntries.length} right-censored entr${censoredEntries.length === 1 ? 'y' : 'ies'}; `
        + 'extend observationEndTime and rerun Core before Freqtrade execution.',
      );
    }

    const runtimeAdapterBundle = signalAdapterBundleFromDirectory(SIGNAL_ADAPTER_ASSET_DIR);
    const riskUnitRatio = bundle.plan.walkForwardPolicy?.plan.riskUnitRatio
      ?? UNVERSIONED_WALK_FORWARD_RISK_UNIT_RATIO;
    const accountEquity = bundle.plan.walkForwardPolicy?.plan.referenceAccountEquity
      ?? UNVERSIONED_WALK_FORWARD_ACCOUNT_EQUITY;
    const freqtradeVersion = currentFreqtradeVersion();
    const foldEvidence = [];
    for (const [foldIndex, fold] of bundle.folds.entries()) {
      const scenarioEvidence = [];
      for (const scenario of bundle.plan.executionScenarios) {
        const reusable = reusableWalkForwardEvidence({
          fold,
          scenario,
          adapterHash: runtimeAdapterBundle.adapterHash,
          freqtradeVersion,
          riskUnitRatio,
          accountEquity,
        });
        const result = reusable ? null : runBacktestSubprocess({
          signal_artifact: resolve(bundle.directory, fold.run.executionArtifactFile),
          historical_risk_trace: resolve(bundle.directory, fold.run.executionRiskTraceFile),
          risk_unit_ratio: riskUnitRatio,
          account_equity: accountEquity,
          market_dataset: resolve(bundle.directory, fold.run.datasetFile),
          fee: scenario.fee,
        });
        const evidenceId = result?.evidence?.id;
        const record = reusable?.record ?? (typeof evidenceId === 'string'
          ? readBacktestEvidence().find((item) => item.id === evidenceId)
          : null);
        if (!record) {
          throw new Error(`walk-forward fold ${foldIndex} scenario ${scenario.id} has no stored backtest evidence.`);
        }
        const verified = reusable?.verified ?? verifyBacktestEvidenceResult(
          record,
          fold.executionArtifact,
          scenario.fee,
          {
            signalArtifact: fold.executionArtifact,
            riskTrace: fold.executionRiskTrace,
            marketDataset: fold.dataset,
            riskUnitRatio,
            accountEquity: record.executionEnvironment?.configIdentity?.dryRunWallet,
          },
        );
        if (reusable) {
          console.error(`Reusing verified walk-forward evidence: fold=${foldIndex}, scenario=${scenario.id}`);
        }
        if (!hasSignalExecutionEnvironment(record)) {
          throw new Error(`walk-forward fold ${foldIndex} scenario ${scenario.id} has no execution identity.`);
        }
        const environment = record.executionEnvironment;
        if (!environment.configIdentity
          || runtimeAdapterBundle.adapterHash !== `sha256:${record.strategyHash}`) {
          throw new Error(`walk-forward fold ${foldIndex} scenario ${scenario.id} has incomplete runtime evidence.`);
        }
        if (environment.fee !== scenario.fee
          || environment.executionProfile?.fee !== scenario.fee) {
          throw new Error(`walk-forward fold ${foldIndex} scenario ${scenario.id} fee identity mismatch.`);
        }
        if (verified.feeObservations.status === 'OBSERVED'
          && !verified.feeObservations.matchesRequested) {
          throw new Error(`walk-forward fold ${foldIndex} scenario ${scenario.id} observed fee mismatch.`);
        }
        const resultsDirectory = dirname(BACKTEST_EVIDENCE_FILE);
        const resultPath = evidenceFilePath(
          resultsDirectory,
          record.resultFile,
          'resultFile',
          ['.json', '.zip'],
        );
        const resultMetaPath = evidenceFilePath(
          resultsDirectory,
          record.resultMetaFile,
          'resultMetaFile',
          ['.meta.json'],
        );
        const resultSuffix = record.resultFile.endsWith('.zip') ? '.zip' : '.json';
        const runtimeEvidence = createExecutionRuntimeEvidence({
          resultHash: verified.resultHash,
          resultMetaHash: verified.resultMetaHash,
          datasetHash: fold.dataset.datasetHash,
          executionArtifactHash: fold.executionArtifact.artifactHash,
          riskTraceHash: fold.executionRiskTrace.traceHash,
          riskUnitRatio,
          scenarioId: scenario.id,
          fee: scenario.fee,
          freqtradeVersion: environment.freqtradeVersion,
          configIdentity: environment.configIdentity,
          executionProfile: environment.executionProfile,
          adapterFiles: runtimeAdapterBundle.files,
        });
        const runtimeArchive = archiveWalkForwardRuntimeEvidence(bundle.directory, runtimeEvidence);
        scenarioEvidence.push({
          scenarioId: scenario.id,
          fee: scenario.fee,
          freqtradeVersion: environment.freqtradeVersion,
          configHash: environment.configHash,
          executionProfile: environment.executionProfile,
          executionProfileHash: walkForwardEvidenceHash(environment.executionProfile),
          adapterHash: `sha256:${record.strategyHash}`,
          riskTraceHash: fold.executionRiskTrace.traceHash,
          riskUnitRatio,
          runtimeEvidenceFile: runtimeArchive.file,
          runtimeEvidenceHash: runtimeArchive.hash,
          resultFile: archiveWalkForwardEvidence(
            bundle.directory,
            resultPath,
            verified.resultHash,
            resultSuffix,
          ),
          resultHash: verified.resultHash,
          resultMetaFile: archiveWalkForwardEvidence(
            bundle.directory,
            resultMetaPath,
            verified.resultMetaHash,
            '.meta.json',
          ),
          resultMetaHash: verified.resultMetaHash,
          reconciliation: verified.reconciliation,
          feeObservations: verified.feeObservations,
          metrics: verified.metrics,
        });
      }
      foldEvidence.push(scenarioEvidence);
    }

    const reloaded = loadWalkForwardBundle(runFile, sourceDatasetFile);
    if (reloaded.plan.planHash !== bundle.plan.planHash || reloaded.run.runHash !== bundle.run.runHash) {
      throw new Error('walk-forward Core bundle changed during Freqtrade execution.');
    }
    const coreEvidence = archiveWalkForwardCoreBundle(reloaded);
    const report = createWalkForwardReport(reloaded, foldEvidence, coreEvidence);
    verifyWalkForwardReport(report, reloaded, reloaded.directory);
    const reportFile = writeImmutableWalkForwardReport(reloaded.directory, report);
    recordWalkForwardReport({ file: reportFile, report });
    return {
      ok: true,
      planHash: report.planHash,
      runHash: report.runHash,
      reportHash: report.reportHash,
      reportFile,
      folds: report.folds.length,
      scenarios: report.aggregate.scenarios.length,
      promotable: report.gate.ok,
      gate: report.gate,
    };
  },

  walk_forward_portfolio: async (params = {}) => {
    if (typeof params.portfolio_plan !== 'string' || !params.portfolio_plan.trim()) {
      throw new Error('walk_forward_portfolio requires portfolio_plan.');
    }
    if (!Array.isArray(params.reports) || params.reports.length < 2
      || params.reports.some((file) => typeof file !== 'string' || !file.trim())) {
      throw new Error('walk_forward_portfolio requires at least two report file paths.');
    }
    const sourcePlanFile = resolve(params.portfolio_plan.trim());
    const portfolioPlan = verifyWalkForwardPortfolioPlan(JSON.parse(readFileSync(sourcePlanFile, 'utf8')));
    const outputDirectory = params.output_directory == null
      ? dirname(sourcePlanFile)
      : resolve(String(params.output_directory).trim());
    mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
    const archivedPlanFile = resolve(outputDirectory, 'walk-forward-portfolio-plan.json');
    writeImmutableJsonFile(archivedPlanFile, portfolioPlan);
    const archivedPlan = verifyWalkForwardPortfolioPlan(JSON.parse(readFileSync(archivedPlanFile, 'utf8')));
    if (archivedPlan.planHash !== portfolioPlan.planHash) {
      throw new Error('archived walk-forward portfolio plan identity mismatch');
    }
    const archivedReports = params.reports.map((file) => (
      archiveWalkForwardMemberReport(outputDirectory, file.trim())
    ));
    const currentPlan = verifyWalkForwardPortfolioPlan(JSON.parse(readFileSync(sourcePlanFile, 'utf8')));
    if (currentPlan.planHash !== portfolioPlan.planHash) {
      throw new Error('walk-forward portfolio plan changed during report creation');
    }
    const report = createWalkForwardPortfolioReport(archivedPlan, archivedReports, outputDirectory);
    const reportFile = writeImmutableWalkForwardPortfolioReport(outputDirectory, report);
    verifyWalkForwardPortfolioReport(
      JSON.parse(readFileSync(reportFile, 'utf8')),
      outputDirectory,
    );
    recordWalkForwardReport({ file: reportFile, report });
    return {
      ok: true,
      planHash: report.planHash,
      reportHash: report.reportHash,
      reportFile,
      symbols: report.members.map(({ source: memberSource }) => memberSource.symbol),
      scenarios: report.aggregate.scenarios.length,
      promotable: report.gate.ok,
      gate: report.gate,
    };
  },

  // ── download_data ──────────────────────────────────────────────
  download_data: async (params = {}) => {
    ensureHostFreqtradeInstalled();
    if (!existsSync(CONFIG_PATH)) {
      mkdirSync(dirname(CONFIG_PATH), { recursive: true });
      const exchange = params.exchange || 'binance';
      const cfg = generateHostConfig(
        { name: exchange, key: 'download-only', secret: 'download-only' },
        randomBytes(8).toString('hex'),
        { dry_run: true, pairs: params.pairs || ['BTC/USDT:USDT'] },
      );
      writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    }
    const timeframes = Array.isArray(params.timeframes) && params.timeframes.length
      ? params.timeframes.map(String)
      : [String(params.timeframe || '1h')];
    const timerange = params.timerange || '';
    const pairs = params.pairs ? (Array.isArray(params.pairs) ? params.pairs : [params.pairs]) : [];

    console.error(`Downloading data: timeframes=${timeframes.join(',')}${timerange ? `, timerange=${timerange}` : ''}...`);
    const args = ['download-data', '--config', CONFIG_PATH, '--timeframes', ...timeframes, '--userdir', USER_DATA];
    if (timerange) args.push('--timerange', timerange);
    if (pairs.length) args.push('-p', ...pairs);
    if (params.prepend === true) args.push('--prepend');
    const output = runFreqtrade(args, { timeout: 300000, env: proxyEnv() });
    return { mode: runtimeMode(), timeframes, pairs, prepend: params.prepend === true, timerange: timerange || 'all available', output };
  },

  // ── hyperopt ───────────────────────────────────────────────────
  hyperopt: async (params = {}) => {
    ensureHostFreqtradeInstalled();
    if (!existsSync(CONFIG_PATH)) {
      mkdirSync(dirname(CONFIG_PATH), { recursive: true });
      const exchange = params.exchange || 'binance';
      const cfg = generateHostConfig(
        { name: exchange, key: 'hyperopt-only', secret: 'hyperopt-only' },
        randomBytes(8).toString('hex'),
        { dry_run: true, pairs: params.pairs || ['BTC/USDT:USDT'] },
      );
      writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    }

    const strategy = assertStrategyName(params.strategy || 'SampleStrategy');
    const stratFile = resolve(STRAT_DIR, `${strategy}.py`);
    if (!existsSync(stratFile)) throw new Error(`Strategy "${strategy}" not found at ${stratFile}.`);
    const timeframe = params.timeframe || '1h';
    const timerange = params.timerange || '';
    const epochs = Math.min(Number(params.epochs) || 100, 500);
    const spaces = params.spaces || 'roi stoploss trailing buy sell';
    const jobs = Math.min(Number(params.jobs) || 1, 4);
    const lossFunc = params.loss || 'SharpeHyperOptLoss';
    const minTrades = params.min_trades || 20;

    try {
      const downloadArgs = ['download-data', '--config', CONFIG_PATH, '--timeframe', timeframe, '--userdir', USER_DATA];
      if (timerange) downloadArgs.push('--timerange', timerange);
      runFreqtrade(downloadArgs, { timeout: 300000, env: proxyEnv() });
    } catch (e) { console.error(`Data download warning: ${e.message}`); }

    console.error(`Running hyperopt: strategy=${strategy}, epochs=${epochs}, jobs=${jobs}, spaces=${spaces}`);
    const hyperoptArgs = [
      'hyperopt',
      '--config', CONFIG_PATH,
      '--strategy', strategy,
      '--strategy-path', STRAT_DIR,
      '--timeframe', timeframe,
      '--userdir', USER_DATA,
      '--hyperopt-loss', lossFunc,
      '--spaces', ...String(spaces).split(/\s+/).filter(Boolean),
      '--epochs', String(epochs),
      '-j', String(jobs),
      '--min-trades', String(minTrades),
    ];
    if (timerange) hyperoptArgs.push('--timerange', timerange);
    const output = runFreqtrade(hyperoptArgs, { timeout: 1800000, env: proxyEnv() });

    return { mode: runtimeMode(), strategy, timeframe, epochs, spaces, jobs, loss_function: lossFunc, output };
  },

  // ── create_strategy ────────────────────────────────────────────
  // 写策略文件到 STRAT_DIR (三引擎下分别是 daemon 真读的路径).
  create_strategy: async (params = {}) => {
    let name = params.name;
    if (!name) throw new Error('name is required. Example: {"name":"MyStrategy","timeframe":"15m","indicators":["rsi","macd"]}');
    name = name.replace(/[^A-Za-z0-9_]/g, '');
    if (name && /^[a-z]/.test(name)) name = name[0].toUpperCase() + name.slice(1);
    if (!/^[A-Z][A-Za-z0-9_]+$/.test(name)) throw new Error('name must be a valid Python class name starting with uppercase (e.g. MyStrategy)');

    ensureStrategyDir();
    const dest = resolve(STRAT_DIR, `${name}.py`);
    const tf = params.timeframe || '15m';
    const desc = params.description || 'Custom strategy';
    const indicators = params.indicators || null;
    const entryLogic = params.entry_logic || null;
    const exitLogic = params.exit_logic || null;
    const direction = params.direction || 'long';

    if (!['long', 'short', 'both'].includes(direction)) {
      throw new Error(`direction must be "long", "short", or "both" (default: "long")`);
    }

    if (indicators) {
      const invalid = indicators.filter((i) => !AVAILABLE_INDICATORS.includes(i.toLowerCase()));
      if (invalid.length > 0) {
        throw new Error(`Unknown indicators: ${invalid.join(', ')}. Available: ${AVAILABLE_INDICATORS.join(', ')}`);
      }
    }

    const code = buildStrategyCode(name, tf, desc, indicators, entryLogic, exitLogic, direction);
    writeFileSync(dest, code);

    const result = {
      success: true, strategy: name, file: dest,
      mode: runtimeMode(), engine: ENV ? ENV.engine : null,
      timeframe: tf, direction,
      indicators: indicators || ['rsi', 'bb', 'ema', 'volume_sma'],
      note: 'Pure technical indicator strategy. External market-intelligence data is not injected by this skill.',
      next: ENV
        ? `策略文件已写; 用 deploy {"strategy":"${name}"} 让常驻 daemon 切到这个策略 (会触发 ~30s 重启), 或先 backtest 验证`
        : `Use deploy {"strategy":"${name}"} to start in dry-run, or backtest first`,
      available_indicators: AVAILABLE_INDICATORS,
    };

    return result;
  },

  // ── strategy_list ──────────────────────────────────────────────
  strategy_list: async () => {
    const files = [];
    if (existsSync(STRAT_DIR)) {
      for (const f of readdirSync(STRAT_DIR)) {
        if (f.endsWith('.py') && f !== '__init__.py') {
          files.push(f.replace('.py', ''));
        }
      }
    }
    return { mode: runtimeMode(), strategies: files, path: STRAT_DIR };
  },

  // ── remove ─────────────────────────────────────────────────────
  remove: async () => withDeploymentLock(USER_DATA, 'remove', async () => {
    const forwardRuntime = forwardRuntimeFromConfig(readJsonFile(CONFIG_PATH));
    if (IS_DOCKER) {
      dockerCompose(['down'], { timeout: 60_000 });
      const workerPid = await stopForwardWorker(forwardRuntime);
      return { removed: true, mode: 'docker', forward_worker_pid: workerPid, note: 'Container removed. User data and config preserved.' };
    }
    if (ENV) {
      return {
        skipped: true, mode: 'coinclaw',
        note: '在 coinclaw 容器里 freqtrade 是常驻 daemon, 不能 remove. 用 stop 停 daemon, 或 deploy {"strategy":"NoOpStrategy"} 切到空跑策略, 或在 web UI 删整个 instance',
      };
    }
    const pid = getHostPid();
    if (pid) await stopHostDaemon();
    const workerPid = await stopForwardWorker(forwardRuntime);
    return { removed: true, mode: 'host', forward_worker_pid: workerPid, note: `Process stopped. Config preserved.` };
  }),

  // ── backtest_results ───────────────────────────────────────────
  backtest_results: async () => {
    const resultsDir = resolve(USER_DATA, 'backtest_results');
    const currentHashes = new Map();
    const reportCache = new Map();
    const evidence = readBacktestEvidence().map((record) => {
      if (!currentHashes.has(record.strategy)) {
        currentHashes.set(record.strategy, strategyFingerprint(record.strategy));
      }
      let verifiedResult = null;
      try { verifiedResult = verifyBacktestEvidenceResult(record); } catch {}
      let walkForwardReport = null;
      if (verifiedResult?.signalArtifact) {
        const artifactHash = verifiedResult.signalArtifact.artifactHash;
        if (!reportCache.has(artifactHash)) {
          reportCache.set(artifactHash, findWalkForwardReportForArtifact(
            loadArchivedSignalArtifact(artifactHash).artifact,
          ));
        }
        walkForwardReport = reportCache.get(artifactHash);
      }
      return {
        id: record.id,
        strategy: record.strategy,
        timeframe: record.timeframe,
        timerange: record.timerange,
        pairs: Array.isArray(record.pairs) ? record.pairs : [],
        resultFile: record.resultFile || null,
        resultHash: record.resultHash || null,
        resultMetaFile: record.resultMetaFile || null,
        resultMetaHash: record.resultMetaHash || null,
        metrics: verifiedResult?.metrics || {},
        createdAt: record.createdAt,
        signalArtifact: verifiedResult?.signalArtifact || null,
        walkForwardReport: walkForwardReport ? {
          reportHash: walkForwardReport.report.reportHash,
          reportFile: walkForwardReport.file,
        } : null,
        reconciliation: verifiedResult?.reconciliation || null,
        current: Boolean(
          verifiedResult
          && record.strategyHash
          && currentHashes.get(record.strategy) === record.strategyHash
          && (record.strategy !== HELIX_SIGNAL_STRATEGY || hasSignalExecutionEnvironment(record))
        ),
        fingerprint: typeof record.strategyHash === 'string' ? record.strategyHash.slice(0, 12) : '',
      };
    });
    if (!existsSync(resultsDir)) return { mode: runtimeMode(), results: [], evidence, path: resultsDir };
    const files = readdirSync(resultsDir)
      .filter((f) => f.endsWith('.meta.json'))
	      .map((f) => {
	        try {
	          const meta = JSON.parse(readFileSync(resolve(resultsDir, f), 'utf-8'));
	          const strategy = Object.keys(meta)[0] || 'unknown';
	          const info = meta[strategy] || {};
	          const file = f.replace('.meta.json', '');
	          const summary = firstStrategySummary(readBacktestPayload(resultsDir, file), strategy);
	          return {
	            file,
	            strategy,
	            timeframe: info.timeframe || '',
	            start: info.backtest_start_ts ? new Date(info.backtest_start_ts * 1000).toISOString().slice(0, 10) : '',
	            end: info.backtest_end_ts ? new Date(info.backtest_end_ts * 1000).toISOString().slice(0, 10) : '',
	            ...backtestMetrics(summary),
	          };
	        } catch { return null; }
	      })
      .filter(Boolean)
      .sort((a, b) => b.file.localeCompare(a.file))
      .slice(0, 10);
    return { mode: runtimeMode(), results: files, evidence, path: resultsDir };
  },
};

// ─── CLI ─────────────────────────────────────────────────────────
const [action, ...rest] = process.argv.slice(2);
if (!action || !actions[action]) {
  console.log(`Usage: node ft-deploy.mjs <action> [json-params]\nActions: ${Object.keys(actions).join(', ')}`);
  process.exit(1);
}
let params = {};
if (rest.length) {
  try {
    params = JSON.parse(rest.join(' '));
  } catch {
    console.log(JSON.stringify({
      error: `参数不是合法 JSON: ${rest.join(' ')}`,
      hint: "参数要用 JSON 对象, 例: '{\"strategy\":\"MyStrat\"}'",
    }));
    process.exit(1);
  }
}
actions[action](params).then((r) => {
  // 提示 — 只在 host 模式 / 老用法时强调走脚本; coinclaw 模式 daemon 已经
  // 在 supervisord 管, 用户从 chat agent 调用脚本就是正确路径.
  if (!ENV) r._reminder = 'IMPORTANT: Always use ft-deploy.mjs for ALL Freqtrade operations. NEVER use Docker commands.';
  console.log(JSON.stringify(r, null, 2));
}).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
