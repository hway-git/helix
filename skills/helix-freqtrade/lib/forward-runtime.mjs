import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkForwardReportHash } from './walk-forward.mjs';
import { verifyWalkForwardEvidenceReportFile } from './walk-forward-portfolio.mjs';
import { okxForwardSource, okxInstrumentId } from './forward-target.mjs';

export const FORWARD_DEPLOYMENT_SCHEMA_VERSION = 'helix.forward-deployment/v1';
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const DRY_RUN_LIFECYCLES = new Set(['shadow', 'canary', 'production']);
export const FORWARD_WORKER_OWNER_SCHEMA_VERSION = 'helix.forward-worker-owner/v1';
const OWNER_TOKEN_PATTERN = /^[a-f0-9]{32}$/;
const REPORT_ARCHIVE_VERIFY_INTERVAL_MS = 1_000;

function exactFields(value, name, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new Error(`${name} must contain exactly: ${fields.join(', ')}`);
  }
  return value;
}

function processFingerprint(startedAt, command) {
  return `sha256:${createHash('sha256').update(`${startedAt}\0${command}`).digest('hex')}`;
}

export function inspectForwardWorkerProcess(pid, runFile = execFileSync) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const startedAt = runFile('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const command = runFile('ps', ['-ww', '-p', String(pid), '-o', 'command='], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!startedAt || !command) return null;
    return { startedAt, command, fingerprint: processFingerprint(startedAt, command) };
  } catch {
    return null;
  }
}

export function createForwardWorkerOwner({ pid, deploymentHash, ownerToken, createdAt = Date.now() }, inspect = inspectForwardWorkerProcess) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('forward worker owner pid is invalid');
  if (!HASH_PATTERN.test(deploymentHash || '')) throw new Error('forward worker owner deploymentHash is invalid');
  if (!OWNER_TOKEN_PATTERN.test(ownerToken || '')) throw new Error('forward worker ownerToken is invalid');
  const identity = inspect(pid);
  if (!identity || !identity.command.includes(ownerToken)) {
    throw new Error('forward watchdog process does not prove its ownership token');
  }
  return verifyForwardWorkerOwner({
    schemaVersion: FORWARD_WORKER_OWNER_SCHEMA_VERSION,
    pid,
    deploymentHash,
    ownerToken,
    processStartedAt: identity.startedAt,
    processFingerprint: identity.fingerprint,
    createdAt,
  }, deploymentHash);
}

export function verifyForwardWorkerOwner(value, deploymentHash) {
  const owner = exactFields(value, 'forward worker owner', [
    'schemaVersion', 'pid', 'deploymentHash', 'ownerToken', 'processStartedAt', 'processFingerprint', 'createdAt',
  ]);
  if (owner.schemaVersion !== FORWARD_WORKER_OWNER_SCHEMA_VERSION) {
    throw new Error('forward worker owner schema is unsupported');
  }
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1
    || owner.deploymentHash !== deploymentHash
    || !HASH_PATTERN.test(owner.deploymentHash || '')
    || !OWNER_TOKEN_PATTERN.test(owner.ownerToken || '')
    || typeof owner.processStartedAt !== 'string' || !owner.processStartedAt.trim()
    || !HASH_PATTERN.test(owner.processFingerprint || '')
    || !Number.isSafeInteger(owner.createdAt) || owner.createdAt < 0) {
    throw new Error('forward worker owner metadata is invalid');
  }
  return owner;
}

export function forwardWorkerOwnerMatchesProcess(ownerValue, deploymentHash, inspect = inspectForwardWorkerProcess) {
  const owner = verifyForwardWorkerOwner(ownerValue, deploymentHash);
  const identity = inspect(owner.pid);
  return Boolean(identity
    && identity.startedAt === owner.processStartedAt
    && identity.fingerprint === owner.processFingerprint
    && identity.command.includes(owner.ownerToken));
}

export function createForwardWorkerOwnerToken() {
  return randomUUID().replaceAll('-', '');
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function emergencyStopHash(file) {
  if (!existsSync(file)) return null;
  return `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
}

function reportArchiveStatFingerprint(files) {
  const digest = createHash('sha256');
  for (const file of files) {
    const stat = statSync(file, { bigint: true });
    if (!stat.isFile()) throw new Error(`walk-forward report archive is not a file: ${file}`);
    digest.update(`${file}\0${stat.size}\0${stat.mtimeNs}\0${stat.ctimeNs}\0`);
  }
  return `sha256:${digest.digest('hex')}`;
}

export function forwardReportArchiveNeedsVerification(state, { reportFile, reportHash, fingerprint }) {
  return state.reportFile !== reportFile
    || state.reportHash !== reportHash
    || state.reportArchiveFingerprint !== fingerprint;
}

function watchdogGuard(params, guardState) {
  try {
    const owner = verifyForwardWorkerOwner(readJson(params.pidFile), params.deploymentHash);
    if (owner.pid !== process.pid || owner.ownerToken !== params.ownerToken
      || !forwardWorkerOwnerMatchesProcess(owner, params.deploymentHash)) return false;
    const currentEmergencyHash = emergencyStopHash(params.emergencyStopFile);
    if (currentEmergencyHash === null) guardState.initialLatchStillAllowed = false;
    if (currentEmergencyHash !== null
      && (!guardState.initialLatchStillAllowed
        || currentEmergencyHash !== params.allowedInitialEmergencyStopHash)) return false;
    const deployment = verifyForwardDeployment(readJson(params.deploymentFile));
    if (deployment.deploymentHash !== params.deploymentHash) return false;
    const config = readJson(params.configFile);
    if (deployment.walkForwardReportHash) {
      if (config?.helix_signal_walk_forward_report_hash !== deployment.walkForwardReportHash
        || typeof config?.helix_signal_walk_forward_report_path !== 'string') return false;
      const report = readJson(config.helix_signal_walk_forward_report_path);
      const payload = Object.fromEntries(Object.entries(report).filter(([field]) => field !== 'reportHash'));
      if (report.reportHash !== deployment.walkForwardReportHash
        || walkForwardReportHash(payload) !== deployment.walkForwardReportHash) return false;
      const reportFile = config.helix_signal_walk_forward_report_path;
      const reportHash = deployment.walkForwardReportHash;
      const pinChanged = guardState.reportFile !== reportFile || guardState.reportHash !== reportHash;
      const now = Date.now();
      if (pinChanged || now - guardState.reportArchiveStatCheckedAt >= REPORT_ARCHIVE_VERIFY_INTERVAL_MS) {
        const fingerprint = pinChanged
          ? null
          : reportArchiveStatFingerprint(guardState.reportArchiveFiles);
        if (forwardReportArchiveNeedsVerification(guardState, { reportFile, reportHash, fingerprint })) {
          const verified = verifyWalkForwardEvidenceReportFile(reportFile);
          if (verified.report.reportHash !== reportHash) return false;
          guardState.reportFile = reportFile;
          guardState.reportHash = reportHash;
          guardState.reportArchiveFiles = verified.archiveFiles;
          guardState.reportArchiveFingerprint = reportArchiveStatFingerprint(verified.archiveFiles);
        }
        guardState.reportArchiveStatCheckedAt = now;
      }
    }
    return config?.helix_signal_forward_deployment_hash === params.deploymentHash;
  } catch {
    return false;
  }
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function waitForInitialWatchdogOwnership(params, guardState, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (watchdogGuard(params, guardState)) return;
    await wait(25);
  }
  throw new Error('forward watchdog ownership was not committed before startup');
}

function spawnForwardWorkerChild(params) {
  const workerParams = {
    ...params.workerParams,
    statusPid: process.pid,
  };
  const loader = params.workerFile.endsWith('.ts') ? ['--import', 'tsx/esm'] : [];
  return spawn(process.execPath, [
    ...loader,
    params.workerFile,
    'run',
    JSON.stringify(workerParams),
  ], {
    cwd: params.cwd,
    stdio: 'inherit',
    env: process.env,
  });
}

function waitForChild(child) {
  return new Promise((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal, error: null }));
    child.once('error', (error) => resolveExit({ code: null, signal: null, error }));
  });
}

async function waitForChildOrGuard(child, params, guardState) {
  const exited = waitForChild(child);
  while (child.exitCode === null && child.signalCode === null) {
    const result = await Promise.race([exited, wait(100).then(() => null)]);
    if (result) return { result, guardChanged: false };
    if (!watchdogGuard(params, guardState)) {
      try { child.kill('SIGTERM'); } catch {}
      const force = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill('SIGKILL'); } catch {}
        }
      }, 5_000);
      force.unref();
      return { result: await exited, guardChanged: true };
    }
  }
  return { result: await exited, guardChanged: false };
}

export async function runForwardWorkerWatchdog(paramsValue) {
  const params = exactFields(paramsValue, 'forward watchdog params', [
    'deploymentHash', 'ownerToken', 'pidFile', 'emergencyStopFile', 'deploymentFile',
    'configFile', 'workerFile', 'workerParams', 'cwd', 'allowedInitialEmergencyStopHash',
  ]);
  if (!HASH_PATTERN.test(params.deploymentHash || '') || !OWNER_TOKEN_PATTERN.test(params.ownerToken || '')) {
    throw new Error('forward watchdog identity is invalid');
  }
  if (params.allowedInitialEmergencyStopHash !== null
    && !HASH_PATTERN.test(params.allowedInitialEmergencyStopHash || '')) {
    throw new Error('forward watchdog allowed initial emergency stop hash is invalid');
  }
  for (const field of ['pidFile', 'emergencyStopFile', 'deploymentFile', 'configFile', 'workerFile', 'cwd']) {
    if (typeof params[field] !== 'string' || !params[field].trim()) {
      throw new Error(`forward watchdog ${field} is required`);
    }
  }
  if (!params.workerParams || typeof params.workerParams !== 'object' || Array.isArray(params.workerParams)) {
    throw new Error('forward watchdog workerParams must be an object');
  }
  const guardState = {
    initialLatchStillAllowed: params.allowedInitialEmergencyStopHash !== null,
    reportFile: null,
    reportHash: null,
    reportArchiveFiles: [],
    reportArchiveFingerprint: null,
    reportArchiveStatCheckedAt: 0,
  };
  await waitForInitialWatchdogOwnership(params, guardState);

  let stopping = false;
  let child = null;
  const stop = () => {
    stopping = true;
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGTERM'); } catch {}
      const force = setTimeout(() => {
        if (child && child.exitCode === null && child.signalCode === null) {
          try { child.kill('SIGKILL'); } catch {}
        }
      }, 5_000);
      force.unref();
    }
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  let restartDelayMs = 250;
  try {
    while (!stopping) {
      if (!watchdogGuard(params, guardState)) return { stopped: true, reason: 'runtime guard changed' };
      child = spawnForwardWorkerChild(params);
      const monitored = await waitForChildOrGuard(child, params, guardState);
      const result = monitored.result;
      child = null;
      if (monitored.guardChanged) return { stopped: true, reason: 'runtime guard changed' };
      if (stopping) break;
      if (!watchdogGuard(params, guardState)) return { stopped: true, reason: 'runtime guard changed' };
      const detail = result.error?.message || result.signal || `exit ${result.code}`;
      console.error(`[helix-forward-watchdog] worker stopped (${detail}); restarting in ${restartDelayMs}ms`);
      await wait(restartDelayMs);
      if (!watchdogGuard(params, guardState)) return { stopped: true, reason: 'runtime guard changed' };
      restartDelayMs = Math.min(30_000, restartDelayMs * 2);
    }
    return { stopped: true, reason: 'watchdog terminated' };
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGTERM'); } catch {}
    }
  }
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('forward deployment canonical numbers must be safe integers');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new Error(`unsupported forward deployment value ${typeof value}`);
}

export function forwardDeploymentHash(payload) {
  return `sha256:${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`;
}

export function verifyForwardDeployment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('forward deployment must be an object');
  const hasReport = Object.hasOwn(value, 'walkForwardReportHash');
  const payloadFields = [
    'schemaVersion', 'deploymentId', 'mode', 'activatedAt', 'provider', 'instrumentId', 'symbol', 'strategy',
    ...(hasReport ? ['walkForwardReportHash'] : []),
  ];
  const actual = Object.keys(value).sort();
  const expected = [...payloadFields, 'deploymentHash'].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new Error('forward deployment contains unexpected fields');
  }
  if (value.schemaVersion !== FORWARD_DEPLOYMENT_SCHEMA_VERSION || value.mode !== 'dry_run' || value.provider !== 'okx') {
    throw new Error('unsupported forward deployment contract');
  }
  if (!Number.isSafeInteger(value.activatedAt) || value.activatedAt < 0) throw new Error('forward deployment activatedAt is invalid');
  if (!HASH_PATTERN.test(value.deploymentHash || '')) throw new Error('forward deployment hash is invalid');
  if (hasReport && !HASH_PATTERN.test(value.walkForwardReportHash || '')) {
    throw new Error('forward deployment walkForwardReportHash is invalid');
  }
  const payload = Object.fromEntries(payloadFields.map((field) => [field, value[field]]));
  const expectedHash = forwardDeploymentHash(payload);
  if (value.deploymentHash !== expectedHash) throw new Error(`forward deployment hash mismatch: expected ${expectedHash}`);
  return value;
}

export { okxInstrumentId };

export function createForwardDeployment(
  artifact,
  { activatedAt = Date.now(), deploymentId = randomUUID(), walkForwardReportHash = null } = {},
) {
  if (!artifact || typeof artifact !== 'object') throw new Error('signal artifact is required for forward deployment');
  if (!DRY_RUN_LIFECYCLES.has(artifact.strategyLifecycle)) {
    throw new Error(`Strategy lifecycle ${artifact.strategyLifecycle} cannot run forward dry-run.`);
  }
  if (!Number.isSafeInteger(activatedAt) || activatedAt < 0) throw new Error('activatedAt must be a non-negative timestamp');
  const identity = artifact.identity || {};
  if (!COMMIT_PATTERN.test(identity.strategyRepoCommit || '') || !COMMIT_PATTERN.test(identity.engineCommit || '')) {
    throw new Error('Forward deployment requires full strategy and Engine commits.');
  }
  if (!HASH_PATTERN.test(identity.strategyConfigHash || '')) {
    throw new Error('Forward deployment requires a SHA-256 strategy config hash.');
  }
  if (walkForwardReportHash !== null && !HASH_PATTERN.test(walkForwardReportHash || '')) {
    throw new Error('Forward deployment requires a valid walk-forward report hash.');
  }
  const target = okxForwardSource(artifact.symbol);
  const payload = {
    schemaVersion: FORWARD_DEPLOYMENT_SCHEMA_VERSION,
    deploymentId,
    mode: 'dry_run',
    activatedAt,
    provider: target.provider,
    instrumentId: target.instrumentId,
    symbol: target.symbol,
    ...(walkForwardReportHash ? { walkForwardReportHash } : {}),
    strategy: {
      id: identity.strategyId,
      version: identity.strategyVersion,
      repoCommit: identity.strategyRepoCommit,
      configHash: identity.strategyConfigHash,
      engineCommit: identity.engineCommit,
      lifecycle: artifact.strategyLifecycle,
      objectModel: artifact.objectModel,
      baseTimeframe: artifact.baseTimeframe,
    },
  };
  return verifyForwardDeployment({ ...payload, deploymentHash: forwardDeploymentHash(payload) });
}

async function main() {
  const [action, rawParams = '{}'] = process.argv.slice(2);
  if (action !== 'watchdog') throw new Error('Usage: forward-runtime.mjs watchdog <json-params>');
  return runForwardWorkerWatchdog(JSON.parse(rawParams));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
