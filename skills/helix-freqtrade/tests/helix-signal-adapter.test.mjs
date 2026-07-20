import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  signalArtifactHash,
  verifySignalArtifact,
} from '../lib/signal-artifact.mjs';
import { marketDatasetHash } from '../lib/market-dataset.mjs';
import { reconcileSignalBacktest } from '../lib/backtest-reconciliation.mjs';
import { historicalRiskTraceHash } from '../lib/historical-risk.mjs';
import { futuresCostDatasetIdentity } from '../lib/futures-cost-dataset.mjs';
import { futuresCostDatasetFixture } from './helpers/futures-cost-dataset.mjs';

const execFileAsync = promisify(execFile);
const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VALIDATOR = resolve(SKILL_DIR, 'assets', 'helix_signal_artifact.py');
const BATCH_VALIDATOR = resolve(SKILL_DIR, 'assets', 'helix_signal_batch.py');
const ADAPTER = resolve(SKILL_DIR, 'assets', 'HelixSignalStrategy.py');
const DEPLOY = resolve(SKILL_DIR, 'scripts', 'ft-deploy.mjs');

function canonicalBatchJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('batch fixture numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalBatchJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalBatchJson(value[key])}`
    )).join(',')}}`;
  }
  throw new Error(`unsupported batch fixture value ${typeof value}`);
}

function batchHash(payload) {
  return `sha256:${createHash('sha256').update(canonicalBatchJson(payload)).digest('hex')}`;
}

function fixture(marketDataSnapshotId = 'okx-btc-2026-07-01') {
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
      marketDataSnapshotId,
    },
    strategyLifecycle: 'proposal',
    objectModel: 'PRICE_EVENT',
    symbol: 'BTC/USDT:USDT',
    baseTimeframe: '1m',
    marketData: { firstCandleOpenTime: first, lastCandleCloseTime: first + 3 * minute },
    signals: [
      {
        sequence: 0,
        signalId: 'btc-scalp-enter-001',
        decisionId: 'decision-001',
        object: { model: 'PRICE_EVENT', id: 'event-001' },
        action: 'ENTER',
        side: 'LONG',
        sourceCandleOpenTime: first,
        decisionTime: first + minute,
        reasonCodes: ['EXECUTION_TRIGGERED'],
      },
      {
        sequence: 1,
        signalId: 'btc-scalp-exit-001',
        decisionId: 'decision-002',
        object: { model: 'PRICE_EVENT', id: 'event-001' },
        action: 'EXIT',
        side: 'LONG',
        sourceCandleOpenTime: first + 2 * minute,
        decisionTime: first + 3 * minute,
        reasonCodes: ['TIME_STOP'],
      },
    ],
  };
  return {
    ...payload,
    artifactHash: signalArtifactHash(payload),
  };
}

function forwardBatchFixture() {
  const first = 1_782_864_000_000;
  const deploymentPayload = {
    schemaVersion: 'helix.forward-deployment/v1',
    deploymentId: 'python-batch-test',
    mode: 'dry_run',
    activatedAt: first - 1,
    provider: 'okx',
    instrumentId: 'BTC-USDT-SWAP',
    symbol: 'BTC/USDT:USDT',
    strategy: {
      id: 'helix_scalp_hunter',
      version: '1.0.1',
      repoCommit: 'a'.repeat(40),
      configHash: `sha256:${'b'.repeat(64)}`,
      engineCommit: 'c'.repeat(40),
      lifecycle: 'shadow',
      objectModel: 'PRICE_EVENT',
      baseTimeframe: '1m',
    },
  };
  const deployment = { ...deploymentPayload, deploymentHash: signalArtifactHash(deploymentPayload) };
  const position = {
    object: { model: 'PRICE_EVENT', id: 'event-forward-1' },
    side: 'LONG',
    entrySignalId: 'enter-forward-1',
  };
  const riskIntent = {
    entryPrice: 100,
    initialStop: 95,
    initialTarget: 110,
    riskDistance: 5,
    riskR: 0.25,
    riskUnitRatio: 0.01,
  };
  const enterPayload = {
    schemaVersion: 'helix.signal-batch/v2',
    deploymentHash: deployment.deploymentHash,
    batchSequence: 0,
    previousBatchHash: null,
    previousDecisionStateHash: null,
    evaluatorStateHash: `sha256:${'1'.repeat(64)}`,
    decisionStateHash: `sha256:${'2'.repeat(64)}`,
    identity: {
      strategyId: deployment.strategy.id,
      strategyVersion: deployment.strategy.version,
      strategyRepoCommit: deployment.strategy.repoCommit,
      strategyConfigHash: deployment.strategy.configHash,
      engineCommit: deployment.strategy.engineCommit,
      marketDataSnapshotId: `sha256:${'d'.repeat(64)}`,
    },
    strategyLifecycle: 'shadow',
    objectModel: 'PRICE_EVENT',
    symbol: deployment.symbol,
    baseTimeframe: '1m',
    positionBefore: null,
    positionAfter: position,
    riskIntent,
    signal: {
      sequence: 0,
      signalId: position.entrySignalId,
      decisionId: 'decision-forward-1',
      object: position.object,
      action: 'ENTER',
      side: 'LONG',
      sourceCandleOpenTime: first,
      decisionTime: first + 60_000,
      reasonCodes: ['EXECUTION_TRIGGERED'],
    },
  };
  enterPayload.decisionStateHash = batchHash({
    schemaVersion: 'helix.forward-decision-state/v1',
    deploymentHash: enterPayload.deploymentHash,
    decisionTime: enterPayload.signal.decisionTime,
    marketDataSnapshotId: enterPayload.identity.marketDataSnapshotId,
    previousDecisionStateHash: enterPayload.previousDecisionStateHash,
    evaluatorStateHash: enterPayload.evaluatorStateHash,
    position: enterPayload.positionAfter,
    riskIntent: enterPayload.riskIntent,
    signal: {
      signalId: enterPayload.signal.signalId,
      decisionId: enterPayload.signal.decisionId,
      object: enterPayload.signal.object,
      action: enterPayload.signal.action,
      side: enterPayload.signal.side,
      reasonCodes: enterPayload.signal.reasonCodes,
    },
  });
  const enter = { ...enterPayload, batchHash: batchHash(enterPayload) };
  const exitPayload = {
    ...enterPayload,
    batchSequence: 1,
    previousBatchHash: enter.batchHash,
    previousDecisionStateHash: enter.decisionStateHash,
    evaluatorStateHash: `sha256:${'3'.repeat(64)}`,
    decisionStateHash: `sha256:${'4'.repeat(64)}`,
    identity: { ...enterPayload.identity, marketDataSnapshotId: `sha256:${'e'.repeat(64)}` },
    positionBefore: position,
    positionAfter: null,
    riskIntent: null,
    signal: {
      ...enterPayload.signal,
      sequence: 1,
      signalId: 'exit-forward-1',
      decisionId: 'decision-forward-2',
      action: 'EXIT',
      sourceCandleOpenTime: first + 60_000,
      decisionTime: first + 120_000,
      reasonCodes: ['TIME_STOP'],
    },
  };
  exitPayload.decisionStateHash = batchHash({
    schemaVersion: 'helix.forward-decision-state/v1',
    deploymentHash: exitPayload.deploymentHash,
    decisionTime: exitPayload.signal.decisionTime,
    marketDataSnapshotId: exitPayload.identity.marketDataSnapshotId,
    previousDecisionStateHash: exitPayload.previousDecisionStateHash,
    evaluatorStateHash: exitPayload.evaluatorStateHash,
    position: exitPayload.positionAfter,
    riskIntent: exitPayload.riskIntent,
    signal: {
      signalId: exitPayload.signal.signalId,
      decisionId: exitPayload.signal.decisionId,
      object: exitPayload.signal.object,
      action: exitPayload.signal.action,
      side: exitPayload.signal.side,
      reasonCodes: exitPayload.signal.reasonCodes,
    },
  });
  const exit = { ...exitPayload, batchHash: batchHash(exitPayload) };
  return { deployment, batches: [enter, exit] };
}

function marketDatasetFixture() {
  const first = 1_782_864_000_000;
  const minute = 60_000;
  const payload = {
    schemaVersion: 'helix.market-dataset/v1',
    source: {
      provider: 'okx',
      market: 'futures',
      instrumentId: 'BTC-USDT-SWAP',
      symbol: 'BTC/USDT:USDT',
    },
    capturedThrough: first + 3 * minute,
    timeframes: {
      '1m': [
        { time: first, open: 100, high: 102, low: 99, close: 101, volume: 10 },
        { time: first + minute, open: 101, high: 103, low: 100, close: 102, volume: 11 },
        { time: first + 2 * minute, open: 102, high: 104, low: 101, close: 103, volume: 12 },
      ],
    },
  };
  return { ...payload, datasetHash: marketDatasetHash(payload) };
}

async function runDeployAction(home, action, params) {
  return execFileAsync(process.execPath, [DEPLOY, action, JSON.stringify(params)], {
    cwd: SKILL_DIR,
    env: { ...process.env, HOME: home, HELIX_FREQTRADE_RUNTIME: '' },
  });
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

async function writeSignalBacktestFiles(resultsDir, { exitReason } = {}) {
  const artifact = fixture();
  const resultFile = 'backtest-result-signal.json';
  const resultMetaFile = 'backtest-result-signal.meta.json';
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
          exit_reason: exitReason || artifact.signals[1].signalId,
          amount: 1,
          funding_fees: 0,
        }],
      },
    },
  });
  const resultMetaContent = JSON.stringify({
    HelixSignalStrategy: { run_id: 'signal-test-run', timeframe: '1m' },
  });
  await writeFile(join(resultsDir, resultFile), resultContent);
  await writeFile(join(resultsDir, resultMetaFile), resultMetaContent);
  return {
    resultFile,
    resultMetaFile,
    resultHash: `sha256:${createHash('sha256').update(resultContent).digest('hex')}`,
    resultMetaHash: `sha256:${createHash('sha256').update(resultMetaContent).digest('hex')}`,
  };
}

function pinnedIdentity(artifact) {
  return {
    strategyId: artifact.identity.strategyId,
    strategyVersion: artifact.identity.strategyVersion,
    strategyRepoCommit: artifact.identity.strategyRepoCommit,
    strategyConfigHash: artifact.identity.strategyConfigHash,
    engineCommit: artifact.identity.engineCommit,
  };
}

test('Python verifies the exact artifact hash produced by the TypeScript canonical contract', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-signal-artifact-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifactFile = join(directory, 'artifact.json');
  const artifact = fixture();
  assert.equal(verifySignalArtifact(artifact), artifact);
  await writeFile(artifactFile, JSON.stringify(artifact));

  const verified = await execFileAsync('python3', [VALIDATOR, 'verify', artifactFile]);
  assert.deepEqual(JSON.parse(verified.stdout), {
    ok: true,
    artifacts: 1,
    hashes: [artifact.artifactHash],
  });

  const selected = await execFileAsync('python3', [
    VALIDATOR,
    'signals',
    artifactFile,
    'BTC/USDT:USDT',
    '1m',
  ]);
  assert.deepEqual(JSON.parse(selected.stdout), [
    {
      action: 'ENTER',
      side: 'LONG',
      sourceCandleOpenTime: artifact.signals[0].sourceCandleOpenTime,
      signalId: 'btc-scalp-enter-001',
    },
    {
      action: 'EXIT',
      side: 'LONG',
      sourceCandleOpenTime: artifact.signals[1].sourceCandleOpenTime,
      signalId: 'btc-scalp-exit-001',
    },
  ]);
});

test('Python verifies the Node-compatible forward deployment and Signal Batch hash chain', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-signal-batches-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const deploymentFile = join(directory, 'deployment.json');
  const batchesDir = join(directory, 'batches');
  await mkdir(batchesDir);
  const { deployment, batches } = forwardBatchFixture();
  await writeFile(deploymentFile, JSON.stringify(deployment));
  for (const batch of batches) {
    const name = `${String(batch.batchSequence).padStart(12, '0')}-${batch.batchHash.replace(':', '-')}.json`;
    await writeFile(join(batchesDir, name), JSON.stringify(batch));
  }

  const verified = await execFileAsync('python3', [BATCH_VALIDATOR, 'verify', deploymentFile, batchesDir]);
  assert.deepEqual(JSON.parse(verified.stdout), {
    ok: true,
    deploymentHash: deployment.deploymentHash,
    batches: 2,
    lastBatchHash: batches[1].batchHash,
  });
  const indexed = await execFileAsync('python3', [
    BATCH_VALIDATOR, 'signals', deploymentFile, batchesDir, deployment.symbol, deployment.strategy.baseTimeframe,
  ]);
  assert.deepEqual(JSON.parse(indexed.stdout).map((signal) => signal.signalId), [
    'enter-forward-1', 'exit-forward-1',
  ]);

  const tampered = { ...batches[1], signal: { ...batches[1].signal, reasonCodes: ['CHANGED'] } };
  const exitFile = join(
    batchesDir,
    `${String(tampered.batchSequence).padStart(12, '0')}-${tampered.batchHash.replace(':', '-')}.json`,
  );
  await writeFile(exitFile, JSON.stringify(tampered));
  await assert.rejects(
    execFileAsync('python3', [BATCH_VALIDATOR, 'verify', deploymentFile, batchesDir]),
    /signal batch hash mismatch/,
  );
});

test('Python rejects a validly shaped artifact after any executable decision is changed', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-signal-tamper-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifactFile = join(directory, 'artifact.json');
  const artifact = fixture();
  artifact.signals[0].reasonCodes = ['CHANGED_EXECUTION_REASON'];
  await writeFile(artifactFile, JSON.stringify(artifact));

  await assert.rejects(
    execFileAsync('python3', [VALIDATOR, 'verify', artifactFile]),
    (error) => {
      assert.match(error.stderr, /signal artifact hash mismatch/);
      return true;
    },
  );
});

test('Node and Python reject an EXIT without a matching object ENTER', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-signal-order-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifactFile = join(directory, 'artifact.json');
  const original = fixture();
  const { artifactHash: _originalHash, ...originalPayload } = original;
  const payload = {
    ...originalPayload,
    signals: [{ ...original.signals[1], sequence: 0 }],
  };
  const artifact = { ...payload, artifactHash: signalArtifactHash(payload) };
  assert.throws(() => verifySignalArtifact(artifact), /EXIT for object event-001 has no matching ENTER/);
  await writeFile(artifactFile, JSON.stringify(artifact));

  await assert.rejects(
    execFileAsync('python3', [VALIDATOR, 'verify', artifactFile]),
    (error) => {
      assert.match(error.stderr, /EXIT for object event-001 has no matching ENTER/);
      return true;
    },
  );
});

test('Node and Python reject overlapping positions and same-candle signal conflicts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-signal-conflicts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = fixture();
  const { artifactHash: _originalHash, ...originalPayload } = original;
  const overlappingPayload = {
    ...originalPayload,
    signals: original.signals.map((signal, index) => index === 1 ? {
      ...signal,
      object: { model: 'PRICE_EVENT', id: 'event-002' },
      action: 'ENTER',
      side: 'SHORT',
    } : signal),
  };
  const conflictingPayload = {
    ...overlappingPayload,
    signals: overlappingPayload.signals.map((signal, index) => index === 1 ? {
      ...signal,
      sourceCandleOpenTime: original.signals[0].sourceCandleOpenTime,
      decisionTime: original.signals[0].decisionTime,
    } : signal),
  };
  const cases = [
    {
      name: 'overlap',
      payload: overlappingPayload,
      message: /overlaps open position for object event-001/,
    },
    {
      name: 'same-candle',
      payload: conflictingPayload,
      message: /multiple signals at decisionTime/,
    },
  ];

  for (const item of cases) {
    const artifact = { ...item.payload, artifactHash: signalArtifactHash(item.payload) };
    assert.throws(() => verifySignalArtifact(artifact), item.message);
    const artifactFile = join(directory, `${item.name}.json`);
    await writeFile(artifactFile, JSON.stringify(artifact));
    await assert.rejects(
      execFileAsync('python3', [VALIDATOR, 'verify', artifactFile]),
      (error) => {
        assert.match(error.stderr, item.message);
        return true;
      },
    );
  }
});

test('Freqtrade adapter contains only artifact loading and four-column timestamp mapping', async () => {
  const source = await readFile(ADAPTER, 'utf8');
  assert.match(source, /signals_for/);
  assert.match(source, /def bot_start/);
  for (const column of ['enter_long', 'enter_short', 'exit_long', 'exit_short']) {
    assert.match(source, new RegExp(column));
  }
  assert.match(source, /process_only_new_candles\s*=\s*False/);
  assert.doesNotMatch(source, /\b(?:rsi|macd|ema|atr|liquidity_sweep|breakout_failure|momentum_burst)\b/i);
});

test('Freqtrade adapter preserves LONG tags and exchange-rounded candle-bound exits', async () => {
  const harness = `
import importlib.util
import json
import os
import sys
import types


class Series:
    def __init__(self, values, unit=None):
        self.values = list(values)
        self.unit = unit
        self.loc = SeriesLoc(self)

    def astype(self, dtype):
        if dtype == 'datetime64[ns, UTC]' and self.unit == 'ms':
            return Series((value * 1_000_000 for value in self.values), 'ns')
        return self

    def __floordiv__(self, divisor):
        return Series(value // divisor for value in self.values)

    def map(self, mapping):
        if callable(mapping):
            return Series((mapping(value) for value in self.values), self.unit)
        return Series(mapping.get(value) for value in self.values)

    def notna(self):
        return Series(value is not None for value in self.values)


class SeriesLoc:
    def __init__(self, series):
        self.series = series

    def __getitem__(self, mask):
        return [value for value, matched in zip(self.series.values, mask.values) if matched]


class FrameLoc:
    def __init__(self, frame):
        self.frame = frame

    def __setitem__(self, key, value):
        mask, column = key
        selected = iter(value) if isinstance(value, list) else None
        for index, matched in enumerate(mask.values):
            if matched:
                self.frame.columns[column][index] = next(selected) if selected else value


class DataFrame:
    def __init__(self, columns):
        self.columns = {name: list(values) for name, values in columns.items()}
        self.loc = FrameLoc(self)

    @property
    def empty(self):
        return not self.columns or not next(iter(self.columns.values()))

    def __getitem__(self, column):
        return Series(self.columns[column], 'ms' if column == 'date' else None)

    def __setitem__(self, column, value):
        if isinstance(value, Series):
            self.columns[column] = list(value.values)
            return
        row_count = len(next(iter(self.columns.values())))
        self.columns[column] = [value] * row_count


pandas = types.ModuleType('pandas')
pandas.DataFrame = DataFrame
sys.modules['pandas'] = pandas

freqtrade = types.ModuleType('freqtrade')
freqtrade_strategy = types.ModuleType('freqtrade.strategy')
freqtrade_strategy.IStrategy = type('IStrategy', (), {})
freqtrade.strategy = freqtrade_strategy
sys.modules['freqtrade'] = freqtrade
sys.modules['freqtrade.strategy'] = freqtrade_strategy

artifact = types.ModuleType('helix_signal_artifact')
artifact.SignalArtifactError = ValueError
artifact.load_artifacts = lambda _path: []
artifact.path_fingerprint = lambda _path: None
artifact.signals_for = lambda _artifacts, _pair, _timeframe: {}
sys.modules['helix_signal_artifact'] = artifact

batch = types.ModuleType('helix_signal_batch')
batch.batch_path_fingerprint = lambda _deployment, _batches: None
batch.load_batch_chain = lambda _deployment, _batches: ({}, [])
batch.require_worker_heartbeat = lambda _status, _deployment_hash: {}
batch.signals_for_batches = lambda _batches, _pair, _timeframe: {}
batch.risk_intents_for_batches = lambda _batches, _pair, _timeframe: {}
batch.validate_risk_intent = lambda value, _action, _side: value
sys.modules['helix_signal_batch'] = batch

spec = importlib.util.spec_from_file_location('HelixSignalStrategy', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

first = 1_782_864_000_000
indexes = {
    ('ENTER', 'LONG'): {first: 'enter-long'},
    ('ENTER', 'SHORT'): {},
    ('EXIT', 'LONG'): {first: 'exit-long'},
    ('EXIT', 'SHORT'): {},
}
strategy = module.HelixSignalStrategy()
strategy._signal_index = lambda _pair: indexes
os.environ['HELIX_SIGNAL_ARTIFACT_OVERRIDE'] = '1'
frame = DataFrame({
    'date': [first],
    'open': [2.3707000000000003],
    'high': [2.3796],
    'low': [2.3707000000000003],
    'close': [2.3778],
})
strategy.populate_indicators(frame, {'pair': 'BTC/USDT:USDT'})
strategy.populate_entry_trend(frame, {'pair': 'BTC/USDT:USDT'})
strategy.populate_exit_trend(frame, {'pair': 'BTC/USDT:USDT'})
print(json.dumps(frame.columns))
`;
  const evaluated = await execFileAsync('python3', ['-c', harness, ADAPTER]);
  const columns = JSON.parse(evaluated.stdout);
  assert.deepEqual(columns.enter_long, [1]);
  assert.deepEqual(columns.enter_short, [0]);
  assert.deepEqual(columns.enter_tag, ['enter-long']);
  assert.deepEqual(columns.exit_long, [1]);
  assert.deepEqual(columns.exit_short, [0]);
  assert.deepEqual(columns.exit_tag, ['exit-long']);
  assert.equal(2.3707 >= columns.low[0], true);
  assert.equal(2.3707 <= columns.high[0], true);
  assert.equal(columns.open[0], 2.3707000000000003);
  assert.equal(columns.close[0], 2.3778);
});

test('adapter pins the configured hash and uses an explicit backtest override', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-adapter-pin-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configured = fixture();
  const overridePayload = {
    ...configured,
    identity: { ...configured.identity, strategyVersion: '1.0.2' },
  };
  delete overridePayload.artifactHash;
  const override = { ...overridePayload, artifactHash: signalArtifactHash(overridePayload) };
  const configuredFile = join(home, 'configured.json');
  const overrideFile = join(home, 'override.json');
  await writeFile(configuredFile, JSON.stringify(configured));
  await writeFile(overrideFile, JSON.stringify(override));

  const harness = String.raw`
import importlib.util
import json
import os
import sys
import types

pandas = types.ModuleType('pandas')
pandas.DataFrame = type('DataFrame', (), {})
sys.modules['pandas'] = pandas
freqtrade = types.ModuleType('freqtrade')
freqtrade_strategy = types.ModuleType('freqtrade.strategy')
freqtrade_strategy.IStrategy = type('IStrategy', (), {})
freqtrade.strategy = freqtrade_strategy
sys.modules['freqtrade'] = freqtrade
sys.modules['freqtrade.strategy'] = freqtrade_strategy

validator_spec = importlib.util.spec_from_file_location('helix_signal_artifact', sys.argv[1])
validator = importlib.util.module_from_spec(validator_spec)
sys.modules['helix_signal_artifact'] = validator
validator_spec.loader.exec_module(validator)
batch_spec = importlib.util.spec_from_file_location('helix_signal_batch', sys.argv[2])
batch = importlib.util.module_from_spec(batch_spec)
sys.modules['helix_signal_batch'] = batch
batch_spec.loader.exec_module(batch)
adapter_spec = importlib.util.spec_from_file_location('HelixSignalStrategy', sys.argv[3])
adapter = importlib.util.module_from_spec(adapter_spec)
adapter_spec.loader.exec_module(adapter)

strategy = adapter.HelixSignalStrategy()
strategy.config = json.loads(sys.argv[4])
strategy.timeframe = '1m'
index = strategy._signal_index('BTC/USDT:USDT')
print(json.dumps(sorted(index[('ENTER', 'LONG')].values())))
`;
  const config = {
    helix_signal_artifact_path: configuredFile,
    helix_signal_artifact_hash: configured.artifactHash,
  };
  const baseEnv = {
    ...process.env,
    HELIX_SIGNAL_ARTIFACT_PATH: overrideFile,
    HELIX_SIGNAL_ARTIFACT_OVERRIDE: '',
    HELIX_SIGNAL_ARTIFACT_HASH: '',
  };
  const fromConfig = await execFileAsync('python3', ['-c', harness, VALIDATOR, BATCH_VALIDATOR, ADAPTER, JSON.stringify(config)], {
    env: baseEnv,
  });
  assert.deepEqual(JSON.parse(fromConfig.stdout), [configured.signals[0].signalId]);

  const fromOverride = await execFileAsync('python3', ['-c', harness, VALIDATOR, BATCH_VALIDATOR, ADAPTER, JSON.stringify(config)], {
    env: {
      ...baseEnv,
      HELIX_SIGNAL_ARTIFACT_OVERRIDE: '1',
      HELIX_SIGNAL_ARTIFACT_HASH: override.artifactHash,
    },
  });
  assert.deepEqual(JSON.parse(fromOverride.stdout), [override.signals[0].signalId]);

  await assert.rejects(
    execFileAsync('python3', ['-c', harness, VALIDATOR, BATCH_VALIDATOR, ADAPTER, JSON.stringify({
      ...config,
      helix_signal_artifact_path: overrideFile,
    })], { env: baseEnv }),
    /configured signal artifact hash .* does not match/,
  );
});

test('adapter reloads an appended forward batch and maps the immutable ENTER/EXIT chain', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-adapter-forward-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const deploymentFile = join(home, 'deployment.json');
  const batchesDir = join(home, 'batches');
  const statusFile = join(home, 'status.json');
  const stagedExit = join(home, 'staged-exit.json');
  await mkdir(batchesDir);
  const { deployment, batches } = forwardBatchFixture();
  await writeFile(deploymentFile, JSON.stringify(deployment));
  await writeFile(statusFile, JSON.stringify({
    schemaVersion: 'helix.forward-worker-status/v1',
    deploymentHash: deployment.deploymentHash,
    state: 'ready',
    pid: process.pid,
    updatedAt: Date.now(),
    lastDecisionTime: batches[0].signal.decisionTime,
    lastMarketSnapshotId: batches[0].identity.marketDataSnapshotId,
    lastBatchHash: batches[0].batchHash,
    batches: 1,
    error: null,
  }));
  const enterName = `${String(batches[0].batchSequence).padStart(12, '0')}-${batches[0].batchHash.replace(':', '-')}.json`;
  const exitName = `${String(batches[1].batchSequence).padStart(12, '0')}-${batches[1].batchHash.replace(':', '-')}.json`;
  await writeFile(join(batchesDir, enterName), JSON.stringify(batches[0]));
  await writeFile(stagedExit, JSON.stringify(batches[1]));

  const harness = String.raw`
import importlib.util
import json
from pathlib import Path
import sys
import types

pandas = types.ModuleType('pandas')
pandas.DataFrame = type('DataFrame', (), {})
sys.modules['pandas'] = pandas
freqtrade = types.ModuleType('freqtrade')
freqtrade_strategy = types.ModuleType('freqtrade.strategy')
freqtrade_strategy.IStrategy = type('IStrategy', (), {})
freqtrade.strategy = freqtrade_strategy
sys.modules['freqtrade'] = freqtrade
sys.modules['freqtrade.strategy'] = freqtrade_strategy

validator_spec = importlib.util.spec_from_file_location('helix_signal_artifact', sys.argv[1])
validator = importlib.util.module_from_spec(validator_spec)
sys.modules['helix_signal_artifact'] = validator
validator_spec.loader.exec_module(validator)
batch_spec = importlib.util.spec_from_file_location('helix_signal_batch', sys.argv[2])
batch = importlib.util.module_from_spec(batch_spec)
sys.modules['helix_signal_batch'] = batch
batch_spec.loader.exec_module(batch)
adapter_spec = importlib.util.spec_from_file_location('HelixSignalStrategy', sys.argv[3])
adapter = importlib.util.module_from_spec(adapter_spec)
adapter_spec.loader.exec_module(adapter)

strategy = adapter.HelixSignalStrategy()
strategy.config = json.loads(sys.argv[4])
strategy.timeframe = '1m'
first = strategy._signal_index('BTC/USDT:USDT')
Path(sys.argv[6]).write_text(Path(sys.argv[5]).read_text())
second = strategy._signal_index('BTC/USDT:USDT')
healthy_entry = strategy.confirm_trade_entry(
    'BTC/USDT:USDT', None, None, None, None, None, 'enter-forward-1', None
)
status = json.loads(Path(sys.argv[7]).read_text())
status['updatedAt'] = 0
Path(sys.argv[7]).write_text(json.dumps(status))
stale_entry = strategy.confirm_trade_entry(None, None, None, None, None, None, None, None)
stale_exit = strategy.custom_exit(None, None, None, None, None)
print(json.dumps({
    'first_enter': sorted(first[('ENTER', 'LONG')].values()),
    'first_exit': sorted(first[('EXIT', 'LONG')].values()),
    'second_exit': sorted(second[('EXIT', 'LONG')].values()),
    'healthy_entry': healthy_entry,
    'stale_entry': stale_entry,
    'stale_exit': stale_exit,
}))
`;
  const config = {
    helix_signal_forward_deployment_path: deploymentFile,
    helix_signal_forward_deployment_hash: deployment.deploymentHash,
    helix_signal_batch_path: batchesDir,
    helix_signal_forward_status_path: statusFile,
  };
  const { stdout } = await execFileAsync('python3', [
    '-c', harness, VALIDATOR, BATCH_VALIDATOR, ADAPTER, JSON.stringify(config), stagedExit,
    join(batchesDir, exitName), statusFile,
  ]);
  assert.deepEqual(JSON.parse(stdout), {
    first_enter: ['enter-forward-1'],
    first_exit: [],
    second_exit: ['exit-forward-1'],
    healthy_entry: true,
    stale_entry: false,
    stale_exit: 'helix_forward_unavailable',
  });
});

test('adapter sizes both forward and historical ENTERs from exact risk intent', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-adapter-risk-sizing-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const deploymentFile = join(home, 'deployment.json');
  const batchesDir = join(home, 'batches');
  await mkdir(batchesDir);
  const { deployment, batches } = forwardBatchFixture();
  await writeFile(deploymentFile, JSON.stringify(deployment));
  const batchName = `${String(batches[0].batchSequence).padStart(12, '0')}-${batches[0].batchHash.replace(':', '-')}.json`;
  await writeFile(join(batchesDir, batchName), JSON.stringify(batches[0]));

  const artifact = fixture();
  const artifactFile = join(home, 'artifact.json');
  await writeFile(artifactFile, JSON.stringify(artifact));
  const riskPayload = {
    schemaVersion: 'helix.historical-risk-trace/v1',
    signalArtifactHash: artifact.artifactHash,
    entries: [{
      entrySignalId: artifact.signals[0].signalId,
      family: 'scalp',
      object: artifact.signals[0].object,
      side: artifact.signals[0].side,
      entryPrice: { source: 'DECISION_CANDLE_CLOSE', price: 100 },
      initialStop: 95,
      initialTarget: 110,
      riskDistance: 5,
      riskR: 0.25,
      scalp: {
        eventType: 'LIQUIDITY_SWEEP',
        grade: 'A',
        regime: { id: 'regime-risk-test', type: 'RANGING' },
      },
    }],
  };
  const riskTrace = { ...riskPayload, traceHash: historicalRiskTraceHash(riskPayload) };
  const riskFile = join(home, 'risk-trace.json');
  const riskContent = `${JSON.stringify(riskTrace, null, 2)}\n`;
  await writeFile(riskFile, riskContent);
  const riskFileHash = `sha256:${createHash('sha256').update(riskContent).digest('hex')}`;

  const harness = String.raw`
import importlib.util
import json
import os
import sys
import types

pandas = types.ModuleType('pandas')
pandas.DataFrame = type('DataFrame', (), {})
sys.modules['pandas'] = pandas
freqtrade = types.ModuleType('freqtrade')
freqtrade_strategy = types.ModuleType('freqtrade.strategy')
freqtrade_strategy.IStrategy = type('IStrategy', (), {})
freqtrade.strategy = freqtrade_strategy
sys.modules['freqtrade'] = freqtrade
sys.modules['freqtrade.strategy'] = freqtrade_strategy

artifact_spec = importlib.util.spec_from_file_location('helix_signal_artifact', sys.argv[1])
artifact = importlib.util.module_from_spec(artifact_spec)
sys.modules['helix_signal_artifact'] = artifact
artifact_spec.loader.exec_module(artifact)
batch_spec = importlib.util.spec_from_file_location('helix_signal_batch', sys.argv[2])
batch = importlib.util.module_from_spec(batch_spec)
sys.modules['helix_signal_batch'] = batch
batch_spec.loader.exec_module(batch)
adapter_spec = importlib.util.spec_from_file_location('HelixSignalStrategy', sys.argv[3])
adapter = importlib.util.module_from_spec(adapter_spec)
adapter_spec.loader.exec_module(adapter)

class Wallets:
    def get_total(self, currency):
        assert currency == 'USDT'
        return 10000

def stake(strategy, tag, maximum=1000, leverage=1):
    strategy.wallets = Wallets()
    return strategy.custom_stake_amount(
        'BTC/USDT:USDT', None, 100, None, 10, maximum, leverage, tag, 'long'
    )

forward = adapter.HelixSignalStrategy()
forward.timeframe = '1m'
forward.config = {
    'stake_currency': 'USDT',
    'fee': 0.001,
    'helix_signal_forward_deployment_path': sys.argv[4],
    'helix_signal_forward_deployment_hash': sys.argv[5],
    'helix_signal_batch_path': sys.argv[6],
    'helix_signal_forward_status_path': sys.argv[7],
}

historical = adapter.HelixSignalStrategy()
historical.timeframe = '1m'
historical.config = {'stake_currency': 'USDT', 'fee': 0.001}

historical_zero_fee = adapter.HelixSignalStrategy()
historical_zero_fee.timeframe = '1m'
historical_zero_fee.config = {'stake_currency': 'USDT', 'fee': 0}

historical_missing_fee = adapter.HelixSignalStrategy()
historical_missing_fee.timeframe = '1m'
historical_missing_fee.config = {'stake_currency': 'USDT'}

os.environ['HELIX_SIGNAL_ARTIFACT_OVERRIDE'] = ''
forward_result = stake(forward, 'enter-forward-1')
forward_max_reject = stake(forward, 'enter-forward-1', 480)
forward_leverage_reject = stake(forward, 'enter-forward-1', leverage=2)
forward_missing_reject = stake(forward, 'missing')
os.environ['HELIX_SIGNAL_ARTIFACT_OVERRIDE'] = '1'
historical_result = stake(historical, 'btc-scalp-enter-001')
historical_zero_fee_result = stake(historical_zero_fee, 'btc-scalp-enter-001')
historical_missing_fee_result = stake(historical_missing_fee, 'btc-scalp-enter-001')
os.environ['HELIX_SIGNAL_RISK_TRACE_FILE_HASH'] = 'sha256:' + ('0' * 64)
print(json.dumps({
    'forward': forward_result,
    'forward_max_reject': forward_max_reject,
    'forward_leverage_reject': forward_leverage_reject,
    'forward_missing_reject': forward_missing_reject,
    'historical': historical_result,
    'historical_zero_fee': historical_zero_fee_result,
    'historical_missing_fee': historical_missing_fee_result,
    'historical_wrong_file_pin': stake(historical, 'btc-scalp-enter-001'),
}))
`;
  const statusFile = join(home, 'unused-status.json');
  const { stdout } = await execFileAsync('python3', [
    '-c', harness, VALIDATOR, BATCH_VALIDATOR, ADAPTER, deploymentFile,
    deployment.deploymentHash, batchesDir, statusFile,
  ], {
    env: {
      ...process.env,
      HELIX_SIGNAL_ARTIFACT_OVERRIDE: '1',
      HELIX_SIGNAL_ARTIFACT_PATH: artifactFile,
      HELIX_SIGNAL_ARTIFACT_HASH: artifact.artifactHash,
      HELIX_SIGNAL_RISK_TRACE_PATH: riskFile,
      HELIX_SIGNAL_RISK_TRACE_HASH: riskTrace.traceHash,
      HELIX_SIGNAL_RISK_TRACE_FILE_HASH: riskFileHash,
      HELIX_SIGNAL_RISK_UNIT_RATIO: '0.01',
    },
  });
  assert.deepEqual(JSON.parse(stdout), {
    forward: 481.2319538017324,
    forward_max_reject: 0,
    forward_leverage_reject: 240.6159769008662,
    forward_missing_reject: 0,
    historical: 481.2319538017324,
    historical_zero_fee: 500,
    historical_missing_fee: 0,
    historical_wrong_file_pin: 0,
  });
});

test('Docker backtests pass the exact artifact override and hash into the one-shot container', async () => {
  const compose = await readFile(resolve(SKILL_DIR, '..', '..', 'docker', 'freqtrade', 'compose.yaml'), 'utf8');
  assert.match(compose, /HELIX_SIGNAL_ARTIFACT_PATH: \$\{HELIX_SIGNAL_ARTIFACT_PATH:-\}/);
  assert.match(compose, /HELIX_SIGNAL_ARTIFACT_HASH: \$\{HELIX_SIGNAL_ARTIFACT_HASH:-\}/);
  assert.match(compose, /HELIX_SIGNAL_ARTIFACT_OVERRIDE: \$\{HELIX_SIGNAL_ARTIFACT_OVERRIDE:-\}/);
  assert.match(compose, /HELIX_SIGNAL_RISK_TRACE_PATH: \$\{HELIX_SIGNAL_RISK_TRACE_PATH:-\}/);
  assert.match(compose, /HELIX_SIGNAL_RISK_UNIT_RATIO: \$\{HELIX_SIGNAL_RISK_UNIT_RATIO:-\}/);
});

test('Freqtrade result reconciles every artifact entry and exit by identity, time, pair, and side', () => {
  const artifact = fixture();
  const summary = {
    total_trades: 1,
    trades: [{
      pair: artifact.symbol,
      is_short: false,
      is_open: false,
      open_timestamp: artifact.signals[0].decisionTime,
      close_timestamp: artifact.signals[1].decisionTime,
      enter_tag: artifact.signals[0].signalId,
      exit_reason: artifact.signals[1].signalId,
    }],
  };
  assert.deepEqual(reconcileSignalBacktest(summary, artifact), {
    trades: 1,
    entries: 1,
    exits: 1,
    matchedSignals: 2,
  });

  const cases = [
    ['declared count mismatch', { ...summary, total_trades: 2 }, /total_trades does not match trades array/],
    ['missing trade', { total_trades: 0, trades: [] }, /trade count does not match signal artifact/],
    ['open trade', { ...summary, trades: [{ ...summary.trades[0], is_open: true }] }, /is_open must be false/],
    ['wrong pair', { ...summary, trades: [{ ...summary.trades[0], pair: 'ETH\/USDT:USDT' }] }, /pair does not match signal artifact symbol/],
    ['wrong side', { ...summary, trades: [{ ...summary.trades[0], is_short: true }] }, /is_short does not match LONG/],
    ['wrong entry time', { ...summary, trades: [{ ...summary.trades[0], open_timestamp: artifact.signals[0].sourceCandleOpenTime }] }, /open_timestamp does not match ENTER decisionTime/],
    ['wrong exit time', { ...summary, trades: [{ ...summary.trades[0], close_timestamp: artifact.signals[1].sourceCandleOpenTime }] }, /close_timestamp does not match EXIT decisionTime/],
    ['unknown entry', { ...summary, trades: [{ ...summary.trades[0], enter_tag: 'unknown-entry' }] }, /missing ENTER signal/],
    ['non-artifact exit', { ...summary, trades: [{ ...summary.trades[0], exit_reason: 'force_exit' }] }, /exit_reason does not match EXIT signal/],
  ];
  for (const [name, candidate, message] of cases) {
    assert.throws(() => reconcileSignalBacktest(candidate, artifact), message, name);
  }

  const shortArtifact = structuredClone(artifact);
  shortArtifact.signals = shortArtifact.signals.map((signal) => ({ ...signal, side: 'SHORT' }));
  const shortSummary = {
    ...summary,
    trades: [{ ...summary.trades[0], is_short: true }],
  };
  assert.equal(reconcileSignalBacktest(shortSummary, shortArtifact).matchedSignals, 2);

  const openArtifact = structuredClone(artifact);
  openArtifact.signals = [openArtifact.signals[0]];
  assert.throws(
    () => reconcileSignalBacktest({ total_trades: 0, trades: [] }, openArtifact),
    /has no EXIT/,
  );
});

test('backtest rejects timeframe and pair overrides that contradict the artifact', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-signal-backtest-gate-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const artifactFile = join(home, 'artifact.json');
  await writeFile(artifactFile, JSON.stringify(fixture()));

  await assert.rejects(
    runDeployAction(home, 'backtest', { signal_artifact: artifactFile, timeframe: '5m' }),
    (error) => {
      assert.match(error.stderr, /does not match signal artifact baseTimeframe 1m/);
      return true;
    },
  );
  await assert.rejects(
    runDeployAction(home, 'backtest', { signal_artifact: artifactFile, pairs: ['ETH/USDT:USDT'] }),
    (error) => {
      assert.match(error.stderr, /pair must be exactly BTC\/USDT:USDT/);
      return true;
    },
  );
});

test('signal backtest requires an explicit fee for its execution identity', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-signal-backtest-fee-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dataset = marketDatasetFixture();
  const artifactFile = join(home, 'artifact.json');
  const datasetFile = join(home, 'dataset.json');
  await writeFile(artifactFile, JSON.stringify(fixture(dataset.datasetHash)));
  await writeFile(datasetFile, JSON.stringify(dataset));

  await assert.rejects(
    runDeployAction(home, 'backtest', {
      signal_artifact: artifactFile,
      market_dataset: datasetFile,
    }),
    (error) => {
      assert.match(error.stderr, /requires an explicit non-negative fee/);
      return true;
    },
  );
});

test('signal backtest requires the exact market dataset identity', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-signal-dataset-gate-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const artifactFile = join(home, 'artifact.json');
  const datasetFile = join(home, 'dataset.json');
  const artifact = fixture();
  await writeFile(artifactFile, JSON.stringify(artifact));
  await writeFile(datasetFile, JSON.stringify(marketDatasetFixture()));
  const riskPayload = {
    schemaVersion: 'helix.historical-risk-trace/v1',
    signalArtifactHash: artifact.artifactHash,
    entries: [{
      entrySignalId: artifact.signals[0].signalId,
      family: 'scalp',
      object: artifact.signals[0].object,
      side: artifact.signals[0].side,
      entryPrice: { source: 'DECISION_CANDLE_CLOSE', price: 100 },
      initialStop: 95,
      initialTarget: 110,
      riskDistance: 5,
      riskR: 0.25,
      scalp: {
        eventType: 'LIQUIDITY_SWEEP', grade: 'A',
        regime: { id: 'dataset-gate', type: 'RANGING' },
      },
    }],
  };
  const riskTrace = { ...riskPayload, traceHash: historicalRiskTraceHash(riskPayload) };
  const riskFile = join(home, 'risk-trace.json');
  await writeFile(riskFile, JSON.stringify(riskTrace));

  await assert.rejects(
    runDeployAction(home, 'backtest', { signal_artifact: artifactFile }),
    (error) => {
      assert.match(error.stderr, /requires market_dataset matching the signal artifact identity/);
      return true;
    },
  );
  await assert.rejects(
    runDeployAction(home, 'backtest', {
      signal_artifact: artifactFile,
      market_dataset: datasetFile,
      historical_risk_trace: riskFile,
      risk_unit_ratio: 0.01,
      fee: 0.001,
    }),
    (error) => {
      assert.match(error.stderr, /market_dataset hash does not match signal artifact/);
      return true;
    },
  );
});

test('backtest resolves an immutable signal artifact without activating daemon input', async () => {
  const source = await readFile(DEPLOY, 'utf8');
  const backtest = source.slice(
    source.indexOf('backtest: async (params = {}) =>'),
    source.indexOf('// ── download_data'),
  );
  assert.match(backtest, /resolveSignalArtifact/);
  assert.match(backtest, /HELIX_SIGNAL_ARTIFACT_OVERRIDE/);
  assert.match(backtest, /HELIX_SIGNAL_ARTIFACT_HASH/);
  assert.match(backtest, /backtestStrategyDir = signalArtifact \? SIGNAL_ADAPTER_ASSET_DIR : STRAT_DIR/);
  assert.doesNotMatch(backtest, /installSignalAdapter\(\)/);
  assert.doesNotMatch(backtest, /helix_signal_artifact_path\s*=/);

  const deploy = source.slice(
    source.indexOf('deploy: async (params = {}) =>'),
    source.indexOf('// ── update'),
  );
  assert.match(deploy, /helix_signal_artifact_path/);
});

test('signal backtest requires a pinned historical risk trace', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-signal-risk-trace-gate-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dataset = marketDatasetFixture();
  const artifactFile = join(home, 'artifact.json');
  const datasetFile = join(home, 'dataset.json');
  await writeFile(artifactFile, JSON.stringify(fixture(dataset.datasetHash)));
  await writeFile(datasetFile, JSON.stringify(dataset));

  await assert.rejects(
    runDeployAction(home, 'backtest', {
      signal_artifact: artifactFile,
      market_dataset: datasetFile,
      risk_unit_ratio: 0.01,
      fee: 0.001,
    }),
    (error) => {
      assert.match(error.stderr, /requires historical_risk_trace/);
      return true;
    },
  );
});

test('deploy requires matching pinned backtest identity and a deployable lifecycle', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-signal-deploy-gate-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const artifact = fixture();
  const artifactFile = join(home, 'artifact.json');
  const resultsDir = join(home, '.freqtrade', 'user_data', 'backtest_results');
  await mkdir(resultsDir, { recursive: true });
  await writeFile(artifactFile, JSON.stringify(artifact));
  const backtestFiles = await writeSignalBacktestFiles(resultsDir);
  const futuresCostDataset = futuresCostDatasetFixture({
    coveredFrom: artifact.marketData.firstCandleOpenTime,
    coveredThrough: artifact.marketData.lastCandleCloseTime,
  });
  const futuresCostIdentity = futuresCostDatasetIdentity(futuresCostDataset);
  const futuresCostContent = `${JSON.stringify(futuresCostDataset, null, 2)}\n`;
  const futuresCostDatasetFileHash = `sha256:${createHash('sha256').update(futuresCostContent).digest('hex')}`;
  const futuresCostDirectory = join(home, '.freqtrade', 'user_data', 'helix', 'futures-cost-data');
  await mkdir(futuresCostDirectory, { recursive: true });
  await writeFile(
    join(futuresCostDirectory, `${futuresCostDataset.costDatasetHash.replace(':', '-')}.json`),
    futuresCostContent,
  );

  const evidence = (identity, source = artifact) => ({
    version: 3,
    records: [{
      id: 'signal-evidence',
      strategy: 'HelixSignalStrategy',
      strategyHash: null,
      timeframe: '1m',
      timerange: '20260701-20260702',
      pairs: ['BTC/USDT:USDT'],
      ...backtestFiles,
      metrics: { trades: 1, profitPct: 0.01 },
      signalArtifact: {
        artifactHash: source.artifactHash,
        schemaVersion: source.schemaVersion,
        strategyLifecycle: source.strategyLifecycle,
        identity,
        marketDataSnapshotId: source.identity.marketDataSnapshotId,
        symbol: source.symbol,
        baseTimeframe: source.baseTimeframe,
        marketData: source.marketData,
        signalCount: source.signals.length,
      },
      marketDataset: { datasetHash: source.identity.marketDataSnapshotId },
      executionEnvironment: {
        freqtradeVersion: 'freqtrade test',
        configHash: `sha256:${'e'.repeat(64)}`,
        artifactFileHash: `sha256:${'f'.repeat(64)}`,
        riskTraceHash: `sha256:${'1'.repeat(64)}`,
        riskTraceFileHash: `sha256:${'2'.repeat(64)}`,
        riskUnitRatio: 0.01,
        fee: null,
        dataFormatOhlcv: 'json',
        executionProfile: {
          schemaVersion: 'helix.freqtrade-execution-profile/v1',
          strategy: 'HelixSignalStrategy',
          timeframe: source.baseTimeframe,
          pairs: [source.symbol],
          exchange: 'binance',
          tradingMode: 'futures',
          marginMode: 'isolated',
          maxOpenTrades: 1,
          fee: null,
        },
        futuresCostDataset: futuresCostIdentity,
        futuresCostDatasetFileHash,
      },
      createdAt: '2026-07-15T00:00:00.000Z',
    }],
  });
  const currentIdentity = pinnedIdentity(artifact);
  const evidenceFile = join(resultsDir, '.helix-evidence.json');
  const matching = evidence(currentIdentity);
  matching.records[0].strategyHash = await adapterFingerprint();
  await writeFile(evidenceFile, JSON.stringify(matching));

  await assert.rejects(
    runDeployAction(home, 'deploy', { signal_artifact: artifactFile, dry_run: true }),
    (error) => {
      assert.match(error.stderr, /lifecycle proposal cannot be deployed to dry-run/);
      return true;
    },
  );

  const tamperedMetadata = structuredClone(matching);
  tamperedMetadata.records[0].signalArtifact.strategyLifecycle = 'production';
  await writeFile(evidenceFile, JSON.stringify(tamperedMetadata));
  const { stdout: tamperedOutput } = await runDeployAction(home, 'backtest_results', {});
  const tamperedResult = JSON.parse(tamperedOutput);
  assert.equal(tamperedResult.evidence[0].current, false);
  assert.equal(tamperedResult.evidence[0].signalArtifact, null);
  await writeFile(evidenceFile, JSON.stringify(matching));

  const changedArtifact = structuredClone(artifact);
  changedArtifact.signals[0].reasonCodes = ['ALTERNATE_EXECUTION_REASON'];
  const { artifactHash: _oldHash, ...changedPayload } = changedArtifact;
  changedArtifact.artifactHash = signalArtifactHash(changedPayload);
  await writeFile(artifactFile, JSON.stringify(changedArtifact));
  await assert.rejects(
    runDeployAction(home, 'deploy', { signal_artifact: artifactFile, dry_run: true }),
    (error) => {
      assert.match(error.stderr, /exact signal artifact have not been backtested/);
      return true;
    },
  );

  const mismatched = evidence({ ...currentIdentity, engineCommit: 'd'.repeat(40) });
  mismatched.records[0].strategyHash = await adapterFingerprint();
  await writeFile(evidenceFile, JSON.stringify(mismatched));
  await writeFile(artifactFile, JSON.stringify(artifact));
  await assert.rejects(
    runDeployAction(home, 'deploy', { signal_artifact: artifactFile, dry_run: true }),
    (error) => {
      assert.match(error.stderr, /exact signal artifact have not been backtested/);
      return true;
    },
  );

  const { artifactHash: _proposalHash, ...proposalPayload } = artifact;
  const shadowPayload = { ...proposalPayload, strategyLifecycle: 'shadow' };
  const shadowArtifact = { ...shadowPayload, artifactHash: signalArtifactHash(shadowPayload) };
  const forcedExitFiles = await writeSignalBacktestFiles(resultsDir, { exitReason: 'force_exit' });
  const forcedExitEvidence = evidence(pinnedIdentity(shadowArtifact), shadowArtifact);
  Object.assign(forcedExitEvidence.records[0], forcedExitFiles, {
    strategyHash: await adapterFingerprint(),
  });
  await writeFile(artifactFile, JSON.stringify(shadowArtifact));
  await writeFile(evidenceFile, JSON.stringify(forcedExitEvidence));
  await assert.rejects(
    runDeployAction(home, 'deploy', { signal_artifact: artifactFile, dry_run: true }),
    (error) => {
      assert.match(error.stderr, /exit_reason does not match EXIT signal/);
      return true;
    },
  );
});
