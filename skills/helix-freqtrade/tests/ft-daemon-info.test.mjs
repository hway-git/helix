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
  await writeFile(join(resultsDir, '.helix-evidence.json'), JSON.stringify({
    version: 1,
    records: [{
      id: 'test-evidence',
      strategy: 'TestStrategy',
      strategyHash,
      timeframe: '15m',
      timerange: '20250101-20251231',
      pairs: ['BTC/USDT:USDT'],
      resultFile: null,
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
