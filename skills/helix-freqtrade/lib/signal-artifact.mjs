import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const HELIX_SIGNAL_STRATEGY = 'HelixSignalStrategy';
export const SIGNAL_ARTIFACT_SCHEMA_VERSION = 'helix.signal-artifact/v1';

const PAYLOAD_FIELDS = [
  'schemaVersion',
  'identity',
  'strategyLifecycle',
  'objectModel',
  'symbol',
  'baseTimeframe',
  'marketData',
  'signals',
];
const ARTIFACT_FIELDS = [...PAYLOAD_FIELDS, 'artifactHash'];
const IDENTITY_FIELDS = [
  'strategyId',
  'strategyVersion',
  'strategyRepoCommit',
  'strategyConfigHash',
  'engineCommit',
  'marketDataSnapshotId',
];
const SIGNAL_FIELDS = [
  'sequence',
  'signalId',
  'decisionId',
  'object',
  'action',
  'side',
  'sourceCandleOpenTime',
  'decisionTime',
  'reasonCodes',
];
const LIFECYCLES = new Set(['proposal', 'backtested', 'shadow', 'canary', 'production', 'deprecated']);
const OBJECT_MODELS = new Set(['PRICE_EVENT', 'TRADE_THESIS']);
const ACTIONS = new Set(['ENTER', 'EXIT']);
const SIDES = new Set(['LONG', 'SHORT']);
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

function exactRecord(value, name, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new Error(`${name} must contain exactly: ${fields.join(', ')}`);
  }
  return value;
}

function text(value, name) {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new Error(`${name} must be a non-empty trimmed string`);
  }
  return value;
}

function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value;
}

function timeframeMilliseconds(value) {
  const timeframe = text(value, 'baseTimeframe');
  const match = /^(\d+)([mhdw])$/.exec(timeframe);
  if (!match || Number(match[1]) < 1) {
    throw new Error('baseTimeframe must use Freqtrade minute, hour, day, or week syntax');
  }
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2]];
  const duration = Number(match[1]) * unit;
  if (!Number.isSafeInteger(duration)) throw new Error('baseTimeframe duration is too large');
  return { timeframe, duration };
}

export function canonicalSignalArtifactJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('canonical signal artifacts only support safe integer numbers');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalSignalArtifactJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalSignalArtifactJson(value[key])}`
    )).join(',')}}`;
  }
  throw new Error(`unsupported canonical JSON value ${typeof value}`);
}

export function signalArtifactHash(payload) {
  return `sha256:${createHash('sha256').update(canonicalSignalArtifactJson(payload)).digest('hex')}`;
}

export function verifySignalArtifact(value) {
  const artifact = exactRecord(value, 'signal artifact', ARTIFACT_FIELDS);
  if (artifact.schemaVersion !== SIGNAL_ARTIFACT_SCHEMA_VERSION) {
    throw new Error(`unsupported signal artifact schema ${String(artifact.schemaVersion)}`);
  }
  const identity = exactRecord(artifact.identity, 'identity', IDENTITY_FIELDS);
  for (const field of IDENTITY_FIELDS) text(identity[field], `identity.${field}`);
  if (!COMMIT_PATTERN.test(identity.strategyRepoCommit)) throw new Error('identity.strategyRepoCommit must be a full Git commit');
  if (!HASH_PATTERN.test(identity.strategyConfigHash)) throw new Error('identity.strategyConfigHash must be a SHA-256 hash');
  if (!COMMIT_PATTERN.test(identity.engineCommit)) throw new Error('identity.engineCommit must be a full Git commit');
  if (!LIFECYCLES.has(text(artifact.strategyLifecycle, 'strategyLifecycle'))) throw new Error('strategyLifecycle is invalid');
  const objectModel = text(artifact.objectModel, 'objectModel');
  if (!OBJECT_MODELS.has(objectModel)) throw new Error('objectModel is invalid');
  if (/\s/.test(text(artifact.symbol, 'symbol'))) throw new Error('symbol must not contain whitespace');
  const { duration } = timeframeMilliseconds(artifact.baseTimeframe);
  const marketData = exactRecord(artifact.marketData, 'marketData', ['firstCandleOpenTime', 'lastCandleCloseTime']);
  const firstOpen = integer(marketData.firstCandleOpenTime, 'marketData.firstCandleOpenTime');
  const lastClose = integer(marketData.lastCandleCloseTime, 'marketData.lastCandleCloseTime');
  if (firstOpen % duration || lastClose % duration) throw new Error('marketData boundaries must align to baseTimeframe');
  if (lastClose <= firstOpen) throw new Error('marketData.lastCandleCloseTime must follow firstCandleOpenTime');
  if (!Array.isArray(artifact.signals)) throw new Error('signals must be an array');

  const signalIds = new Set();
  const decisionIds = new Set();
  const decisionTimes = new Set();
  let openPosition;
  let priorDecisionTime = -1;
  for (const [index, candidate] of artifact.signals.entries()) {
    const name = `signals[${index}]`;
    const signal = exactRecord(candidate, name, SIGNAL_FIELDS);
    if (integer(signal.sequence, `${name}.sequence`) !== index) throw new Error(`${name}.sequence must equal ${index}`);
    const signalId = text(signal.signalId, `${name}.signalId`);
    const decisionId = text(signal.decisionId, `${name}.decisionId`);
    const reference = exactRecord(signal.object, `${name}.object`, ['model', 'id']);
    if (reference.model !== objectModel) throw new Error(`${name}.object.model must match artifact objectModel`);
    text(reference.id, `${name}.object.id`);
    const action = text(signal.action, `${name}.action`);
    const side = text(signal.side, `${name}.side`);
    if (!ACTIONS.has(action)) throw new Error(`${name}.action is invalid`);
    if (!SIDES.has(side)) throw new Error(`${name}.side is invalid`);
    const sourceOpen = integer(signal.sourceCandleOpenTime, `${name}.sourceCandleOpenTime`);
    const decisionTime = integer(signal.decisionTime, `${name}.decisionTime`);
    if (sourceOpen % duration) throw new Error(`${name}.sourceCandleOpenTime must align to baseTimeframe`);
    if (decisionTime !== sourceOpen + duration) throw new Error(`${name}.decisionTime must equal the source candle close time`);
    if (decisionTime < priorDecisionTime) throw new Error('signals must be ordered by decisionTime');
    if (sourceOpen < firstOpen || decisionTime > lastClose) throw new Error(`${name} falls outside the marketData window`);
    if (signalIds.has(signalId)) throw new Error(`duplicate signalId ${signalId}`);
    if (decisionIds.has(decisionId)) throw new Error(`duplicate decisionId ${decisionId}`);
    const objectId = reference.id;
    if (decisionTimes.has(decisionTime)) {
      throw new Error(`multiple signals at decisionTime ${decisionTime} are ambiguous`);
    }
    if (action === 'ENTER') {
      if (openPosition) {
        throw new Error(`ENTER for object ${objectId} overlaps open position for object ${openPosition.objectId}`);
      }
      openPosition = { objectId, side };
    } else {
      if (!openPosition) throw new Error(`EXIT for object ${objectId} has no matching ENTER`);
      if (openPosition.objectId !== objectId) {
        throw new Error(`EXIT for object ${objectId} does not match open ENTER for object ${openPosition.objectId}`);
      }
      if (openPosition.side !== side) throw new Error(`EXIT side for object ${objectId} does not match its ENTER`);
      openPosition = undefined;
    }
    if (!Array.isArray(signal.reasonCodes) || signal.reasonCodes.length === 0) {
      throw new Error(`${name}.reasonCodes must be a non-empty array`);
    }
    const reasonCodes = signal.reasonCodes.map((code) => text(code, `${name}.reasonCodes`));
    if (new Set(reasonCodes).size !== reasonCodes.length) throw new Error(`${name}.reasonCodes must not contain duplicates`);
    if (reasonCodes.some((code) => !REASON_CODE_PATTERN.test(code))) {
      throw new Error(`${name}.reasonCodes contains an invalid reason code`);
    }
    signalIds.add(signalId);
    decisionIds.add(decisionId);
    decisionTimes.add(decisionTime);
    priorDecisionTime = decisionTime;
  }

  if (!HASH_PATTERN.test(text(artifact.artifactHash, 'artifactHash'))) throw new Error('artifactHash must be a SHA-256 hash');
  const payload = Object.fromEntries(PAYLOAD_FIELDS.map((field) => [field, artifact[field]]));
  const expectedHash = signalArtifactHash(payload);
  if (artifact.artifactHash !== expectedHash) throw new Error(`signal artifact hash mismatch: expected ${expectedHash}`);
  return artifact;
}

export function loadSignalArtifact(file) {
  let value;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read signal artifact ${file}: ${error.message}`);
  }
  return verifySignalArtifact(value);
}

export function pinnedSignalIdentity(artifact) {
  return {
    strategyId: artifact.identity.strategyId,
    strategyVersion: artifact.identity.strategyVersion,
    strategyRepoCommit: artifact.identity.strategyRepoCommit,
    strategyConfigHash: artifact.identity.strategyConfigHash,
    engineCommit: artifact.identity.engineCommit,
  };
}

export function samePinnedSignalIdentity(left, right) {
  const leftIdentity = pinnedSignalIdentity(left);
  const rightIdentity = pinnedSignalIdentity(right);
  return Object.keys(leftIdentity).every((field) => leftIdentity[field] === rightIdentity[field]);
}
