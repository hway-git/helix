#!/usr/bin/env node
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const composeFile = resolve(root, 'compose.yaml');
const configTemplate = resolve(root, 'config.json');
const helixDir = resolve(homedir(), '.helix');
const envFile = resolve(helixDir, '.env');
const userData = resolve(homedir(), '.freqtrade', 'user_data');
const configFile = resolve(userData, 'config.json');
const strategyFile = resolve(userData, 'strategies', 'SampleStrategy.py');

function upsertEnv(content, key, value, { preserve = false } = {}) {
  const lines = content ? content.split('\n') : [];
  const index = lines.findIndex((line) => line.trim().startsWith(`${key}=`));
  if (index >= 0) {
    if (!preserve) lines[index] = `${key}=${value}`;
  } else {
    lines.push(`${key}=${value}`);
  }
  return lines.filter((line, lineIndex) => line !== '' || lineIndex < lines.length - 1).join('\n');
}

function writeRuntimeEnv() {
  mkdirSync(helixDir, { recursive: true });
  let content = existsSync(envFile) ? readFileSync(envFile, 'utf8').trimEnd() : '';
  content = upsertEnv(content, 'HELIX_FREQTRADE_RUNTIME', 'docker');
  content = upsertEnv(content, 'FREQTRADE_URL', 'http://127.0.0.1:8888');
  content = upsertEnv(content, 'FREQTRADE_USERNAME', 'freqtrade');
  content = upsertEnv(content, 'FREQTRADE_PASSWORD', randomBytes(24).toString('hex'), { preserve: true });
  content = upsertEnv(content, 'FREQTRADE_JWT_SECRET', randomBytes(32).toString('hex'), { preserve: true });

  const temporary = `${envFile}.tmp.${process.pid}`;
  writeFileSync(temporary, `${content}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, envFile);
}

function compose(args, options = {}) {
  return execFileSync('docker', ['compose', '--env-file', envFile, '-f', composeFile, ...args], {
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout: options.timeout ?? 10 * 60_000,
  });
}

function ensureUserData() {
  mkdirSync(resolve(userData, 'strategies'), { recursive: true });
  mkdirSync(resolve(userData, 'logs'), { recursive: true });
  mkdirSync(resolve(userData, 'backtest_results'), { recursive: true });
  if (!existsSync(configFile)) {
    copyFileSync(configTemplate, configFile);
    chmodSync(configFile, 0o600);
  }
}

async function waitForApi() {
  const env = Object.fromEntries(
    readFileSync(envFile, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
  const auth = Buffer.from(`${env.FREQTRADE_USERNAME}:${env.FREQTRADE_PASSWORD}`).toString('base64');

  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:8888/api/v1/ping', {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolveAttempt) => setTimeout(resolveAttempt, 2_000));
  }

  throw new Error('Freqtrade API did not become ready on http://127.0.0.1:8888');
}

writeRuntimeEnv();
ensureUserData();
compose(['pull']);

if (!existsSync(strategyFile)) {
  compose([
    'run', '--rm', '--no-deps', 'freqtrade',
    'new-strategy', '--strategy', 'SampleStrategy', '--template', 'minimal',
    '--userdir', '/freqtrade/user_data',
  ]);
}

compose(['up', '-d', 'freqtrade']);
await waitForApi();

const version = compose(['run', '--rm', '--no-deps', 'freqtrade', '--version'], { capture: true }).trim();
console.log(JSON.stringify({
  installed: true,
  runtime: 'docker',
  version,
  api: 'http://127.0.0.1:8888',
  mode: 'dry-run',
  exchange: 'okx',
  config: configFile,
  compose: composeFile,
}, null, 2));
