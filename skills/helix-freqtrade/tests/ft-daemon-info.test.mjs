import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sha256(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

async function writeBacktestFiles(resultsDir, strategy, summary, base = 'backtest-result-test') {
  const resultFile = `${base}.json`;
  const resultMetaFile = `${base}.meta.json`;
  const resultContent = JSON.stringify({ strategy: { [strategy]: summary } });
  const resultMetaContent = JSON.stringify({ [strategy]: { run_id: 'test-run', timeframe: '5m' } });
  await writeFile(join(resultsDir, resultFile), resultContent);
  await writeFile(join(resultsDir, resultMetaFile), resultMetaContent);
  return {
    evidence: {
      resultFile,
      resultMetaFile,
      resultHash: sha256(resultContent),
      resultMetaHash: sha256(resultMetaContent),
    },
    resultContent,
    resultMetaContent,
  };
}

async function listen(handler) {
  const server = createServer(handler);
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

async function runDaemonInfo(baseUrl) {
  return execFileAsync(process.execPath, ['scripts/ft.mjs', 'daemon_info'], {
    cwd: SKILL_DIR,
    env: {
      ...process.env,
      FREQTRADE_URL: baseUrl,
      FREQTRADE_USERNAME: 'freqtrade',
      FREQTRADE_PASSWORD: 'test-only',
    },
  });
}

async function runFtAction(baseUrl, action, params) {
  const args = ['scripts/ft.mjs', action];
  if (params) args.push(JSON.stringify(params));
  return execFileAsync(process.execPath, args, {
    cwd: SKILL_DIR,
    env: {
      ...process.env,
      FREQTRADE_URL: baseUrl,
      FREQTRADE_USERNAME: 'freqtrade',
      FREQTRADE_PASSWORD: 'test-only',
    },
  });
}

test('daemon_info reports online after show_config succeeds', async (t) => {
  const mock = await listen((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/v1/show_config') {
      response.end(JSON.stringify({ strategy: 'TestStrategy', dry_run: true, whitelist: ['BTC/USDT:USDT'] }));
      return;
    }
    if (request.url === '/api/v1/status') {
      response.end('[]');
      return;
    }
    if (request.url === '/api/v1/version') {
      response.end(JSON.stringify({ version: 'test' }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  t.after(mock.close);

  const { stdout } = await runDaemonInfo(mock.url);
  const result = JSON.parse(stdout);
  assert.equal(result.online, true);
  assert.equal(result.strategy, 'TestStrategy');
  assert.equal(result.dry_run, true);
});

test('daemon_info fails when show_config is unavailable', async (t) => {
  const mock = await listen((_request, response) => {
    response.statusCode = 503;
    response.end('offline');
  });
  t.after(mock.close);

  await assert.rejects(runDaemonInfo(mock.url), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Freqtrade 503/);
    return true;
  });
});

test('backtest evidence becomes stale after strategy code changes', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-freqtrade-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const userData = join(home, '.freqtrade', 'user_data');
  const strategyDir = join(userData, 'strategies');
  const resultsDir = join(userData, 'backtest_results');
  const strategyFile = join(strategyDir, 'TestStrategy.py');
  const initialCode = 'class TestStrategy:\n    pass\n';
  const strategyHash = createHash('sha256').update(initialCode).digest('hex');

  await mkdir(strategyDir, { recursive: true });
  await mkdir(resultsDir, { recursive: true });
  await writeFile(strategyFile, initialCode);
  const backtestFiles = await writeBacktestFiles(resultsDir, 'TestStrategy', {
    total_trades: 5,
    profit_total: 0.01,
    profit_total_abs: 10,
  }, 'backtest-result-staleness');
  await writeFile(join(resultsDir, '.helix-evidence.json'), JSON.stringify({
    version: 2,
    records: [{
      id: 'test-evidence',
      strategy: 'TestStrategy',
      strategyHash,
      timeframe: '15m',
      timerange: '20250101-20251231',
      pairs: ['BTC/USDT:USDT'],
      ...backtestFiles.evidence,
      createdAt: '2026-01-01T00:00:00.000Z',
    }],
  }));

  const runResults = async () => {
    const { stdout } = await execFileAsync(process.execPath, ['scripts/ft-deploy.mjs', 'backtest_results'], {
      cwd: SKILL_DIR,
      env: { ...process.env, HOME: home },
    });
    return JSON.parse(stdout);
  };

  assert.equal((await runResults()).evidence[0].current, true);
  await writeFile(strategyFile, `${initialCode}# changed\n`);
  assert.equal((await runResults()).evidence[0].current, false);

  await assert.rejects(
    execFileAsync(process.execPath, ['scripts/ft-deploy.mjs', 'deploy', '{"strategy":"TestStrategy","dry_run":true}'], {
      cwd: SKILL_DIR,
      env: { ...process.env, HOME: home },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /has not been backtested/);
      return true;
    },
  );
});

test('deploy rejects empty or non-profitable backtest evidence', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-quality-gate-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const userData = join(home, '.freqtrade', 'user_data');
  const strategyDir = join(userData, 'strategies');
  const resultsDir = join(userData, 'backtest_results');
  const code = 'class TestStrategy:\n    pass\n';

  await mkdir(strategyDir, { recursive: true });
  await mkdir(resultsDir, { recursive: true });
  await writeFile(join(strategyDir, 'TestStrategy.py'), code);

  const deploy = () => execFileAsync(process.execPath, [
    'scripts/ft-deploy.mjs',
    'deploy',
    '{"strategy":"TestStrategy","dry_run":true}',
  ], {
    cwd: SKILL_DIR,
    env: { ...process.env, HOME: home, HELIX_FREQTRADE_RUNTIME: '' },
  });
  const writeEvidence = async (actualMetrics, recordedMetrics = actualMetrics) => {
    const files = await writeBacktestFiles(resultsDir, 'TestStrategy', {
      total_trades: actualMetrics.trades,
      profit_total: actualMetrics.profitPct,
      profit_total_abs: actualMetrics.profitAbs ?? actualMetrics.profitPct * 1000,
    });
    await writeFile(join(resultsDir, '.helix-evidence.json'), JSON.stringify({
      version: 2,
      records: [{
        id: 'quality-gate-evidence',
        strategy: 'TestStrategy',
        strategyHash: createHash('sha256').update(code).digest('hex'),
        timeframe: '5m',
        timerange: '20260101-20260201',
        pairs: ['BTC/USDT:USDT'],
        ...files.evidence,
        metrics: recordedMetrics,
        createdAt: '2026-01-01T00:00:00.000Z',
      }],
    }));
  };

  await writeEvidence({ trades: 0, profitPct: 0 });
  await assert.rejects(deploy(), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /has 0 trades/);
    return true;
  });

  await writeEvidence({ trades: 4, profitPct: -0.0084 });
  await assert.rejects(deploy(), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /is not profitable \(-0\.84%\)/);
    return true;
  });

  await writeEvidence(
    { trades: 3, profitPct: -0.012 },
    { trades: 999, profitPct: 99 },
  );
  await assert.rejects(deploy(), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /is not profitable \(-1\.20%\)/);
    return true;
  });
});

test('deploy rejects missing or tampered backtest result files', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-evidence-integrity-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const userData = join(home, '.freqtrade', 'user_data');
  const strategyDir = join(userData, 'strategies');
  const resultsDir = join(userData, 'backtest_results');
  const code = 'class TestStrategy:\n    pass\n';
  await mkdir(strategyDir, { recursive: true });
  await mkdir(resultsDir, { recursive: true });
  await writeFile(join(strategyDir, 'TestStrategy.py'), code);
  const files = await writeBacktestFiles(resultsDir, 'TestStrategy', {
    total_trades: 4,
    profit_total: 0.02,
    profit_total_abs: 20,
  }, 'backtest-result-integrity');
  const evidenceFile = join(resultsDir, '.helix-evidence.json');
  const writeEvidence = (overrides = {}) => writeFile(evidenceFile, JSON.stringify({
    version: 2,
    records: [{
      id: 'integrity-evidence',
      strategy: 'TestStrategy',
      strategyHash: createHash('sha256').update(code).digest('hex'),
      timeframe: '5m',
      timerange: '20260101-20260201',
      pairs: ['BTC/USDT:USDT'],
      ...files.evidence,
      ...overrides,
      metrics: { trades: 4, profitPct: 0.02 },
      createdAt: '2026-01-01T00:00:00.000Z',
    }],
  }));
  const deploy = () => execFileAsync(process.execPath, [
    'scripts/ft-deploy.mjs',
    'deploy',
    '{"strategy":"TestStrategy","dry_run":true}',
  ], {
    cwd: SKILL_DIR,
    env: { ...process.env, HOME: home, HELIX_FREQTRADE_RUNTIME: '' },
  });
  const backtestResults = async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      'scripts/ft-deploy.mjs',
      'backtest_results',
    ], {
      cwd: SKILL_DIR,
      env: { ...process.env, HOME: home, HELIX_FREQTRADE_RUNTIME: '' },
    });
    return JSON.parse(stdout);
  };

  await writeEvidence({ resultFile: null });
  await assert.rejects(deploy(), (error) => {
    assert.match(error.stderr, /has no result file/);
    return true;
  });

  await writeEvidence();
  await rm(join(resultsDir, files.evidence.resultFile));
  await assert.rejects(deploy(), (error) => {
    assert.match(error.stderr, /result file is missing/);
    return true;
  });

  await writeFile(join(resultsDir, files.evidence.resultFile), `${files.resultContent}\n`);
  await assert.rejects(deploy(), (error) => {
    assert.match(error.stderr, /result hash mismatch/);
    return true;
  });
  assert.equal((await backtestResults()).evidence[0].current, false);

  await writeFile(join(resultsDir, files.evidence.resultFile), files.resultContent);
  await writeFile(join(resultsDir, files.evidence.resultMetaFile), `${files.resultMetaContent}\n`);
  await assert.rejects(deploy(), (error) => {
    assert.match(error.stderr, /result metadata hash mismatch/);
    return true;
  });
});

test('live deploy enforces every authorization and risk gate', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-live-gate-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const userData = join(home, '.freqtrade', 'user_data');
  const strategyDir = join(userData, 'strategies');
  const resultsDir = join(userData, 'backtest_results');
  const strategyFile = join(strategyDir, 'TestStrategy.py');
  const code = 'class TestStrategy:\n    pass\n';

  await mkdir(strategyDir, { recursive: true });
  await mkdir(resultsDir, { recursive: true });
  await writeFile(strategyFile, code);
  const backtestFiles = await writeBacktestFiles(resultsDir, 'TestStrategy', {
    total_trades: 20,
    profit_total: 0.015,
    profit_total_abs: 15,
  }, 'backtest-result-live-gate');
  await writeFile(join(resultsDir, '.helix-evidence.json'), JSON.stringify({
    version: 2,
    records: [{
      id: 'live-gate-evidence',
      strategy: 'TestStrategy',
      strategyHash: createHash('sha256').update(code).digest('hex'),
      timeframe: '5m',
      timerange: '20260101-20260201',
      pairs: ['BTC/USDT:USDT'],
      ...backtestFiles.evidence,
      metrics: { trades: 20, profitPct: 1.5 },
      createdAt: '2026-01-01T00:00:00.000Z',
    }],
  }));

  const deploy = (params, env = {}) => execFileAsync(process.execPath, [
    'scripts/ft-deploy.mjs',
    'deploy',
    JSON.stringify({ strategy: 'TestStrategy', dry_run: false, max_open_trades: 2, exchange: 'okx', ...params }),
  ], {
    cwd: SKILL_DIR,
    env: {
      ...process.env,
      HOME: home,
      HELIX_FREQTRADE_RUNTIME: '',
      HELIX_LIVE_TRADING_ENABLED: '',
      HELIX_LIVE_AUTHORIZED: '',
      OKX_API_KEY: '',
      OKX_API_SECRET: '',
      OKX_PASSWORD: '',
      ...env,
    },
  });

  await assert.rejects(
    deploy({}, { HELIX_LIVE_TRADING_ENABLED: 'false', HELIX_LIVE_AUTHORIZED: '1' }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Live trading is disabled/);
      return true;
    },
  );

  await assert.rejects(
    deploy({}, { HELIX_LIVE_TRADING_ENABLED: 'true' }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /fresh Dashboard live authorization session/);
      return true;
    },
  );

  await assert.rejects(
    deploy({}, { HELIX_LIVE_TRADING_ENABLED: 'true', HELIX_LIVE_AUTHORIZED: '1' }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /configured API credentials/);
      return true;
    },
  );

  await assert.rejects(
    deploy({}, {
      HELIX_LIVE_TRADING_ENABLED: 'true',
      HELIX_LIVE_AUTHORIZED: '1',
      OKX_API_KEY: 'test-key',
      OKX_API_SECRET: 'test-secret',
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /requires the API passphrase/);
      return true;
    },
  );

  await assert.rejects(
    deploy({ max_open_trades: 3 }, {
      HELIX_LIVE_TRADING_ENABLED: 'true',
      HELIX_LIVE_AUTHORIZED: '1',
      OKX_API_KEY: 'test-key',
      OKX_API_SECRET: 'test-secret',
      OKX_PASSWORD: 'test-passphrase',
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /max_open_trades between 1 and 2/);
      return true;
    },
  );

  await assert.rejects(
    deploy({ dry_run: true, max_open_trades: 3 }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /max_open_trades between 1 and 2/);
      return true;
    },
  );
});

test('emergency stop force-exits all trades before stopping the daemon', async (t) => {
  const calls = [];
  const mock = await listen(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && request.url === '/api/v1/status') {
      calls.push('status');
      response.end(JSON.stringify([{ trade_id: 1 }]));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/v1/forceexit') {
      let body = '';
      for await (const chunk of request) body += chunk;
      calls.push(`forceexit:${body}`);
      response.end(JSON.stringify({ result: 'Created exit orders for all open trades.' }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/v1/stop') {
      calls.push('stop');
      response.end(JSON.stringify({ status: 'stopping trader ...' }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  t.after(mock.close);

  const { stdout } = await runFtAction(mock.url, 'emergency_stop');
  const result = JSON.parse(stdout);
  assert.equal(result.success, true);
  assert.deepEqual(calls.map((call) => call.split(':')[0]), ['status', 'forceexit', 'stop']);
  assert.deepEqual(JSON.parse(calls[1].slice('forceexit:'.length)), { tradeid: 'all', ordertype: 'market' });
});
