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

const execFileAsync = promisify(execFile);
const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VALIDATOR = resolve(SKILL_DIR, 'assets', 'helix_signal_artifact.py');
const ADAPTER = resolve(SKILL_DIR, 'assets', 'HelixSignalStrategy.py');
const DEPLOY = resolve(SKILL_DIR, 'scripts', 'ft-deploy.mjs');

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
  for (const name of ['HelixSignalStrategy.py', 'helix_signal_artifact.py']) {
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
  for (const column of ['enter_long', 'enter_short', 'exit_long', 'exit_short']) {
    assert.match(source, new RegExp(column));
  }
  assert.doesNotMatch(source, /\b(?:rsi|macd|ema|atr|liquidity_sweep|breakout_failure|momentum_burst)\b/i);
});

test('Freqtrade adapter preserves LONG tags when the second side has no signal', async () => {
  const harness = `
import importlib.util
import json
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
artifact.load_artifacts = lambda _path: []
artifact.path_fingerprint = lambda _path: None
artifact.signals_for = lambda _artifacts, _pair, _timeframe: {}
sys.modules['helix_signal_artifact'] = artifact

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
frame = DataFrame({'date': [first]})
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

test('signal backtest requires the exact market dataset identity', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-signal-dataset-gate-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const artifactFile = join(home, 'artifact.json');
  const datasetFile = join(home, 'dataset.json');
  await writeFile(artifactFile, JSON.stringify(fixture()));
  await writeFile(datasetFile, JSON.stringify(marketDatasetFixture()));

  await assert.rejects(
    runDeployAction(home, 'backtest', { signal_artifact: artifactFile }),
    (error) => {
      assert.match(error.stderr, /requires market_dataset matching the signal artifact identity/);
      return true;
    },
  );
  await assert.rejects(
    runDeployAction(home, 'backtest', { signal_artifact: artifactFile, market_dataset: datasetFile }),
    (error) => {
      assert.match(error.stderr, /market_dataset hash does not match signal artifact/);
      return true;
    },
  );
});

test('backtest archives a signal artifact without activating daemon input', async () => {
  const source = await readFile(DEPLOY, 'utf8');
  const backtest = source.slice(
    source.indexOf('backtest: async (params = {}) =>'),
    source.indexOf('// ── download_data'),
  );
  assert.match(backtest, /archiveSignalArtifact/);
  assert.doesNotMatch(backtest, /activateSignalArtifact/);

  const deploy = source.slice(
    source.indexOf('deploy: async (params = {}) =>'),
    source.indexOf('// ── update'),
  );
  assert.match(deploy, /activateSignalArtifact/);
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

  const evidence = (identity, source = artifact) => ({
    version: 2,
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
        marketDataSnapshotId: source.identity.marketDataSnapshotId,
        identity,
      },
      marketDataset: { datasetHash: source.identity.marketDataSnapshotId },
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
