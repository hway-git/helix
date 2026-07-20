import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  createForwardDeployment,
  createForwardWorkerOwner,
  createForwardWorkerOwnerToken,
  forwardReportArchiveNeedsVerification,
  forwardWorkerOwnerMatchesProcess,
} from '../lib/forward-runtime.mjs';
import { createPromotableWalkForwardReport } from './helpers/promotable-report.mjs';

const FORWARD_RUNTIME = resolve(new URL('../lib/forward-runtime.mjs', import.meta.url).pathname);

function artifact() {
  return {
    strategyLifecycle: 'shadow',
    objectModel: 'PRICE_EVENT',
    symbol: 'BTC/USDT:USDT',
    baseTimeframe: '1m',
    identity: {
      strategyId: 'helix_scalp_hunter',
      strategyVersion: '1.0.1',
      strategyRepoCommit: 'a'.repeat(40),
      strategyConfigHash: `sha256:${'b'.repeat(64)}`,
      engineCommit: 'c'.repeat(40),
    },
  };
}

function processIsAlive(pid) {
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

async function startWatchdog(home, {
  emergencyAfterFirstRun = false,
  supersedeAfterFirstRun = false,
  oldLatchBeforeStart = false,
  newLatchBeforeOwnerCommit = false,
  reportGuard = false,
} = {}) {
  const root = join(home, 'forward');
  const reportEvidence = reportGuard
    ? await createPromotableWalkForwardReport(join(home, 'walk-forward'), artifact())
    : null;
  const reportFile = reportEvidence?.reportFile ?? null;
  const reportHash = reportEvidence?.report.reportHash ?? null;
  const deployment = createForwardDeployment(artifact(), {
    activatedAt: 1,
    deploymentId: 'watchdog-test',
    walkForwardReportHash: reportGuard ? reportHash : null,
  });
  const deploymentFile = join(root, 'deployment.json');
  const configFile = join(home, 'config.json');
  const pidFile = join(root, 'worker.pid');
  const emergencyStopFile = join(home, 'emergency-stop.json');
  const countFile = join(root, 'count.txt');
  const statusFile = join(root, 'status.json');
  const workerFile = join(root, 'fake-worker.cjs');
  await mkdir(root, { recursive: true });
  await writeFile(deploymentFile, JSON.stringify(deployment));
  await writeFile(configFile, JSON.stringify({
    helix_signal_forward_deployment_hash: deployment.deploymentHash,
    ...(reportGuard ? {
      helix_signal_walk_forward_report_path: reportFile,
      helix_signal_walk_forward_report_hash: reportHash,
    } : {}),
  }));
  let allowedInitialEmergencyStopHash = null;
  if (oldLatchBeforeStart) {
    const content = JSON.stringify({ id: 'old-latch' });
    await writeFile(emergencyStopFile, content);
    allowedInitialEmergencyStopHash = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  }
  await writeFile(workerFile, `
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const params = JSON.parse(process.argv.at(-1));
const count = existsSync(params.countFile) ? Number(readFileSync(params.countFile, 'utf8')) + 1 : 1;
writeFileSync(params.countFile, String(count));
writeFileSync(params.status, JSON.stringify({
  schemaVersion: 'helix.forward-worker-status/v1',
  deploymentHash: params.deploymentHash,
  state: 'waiting',
  pid: params.statusPid,
  updatedAt: Date.now(),
  lastDecisionTime: null,
  lastMarketSnapshotId: null,
  lastBatchHash: null,
  batches: 0,
  error: null,
}));
if (count === 1) {
  if (params.emergencyAfterFirstRun) writeFileSync(params.emergencyStopFile, '{}');
  if (params.supersedeAfterFirstRun) writeFileSync(params.configFile, JSON.stringify({
    helix_signal_forward_deployment_hash: 'sha256:' + 'f'.repeat(64),
  }));
  setTimeout(() => process.exit(17), 25);
} else {
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
}
`);
  const ownerToken = createForwardWorkerOwnerToken();
  const params = {
    deploymentHash: deployment.deploymentHash,
    ownerToken,
    pidFile,
    emergencyStopFile,
    allowedInitialEmergencyStopHash,
    deploymentFile,
    configFile,
    workerFile,
    workerParams: {
      deploymentHash: deployment.deploymentHash,
      countFile,
      status: statusFile,
      emergencyAfterFirstRun,
      supersedeAfterFirstRun,
      emergencyStopFile,
      configFile,
    },
    cwd: root,
  };
  const watchdog = spawn(process.execPath, [FORWARD_RUNTIME, 'watchdog', JSON.stringify(params)], {
    stdio: 'ignore',
  });
  if (newLatchBeforeOwnerCommit) await writeFile(emergencyStopFile, JSON.stringify({ id: 'new-latch' }));
  assert.equal(Number.isSafeInteger(watchdog.pid), true);
  let owner = null;
  assert.equal(await waitUntil(async () => {
    try {
      owner = createForwardWorkerOwner({
        pid: watchdog.pid,
        deploymentHash: deployment.deploymentHash,
        ownerToken,
      });
      return true;
    } catch {
      return false;
    }
  }), true);
  await writeFile(pidFile, JSON.stringify(owner));
  return { watchdog, deployment, owner, countFile, statusFile, emergencyStopFile, reportFile };
}

test('owner token and process start fingerprint reject PID reuse', () => {
  const ownerToken = 'd'.repeat(32);
  const identity = {
    startedAt: 'Fri Jul 17 10:00:00 2026',
    command: `node forward-runtime.mjs watchdog ${ownerToken}`,
    fingerprint: `sha256:${'e'.repeat(64)}`,
  };
  const owner = createForwardWorkerOwner({
    pid: 42,
    deploymentHash: `sha256:${'a'.repeat(64)}`,
    ownerToken,
    createdAt: 1,
  }, () => identity);
  assert.equal(forwardWorkerOwnerMatchesProcess(owner, owner.deploymentHash, () => identity), true);
  assert.equal(forwardWorkerOwnerMatchesProcess(owner, owner.deploymentHash, () => ({
    ...identity,
    startedAt: 'Fri Jul 17 11:00:00 2026',
    fingerprint: `sha256:${'f'.repeat(64)}`,
  })), false);
})

test('forward deployment pins a promotable walk-forward report hash', () => {
  const deployment = createForwardDeployment(artifact(), {
    activatedAt: 1,
    deploymentId: 'report-pin-test',
    walkForwardReportHash: `sha256:${'f'.repeat(64)}`,
  });
  assert.equal(deployment.walkForwardReportHash, `sha256:${'f'.repeat(64)}`);
});

test('unchanged report archive fingerprints do not request full verification', () => {
  const state = {
    reportFile: '/tmp/report.json',
    reportHash: `sha256:${'f'.repeat(64)}`,
    reportArchiveFingerprint: `sha256:${'e'.repeat(64)}`,
  };
  assert.equal(forwardReportArchiveNeedsVerification(state, {
    reportFile: state.reportFile,
    reportHash: state.reportHash,
    fingerprint: state.reportArchiveFingerprint,
  }), false);
  assert.equal(forwardReportArchiveNeedsVerification(state, {
    reportFile: state.reportFile,
    reportHash: state.reportHash,
    fingerprint: `sha256:${'d'.repeat(64)}`,
  }), true);
});

test('watchdog restarts a crashed worker and terminates its child on stop', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-forward-watchdog-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const runtime = await startWatchdog(home);
  t.after(() => {
    if (processIsAlive(runtime.watchdog.pid)) process.kill(runtime.watchdog.pid, 'SIGKILL');
  });
  assert.equal(await waitUntil(async () => {
    try { return Number(await readFile(runtime.countFile, 'utf8')) >= 2; } catch { return false; }
  }), true);
  const status = JSON.parse(await readFile(runtime.statusFile, 'utf8'));
  assert.equal(status.pid, runtime.watchdog.pid);
  process.kill(runtime.watchdog.pid, 'SIGTERM');
  assert.equal(await waitUntil(() => !processIsAlive(runtime.watchdog.pid)), true);
  const count = Number(await readFile(runtime.countFile, 'utf8'));
  await new Promise((resolveWait) => setTimeout(resolveWait, 350));
  assert.equal(Number(await readFile(runtime.countFile, 'utf8')), count);
})

test('watchdog does not restart after an emergency latch appears', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-forward-watchdog-emergency-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const runtime = await startWatchdog(home, { emergencyAfterFirstRun: true });
  t.after(() => {
    if (processIsAlive(runtime.watchdog.pid)) process.kill(runtime.watchdog.pid, 'SIGKILL');
  });
  assert.equal(await waitUntil(() => !processIsAlive(runtime.watchdog.pid)), true);
  assert.equal(Number(await readFile(runtime.countFile, 'utf8')), 1);
})

test('watchdog stops a healthy worker when a new emergency latch appears', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-forward-watchdog-live-emergency-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const runtime = await startWatchdog(home);
  t.after(() => {
    if (processIsAlive(runtime.watchdog.pid)) process.kill(runtime.watchdog.pid, 'SIGKILL');
  });
  assert.equal(await waitUntil(async () => {
    try { return Number(await readFile(runtime.countFile, 'utf8')) >= 2; } catch { return false; }
  }), true);
  await writeFile(runtime.emergencyStopFile, JSON.stringify({ id: 'new-live-latch' }));
  assert.equal(await waitUntil(() => !processIsAlive(runtime.watchdog.pid)), true);
})

test('watchdog does not restart after the deployment is superseded', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-forward-watchdog-superseded-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const runtime = await startWatchdog(home, { supersedeAfterFirstRun: true });
  t.after(() => {
    if (processIsAlive(runtime.watchdog.pid)) process.kill(runtime.watchdog.pid, 'SIGKILL');
  });
  assert.equal(await waitUntil(() => !processIsAlive(runtime.watchdog.pid)), true);
  assert.equal(Number(await readFile(runtime.countFile, 'utf8')), 1);
})

test('watchdog stops when its pinned walk-forward report changes', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-forward-watchdog-report-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const runtime = await startWatchdog(home, { reportGuard: true });
  t.after(() => {
    if (processIsAlive(runtime.watchdog.pid)) process.kill(runtime.watchdog.pid, 'SIGKILL');
  });
  assert.equal(await waitUntil(async () => {
    try { return Number(await readFile(runtime.countFile, 'utf8')) >= 2; } catch { return false; }
  }), true);
  await writeFile(runtime.reportFile, JSON.stringify({ reportHash: runtime.deployment.walkForwardReportHash }));
  assert.equal(await waitUntil(() => !processIsAlive(runtime.watchdog.pid)), true);
});

test('watchdog allows its pinned old latch but blocks a new latch before first spawn', async (t) => {
  const oldHome = await mkdtemp(join(tmpdir(), 'helix-forward-watchdog-old-latch-'));
  const newHome = await mkdtemp(join(tmpdir(), 'helix-forward-watchdog-new-latch-'));
  t.after(() => Promise.all([
    rm(oldHome, { recursive: true, force: true }),
    rm(newHome, { recursive: true, force: true }),
  ]));
  const allowed = await startWatchdog(oldHome, { oldLatchBeforeStart: true });
  t.after(() => {
    if (processIsAlive(allowed.watchdog.pid)) process.kill(allowed.watchdog.pid, 'SIGKILL');
  });
  assert.equal(await waitUntil(async () => {
    try { return Number(await readFile(allowed.countFile, 'utf8')) >= 2; } catch { return false; }
  }), true);
  await rm(allowed.emergencyStopFile, { force: true });
  await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  await writeFile(allowed.emergencyStopFile, JSON.stringify({ id: 'old-latch' }));
  assert.equal(await waitUntil(() => !processIsAlive(allowed.watchdog.pid)), true);

  const blocked = await startWatchdog(newHome, { newLatchBeforeOwnerCommit: true });
  t.after(() => {
    if (processIsAlive(blocked.watchdog.pid)) process.kill(blocked.watchdog.pid, 'SIGKILL');
  });
  assert.equal(await waitUntil(() => !processIsAlive(blocked.watchdog.pid)), true);
  await assert.rejects(readFile(blocked.countFile, 'utf8'), /ENOENT/);
})
