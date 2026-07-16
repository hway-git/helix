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
  readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync,
  readdirSync, renameSync, chmodSync, openSync, closeSync,
} from 'node:fs';
import { basename, resolve, dirname } from 'node:path';
import { execFileSync, execSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  coinclawEnv, dockerFreqtradeEnv, hostModeFreqtradePaths, envFileCandidates, supervisorSocket,
} from '../lib/coinclaw-env.mjs';
import { ftGet, ftPost } from '../lib/freqtrade-api.mjs';
import {
  buildStrategyCode, SAMPLE_STRATEGY,
  AVAILABLE_INDICATORS,
} from '../lib/strategy-builder.mjs';
import {
  HELIX_SIGNAL_STRATEGY,
  loadSignalArtifact,
  pinnedSignalIdentity,
  samePinnedSignalIdentity,
} from '../lib/signal-artifact.mjs';
import {
  freqtradeOhlcvFile,
  loadMarketDataset,
  marketTimeframeMilliseconds,
} from '../lib/market-dataset.mjs';
import { reconcileSignalBacktest } from '../lib/backtest-reconciliation.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));

// ─── 模式 / 路径解析 ─────────────────────────────────────────────
const COINCLAW_ENV = coinclawEnv();
const DOCKER_ENV = COINCLAW_ENV ? null : dockerFreqtradeEnv();
const ENV = COINCLAW_ENV || DOCKER_ENV;
const IS_DOCKER = ENV?.engine === 'docker';
const HOST = hostModeFreqtradePaths();
const SIGNAL_ADAPTER_ASSET_DIR = resolve(__dir, '..', 'assets');
const SIGNAL_ADAPTER_FILES = ['HelixSignalStrategy.py', 'helix_signal_artifact.py'];

// 三引擎下 STRAT_DIR / USER_DATA / CONFIG_PATH 直接来自 daemon 启动参数,
// 跟 dashboard / freqtrade /api/v1/show_config 保持完全一致 — 不会出现
// "agent 写到 ~/.freqtrade/user_data/strategies/ 但 daemon 不读" 这种坑.
const STRAT_DIR  = ENV ? ENV.strategyPath      : HOST.strategyPath;
const USER_DATA  = ENV ? ENV.freqtradeUserdir  : HOST.userdir;
const CONFIG_PATH = ENV ? ENV.configPath       : HOST.configPath;
const ENV_FILE   = ENV ? ENV.envFile           : envFileCandidates()[0]; // host: ~/.helix/.env(规范位置, 与读路径最高优先级一致)
const FT_API_PORT = 8888;
const FT_API_URL = `http://127.0.0.1:${FT_API_PORT}`;
const BACKTEST_EVIDENCE_VERSION = 2;
const BACKTEST_EVIDENCE_FILE = resolve(USER_DATA, 'backtest_results', '.helix-evidence.json');
const SIGNAL_ARTIFACT_DIR = resolve(USER_DATA, 'helix', 'signals');
const ACTIVE_SIGNAL_ARTIFACT_FILE = resolve(SIGNAL_ARTIFACT_DIR, 'active.json');
const SIGNAL_BACKTEST_DATA_DIR = resolve(USER_DATA, 'helix', 'backtest-data');

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
  if (typeof value !== 'string') return value;
  if (value === STRAT_DIR || value.startsWith(`${STRAT_DIR}/`)) {
    return `${ENV.containerStrategyPath}${value.slice(STRAT_DIR.length)}`;
  }
  if (value === USER_DATA || value.startsWith(`${USER_DATA}/`)) {
    return `${ENV.containerUserdir}${value.slice(USER_DATA.length)}`;
  }
  return value;
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

function strategyFingerprint(strategy) {
  const file = resolve(STRAT_DIR, `${strategy}.py`);
  if (!existsSync(file)) return null;
  if (strategy === HELIX_SIGNAL_STRATEGY) {
    const files = SIGNAL_ADAPTER_FILES.map((name) => resolve(STRAT_DIR, name));
    if (files.some((candidate) => !existsSync(candidate))) return null;
    const hash = createHash('sha256');
    for (const candidate of files) {
      hash.update(`${candidate.slice(STRAT_DIR.length)}\0`);
      hash.update(readFileSync(candidate));
      hash.update('\0');
    }
    return hash.digest('hex');
  }
  return createHash('sha256').update(readFileSync(file)).digest('hex');
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
    if (!signalArtifact || !record.signalArtifact?.identity) return false;
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
    if (source !== destination) copyFileSync(source, destination);
    try { chmodSync(destination, 0o644); } catch {}
  }
}

function archiveSignalArtifact(file) {
  if (typeof file !== 'string' || !file.trim()) throw new Error('signal_artifact must be a JSON file path');
  const source = resolve(file.trim());
  const artifact = loadSignalArtifact(source);
  mkdirSync(SIGNAL_ARTIFACT_DIR, { recursive: true });
  const hashFile = resolve(SIGNAL_ARTIFACT_DIR, `${artifact.artifactHash.replace(':', '-')}.json`);
  if (existsSync(hashFile)) {
    const staged = loadSignalArtifact(hashFile);
    if (staged.artifactHash !== artifact.artifactHash) throw new Error(`staged signal artifact is corrupt: ${hashFile}`);
  } else {
    const tempFile = `${hashFile}.tmp.${process.pid}`;
    copyFileSync(source, tempFile);
    chmodSync(tempFile, 0o600);
    renameSync(tempFile, hashFile);
  }
  return { artifact, hashFile };
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
  const lastCandleCloseTime = candles.at(-1).time + marketTimeframeMilliseconds(artifact.baseTimeframe);
  if (candles[0].time !== artifact.marketData.firstCandleOpenTime
    || lastCandleCloseTime !== artifact.marketData.lastCandleCloseTime) {
    throw new Error('market_dataset base timeframe window does not match signal artifact marketData');
  }
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
      lastCandleCloseTime,
    },
  };
}

function activateSignalArtifact(file) {
  const archived = archiveSignalArtifact(file);
  const activeTemp = `${ACTIVE_SIGNAL_ARTIFACT_FILE}.tmp.${process.pid}`;
  writeFileSync(activeTemp, `${JSON.stringify(archived.artifact, null, 2)}\n`);
  chmodSync(activeTemp, 0o600);
  renameSync(activeTemp, ACTIVE_SIGNAL_ARTIFACT_FILE);
  return { ...archived, activeFile: ACTIVE_SIGNAL_ARTIFACT_FILE };
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

function readBacktestZipJson(zipFile) {
  if (!hasCommand('unzip')) return null;
  try {
    const entries = runFile('unzip', ['-Z1', zipFile], { maxBuffer: 1024 * 1024 })
      .split('\n')
      .map((entry) => entry.trim())
      .filter(Boolean);
    const expectedEntry = `${basename(zipFile, '.zip')}.json`;
    const jsonEntry = entries.find((entry) => basename(entry) === expectedEntry);
    if (!jsonEntry) return null;

    const content = runFile('unzip', ['-p', zipFile, jsonEntry], { maxBuffer: 50 * 1024 * 1024 });
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function readBacktestPayload(resultsDir, file) {
  if (file.endsWith('.json')) return readJsonFile(resolve(resultsDir, file));
  if (file.endsWith('.zip')) return readBacktestZipJson(resolve(resultsDir, file));

  const jsonFile = resolve(resultsDir, `${file}.json`);
  if (existsSync(jsonFile)) return readJsonFile(jsonFile);

  const zipFile = resolve(resultsDir, `${file}.zip`);
  if (existsSync(zipFile)) return readBacktestZipJson(zipFile);

  return null;
}

function firstStrategySummary(payload, strategy) {
  if (!payload || typeof payload !== 'object') return null;
  const strategyMap = payload.strategy && typeof payload.strategy === 'object' ? payload.strategy : payload;
  if (strategyMap[strategy] && typeof strategyMap[strategy] === 'object') return strategyMap[strategy];
  return null;
}

function backtestMetrics(summary) {
  if (!summary || typeof summary !== 'object') return {};

  const trades = firstNumber(summary.total_trades, summary.trade_count, summary.trades);
  const wins = firstNumber(summary.winning_trades, summary.wins, summary.win_trades);
  const draws = firstNumber(summary.draws, summary.draw_trades);
  const losses = firstNumber(summary.losing_trades, summary.losses, summary.loss_trades);
  const winRate = firstNumber(summary.winrate, summary.win_rate)
    ?? (wins != null && trades ? wins / trades : null)
    ?? (wins != null && losses != null && (wins + losses + (draws ?? 0)) > 0 ? wins / (wins + losses + (draws ?? 0)) : null);

  return {
    trades,
    profitPct: firstNumber(summary.profit_total_pct, summary.profit_total_percent, summary.total_profit_pct, summary.profit_total),
    profitAbs: firstNumber(summary.profit_total_abs, summary.total_profit_abs, summary.profit_abs),
    winRate,
    drawdown: firstNumber(summary.max_drawdown_account, summary.max_drawdown_pct, summary.drawdown, summary.max_drawdown),
  };
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
    || !evidence.signalArtifact?.identity
    || !samePinnedSignalIdentity({ identity: evidence.signalArtifact.identity }, artifact)
    || evidence.signalArtifact.marketDataSnapshotId !== artifact.identity.marketDataSnapshotId
    || evidence.marketDataset?.datasetHash !== artifact.identity.marketDataSnapshotId) {
    throw new Error(`Backtest evidence "${evidence.id}" does not match its signal artifact identity.`);
  }
  return artifact;
}

function verifyBacktestEvidenceResult(evidence, signalArtifact = null) {
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
  const reconciliation = evidence.strategy === HELIX_SIGNAL_STRATEGY
    ? reconcileSignalBacktest(summary, evidenceSignalArtifact(evidence, signalArtifact))
    : null;
  if (fileHash(resultFile) !== actualResultHash || fileHash(resultMetaFile) !== actualResultMetaHash) {
    throw new Error(`Backtest evidence "${evidence.id}" result files changed during verification.`);
  }
  return {
    metrics: backtestMetrics(summary),
    resultHash: actualResultHash,
    resultMetaHash: actualResultMetaHash,
    reconciliation,
  };
}

function requireDeployableBacktestEvidence(evidence, signalArtifact = null) {
  const verified = verifyBacktestEvidenceResult(evidence, signalArtifact);
  const metrics = verified.metrics;
  if (metrics.trades == null || metrics.profitPct == null) {
    throw new Error(`Backtest evidence "${evidence.id}" has no verifiable trade/profit metrics. Run backtest again before deploy.`);
  }
  if (metrics.trades < 1) {
    throw new Error(`Backtest evidence "${evidence.id}" has 0 trades and cannot be deployed.`);
  }
  if (metrics.profitPct <= 0) {
    throw new Error(`Backtest evidence "${evidence.id}" is not profitable (${(metrics.profitPct * 100).toFixed(2)}%). Deployment blocked.`);
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
  } finally {
    closeSync(logFd);
  }
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

function writeDaemonConfig(cfg) {
  const bak = `${CONFIG_PATH}.bak`;
  copyFileSync(CONFIG_PATH, bak);
  try { chmodSync(bak, 0o600); } catch {}
  const tmp = `${CONFIG_PATH}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 4) + '\n');
  try { chmodSync(tmp, 0o600); } catch {}
  renameSync(tmp, CONFIG_PATH);
  try { chmodSync(CONFIG_PATH, 0o600); } catch {}
}

function restartDaemon() {
  if (IS_DOCKER) {
    dockerCompose(['up', '-d', '--force-recreate', '--no-deps', 'freqtrade'], { timeout: 60_000 });
    return { method: 'docker compose recreate' };
  }
  if (!ENV) throw new Error('restart daemon 仅在 coinclaw 容器内可用');
  const sock = supervisorSocket();
  try {
    execFileSync('supervisorctl', ['-s', `unix://${sock}`, 'restart', 'freqtrade'], {
      stdio: 'pipe', timeout: 30000,
    });
    return { method: 'supervisorctl' };
  } catch (e) {
    try {
      const pid = runFile('pgrep', ['-f', 'freqtrade trade']).split('\n')[0]?.trim();
      if (pid) {
        process.kill(Number(pid), 'SIGTERM');
        return { method: 'kill+autorestart', pid: Number(pid) };
      }
    } catch {}
    throw new Error(`restart 失败: ${e.message}`);
  }
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
    trading_mode: params.trading_mode || 'futures',
    margin_mode: params.margin_mode || 'isolated',
    max_open_trades: params.max_open_trades || 2,
    stake_currency: 'USDT',
    stake_amount: params.stake_amount || 'unlimited',
    tradable_balance_ratio: params.tradable_balance_ratio || 0.5,
    dry_run: params.dry_run !== false,
    dry_run_wallet: 1000,
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
    const signalArtifact = params.signal_artifact
      ? loadSignalArtifact(resolve(String(params.signal_artifact)))
      : null;
    if (signalArtifact) installSignalAdapter();
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
    if (!existsSync(stratFile)) {
      throw new Error(`策略文件不存在: ${stratFile}. 先用 create_strategy 创建策略并完成回测。`);
    }
    const evidence = requireDeployableBacktestEvidence(
      requireCurrentBacktestEvidence(strategy, signalArtifact),
      signalArtifact,
    );

    if (ENV) {
      const cfg = readDaemonConfig();
      const before = {
        strategy: cfg.strategy,
        dry_run: cfg.dry_run,
        pairs: cfg.exchange?.pair_whitelist,
        timeframe: cfg.timeframe,
      };
      const targetDryRun = typeof params.dry_run === 'boolean' ? params.dry_run : cfg.dry_run;
      const maxOpenTrades = requireMaxOpenTrades(params.max_open_trades ?? cfg.max_open_trades ?? 2);
      if (signalArtifact) requireSignalDeploymentLifecycle(signalArtifact, targetDryRun);
      if (targetDryRun === false) requireLiveAuthorization({ ...params, max_open_trades: maxOpenTrades }, cfg);
      const stagedArtifact = signalArtifact ? activateSignalArtifact(String(params.signal_artifact)) : null;
      cfg.strategy = strategy;
      // 允许在 deploy 里同时改 dry_run / pairs / max_open_trades, 一次完成.
      cfg.dry_run = targetDryRun;
      if (deploymentPairs.length) {
        if (!cfg.exchange) cfg.exchange = {};
        cfg.exchange.pair_whitelist = deploymentPairs;
      } else if (signalArtifact) {
        if (!cfg.exchange) cfg.exchange = {};
        cfg.exchange.pair_whitelist = [signalArtifact.symbol];
      }
      if (signalArtifact) cfg.timeframe = signalArtifact.baseTimeframe;
      cfg.max_open_trades = maxOpenTrades;
      writeDaemonConfig(cfg);
      const restart = restartDaemon();
      return {
        success: true, mode: runtimeMode(), engine: ENV.engine,
        strategy, before, restart, backtest_evidence: evidence.id,
        signal_artifact: stagedArtifact ? {
          hash: stagedArtifact.artifact.artifactHash,
          identity: pinnedSignalIdentity(stagedArtifact.artifact),
          lifecycle: stagedArtifact.artifact.strategyLifecycle,
          active_file: stagedArtifact.activeFile,
        } : null,
        config_path: CONFIG_PATH, strategy_file: stratFile,
        note: '策略生效需 daemon 重启完成 (10-30s); dashboard 会自动刷新到新策略名',
        warning: cfg.dry_run === false
          ? '⚠️ 已切到实盘 — 真实交易, 真实亏损. 确认 .env 里交易所 key 正确, 余额可控.'
          : null,
      };
    }
    // host mode
    const targetDryRun = params.dry_run !== false;
    const maxOpenTrades = requireMaxOpenTrades(params.max_open_trades ?? 2);
    if (signalArtifact) requireSignalDeploymentLifecycle(signalArtifact, targetDryRun);
    if (!targetDryRun) {
      requireLiveAuthorization({ ...params, max_open_trades: maxOpenTrades }, {
        max_open_trades: maxOpenTrades,
        exchange: { name: params.exchange || detectExchange()?.name || '' },
      });
    }
    ensureHostFreqtradeInstalled();
    const stagedArtifact = signalArtifact ? activateSignalArtifact(String(params.signal_artifact)) : null;
    let exchangeInfo = detectExchange();
    if (!exchangeInfo) {
      if (params.dry_run !== false) {
        const exName = params.exchange || 'binance';
        exchangeInfo = { name: exName, key: 'dry-run', secret: 'dry-run' };
        console.error(`No exchange API keys found — using dummy keys for dry-run (${exName})`);
      } else {
        throw new Error('No exchange API keys found in .env (required for live trading)');
      }
    }
    mkdirSync(STRAT_DIR, { recursive: true });
    const apiPassword = randomBytes(8).toString('hex');
    const config = generateHostConfig(exchangeInfo, apiPassword, {
      ...params,
      dry_run: targetDryRun,
      max_open_trades: maxOpenTrades,
      ...(signalArtifact ? {
        timeframe: signalArtifact.baseTimeframe,
        pairs: deploymentPairs.length ? deploymentPairs : [signalArtifact.symbol],
      } : {}),
    });
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    try { chmodSync(CONFIG_PATH, 0o600); } catch {} // config.json 含明文交易所 key/secret, 收紧权限
    const samplePath = resolve(STRAT_DIR, 'SampleStrategy.py');
    if (!existsSync(samplePath)) writeFileSync(samplePath, SAMPLE_STRATEGY);
    const oldPid = getHostPid();
    if (oldPid) { try { process.kill(oldPid, 'SIGTERM'); } catch {} }
    startHostTrade(strategy);
    let ready = false;
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const pid = getHostPid();
      if (pid) {
        try {
          const res = await fetch(`${FT_API_URL}/api/v1/ping`, {
            headers: { Authorization: 'Basic ' + Buffer.from(`freqtrade:${apiPassword}`).toString('base64') },
            signal: AbortSignal.timeout(3000),
          });
          if (res.ok) { ready = true; break; }
        } catch {}
      }
    }
    appendEnv('FREQTRADE_URL', FT_API_URL);
    appendEnv('FREQTRADE_USERNAME', 'freqtrade');
    appendEnv('FREQTRADE_PASSWORD', apiPassword);
    return {
      success: true, mode: 'host', backtest_evidence: evidence.id,
      signal_artifact: stagedArtifact ? {
        hash: stagedArtifact.artifact.artifactHash,
        identity: pinnedSignalIdentity(stagedArtifact.artifact),
        lifecycle: stagedArtifact.artifact.strategyLifecycle,
        active_file: stagedArtifact.activeFile,
      } : null,
      exchange: exchangeInfo.name, strategy, dry_run: config.dry_run,
      pairs: config.exchange.pair_whitelist,
      api_url: FT_API_URL, api_auth: 'stored in .env (FREQTRADE_PASSWORD)',
      pid: getHostPid(), ready, log_file: HOST.logFile, config_path: CONFIG_PATH,
      strategies_dir: STRAT_DIR,
      note: config.dry_run ? 'Running in DRY-RUN mode' : 'WARNING: Running in LIVE mode',
    };
  },

  // ── update ─────────────────────────────────────────────────────
  update: async () => {
    if (IS_DOCKER) {
      dockerCompose(['pull', 'freqtrade']);
      dockerCompose(['up', '-d', 'freqtrade']);
      return { updated: true, mode: 'docker', note: 'Pulled the stable image and recreated the daemon.' };
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
    if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    console.error('Updating Freqtrade...');
    runFile(resolve(HOST.sourceDir, 'setup.sh'), ['-u'], { cwd: HOST.sourceDir, timeout: 600000 });
    return { updated: true, mode: 'host', note: 'Run start to restart Freqtrade.' };
  },

  // ── status ─────────────────────────────────────────────────────
  status: async () => {
    if (IS_DOCKER) {
      const state = await fetchDaemonState();
      let lastLogs = '';
      try { lastLogs = dockerCompose(['logs', '--tail', '10', '--no-color', 'freqtrade']); } catch {}
      return { mode: 'docker', engine: ENV.engine, ...state, last_logs: lastLogs };
    }
    if (ENV) {
      const state = await fetchDaemonState();
      const result = { mode: 'coinclaw', engine: ENV.engine, ...state };
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
    if (!pid) return { mode: 'host', running: false };
    let lastLogs = '';
    try { lastLogs = runFile('tail', ['-5', HOST.logFile]); } catch {}
    return { mode: 'host', running: true, pid, log_file: HOST.logFile, last_logs: lastLogs };
  },

  // ── stop / start ───────────────────────────────────────────────
  // coinclaw 模式: supervisorctl. host 模式: SIGTERM pid.
  stop: async () => {
    if (IS_DOCKER) {
      dockerCompose(['stop', 'freqtrade'], { timeout: 60_000 });
      return { stopped: true, mode: 'docker', method: 'docker compose stop' };
    }
    if (ENV) {
      const sock = supervisorSocket();
      try {
        runFile('supervisorctl', ['-s', `unix://${sock}`, 'stop', 'freqtrade']);
        return { stopped: true, mode: 'coinclaw', method: 'supervisorctl' };
      } catch (e) {
        return { stopped: false, error: e.message, note: 'supervisorctl 不可达, 试试 ft.mjs stop (REST)' };
      }
    }
    const pid = getHostPid();
    if (!pid) return { stopped: false, mode: 'host', reason: 'Not running' };
    try { process.kill(pid, 'SIGTERM'); } catch {}
    try { writeFileSync(HOST.pidFile, ''); } catch {}
    return { stopped: true, mode: 'host', pid };
  },

  start: async (params = {}) => {
    if (IS_DOCKER) {
      dockerCompose(['up', '-d', 'freqtrade'], { timeout: 60_000 });
      return { started: true, mode: 'docker', method: 'docker compose up' };
    }
    if (ENV) {
      const sock = supervisorSocket();
      try {
        runFile('supervisorctl', ['-s', `unix://${sock}`, 'start', 'freqtrade']);
        return { started: true, mode: 'coinclaw', method: 'supervisorctl' };
      } catch (e) {
        return { started: false, error: e.message };
      }
    }
    if (getHostPid()) return { started: false, mode: 'host', reason: 'Already running' };
    if (!existsSync(FT_BIN)) throw new Error('Freqtrade not installed. Run deploy first.');
    if (!existsSync(CONFIG_PATH)) throw new Error('No config found. Run deploy first.');
    const strategy = assertStrategyName(params.strategy || 'SampleStrategy');
    startHostTrade(strategy);
    await new Promise((r) => setTimeout(r, 3000));
    return { started: true, mode: 'host', pid: getHostPid() };
  },

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
  backtest: async (params = {}) => {
    const signalArtifact = params.signal_artifact
      ? loadSignalArtifact(resolve(String(params.signal_artifact)))
      : null;
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
    const stagedDataset = signalArtifact
      ? stageSignalBacktestDataset(String(params.market_dataset), signalArtifact)
      : null;
    if (signalArtifact) installSignalAdapter();
    const archivedArtifact = signalArtifact ? archiveSignalArtifact(String(params.signal_artifact)) : null;
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
    const stratFile = resolve(STRAT_DIR, `${strategy}.py`);
    if (!existsSync(stratFile)) {
      throw new Error(`Strategy "${strategy}" not found at ${stratFile}. Use create_strategy or list with strategy_list.`);
    }
    const timerange = signalArtifact ? '' : params.timerange || '';
    const fee = params.fee === undefined ? null : Number(params.fee);
    if (fee !== null && (!Number.isFinite(fee) || fee < 0)) throw new Error('fee must be a non-negative number');
    const resultsDir = resolve(USER_DATA, 'backtest_results');
    const previousResultFiles = new Set(backtestMetaFiles(resultsDir));
    const strategyHash = strategyFingerprint(strategy);
    if (!strategyHash) throw new Error(`Unable to fingerprint strategy: ${stratFile}`);
    const configHash = fileHash(CONFIG_PATH);
    if (!configHash) throw new Error(`Unable to fingerprint Freqtrade config: ${CONFIG_PATH}`);
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
      '--config', CONFIG_PATH,
      '--strategy', strategy,
      '--strategy-path', STRAT_DIR,
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
      HELIX_SIGNAL_TIMEFRAME: signalArtifact.baseTimeframe,
    } : proxyEnv();
    const rawOutput = runFreqtrade(backtestArgs, { timeout: 600000, env: backtestEnv });
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
    const freqtradeVersion = runFreqtrade(['--version'], { timeout: 60000, env: proxyEnv() });
    if (strategyFingerprint(strategy) !== strategyHash) {
      throw new Error(`Strategy "${strategy}" changed during backtest. Run the backtest again for the current code.`);
    }
    requireUnchangedFile(CONFIG_PATH, configHash, 'Freqtrade config');
    if (stagedDataset) requireUnchangedFile(stagedDataset.dataFile, stagedDataHash, 'Staged market dataset');
    if (archivedArtifact) {
      requireUnchangedFile(archivedArtifact.hashFile, archivedArtifactFileHash, 'Archived signal artifact');
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
        fee,
        dataFormatOhlcv: stagedDataset ? 'json' : null,
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
  remove: async () => {
    if (IS_DOCKER) {
      dockerCompose(['down'], { timeout: 60_000 });
      return { removed: true, mode: 'docker', note: 'Container removed. User data and config preserved.' };
    }
    if (ENV) {
      return {
        skipped: true, mode: 'coinclaw',
        note: '在 coinclaw 容器里 freqtrade 是常驻 daemon, 不能 remove. 用 stop 停 daemon, 或 deploy {"strategy":"NoOpStrategy"} 切到空跑策略, 或在 web UI 删整个 instance',
      };
    }
    const pid = getHostPid();
    if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    try { writeFileSync(HOST.pidFile, ''); } catch {}
    return { removed: true, mode: 'host', note: `Process stopped. Config preserved.` };
  },

  // ── backtest_results ───────────────────────────────────────────
  backtest_results: async () => {
    const resultsDir = resolve(USER_DATA, 'backtest_results');
    const currentHashes = new Map();
    const evidence = readBacktestEvidence().map((record) => {
      if (!currentHashes.has(record.strategy)) {
        currentHashes.set(record.strategy, strategyFingerprint(record.strategy));
      }
      let verifiedResult = null;
      try { verifiedResult = verifyBacktestEvidenceResult(record); } catch {}
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
        signalArtifact: record.signalArtifact || null,
        reconciliation: verifiedResult?.reconciliation || null,
        current: Boolean(
          verifiedResult
          && record.strategyHash
          && currentHashes.get(record.strategy) === record.strategyHash
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
