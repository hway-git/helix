import { createHash } from 'node:crypto'
import {
  STRATEGY_POSITION_SIDES,
  STRATEGY_SIGNAL_ACTIONS,
  STRATEGY_SIGNAL_ARTIFACT_SCHEMA_VERSION,
  type StrategyDecisionIdentity,
  type StrategyLifecycle,
  type StrategyObjectModel,
  type StrategySignalArtifact,
  type StrategySignalArtifactPayload,
  type StrategySignalRecord,
} from '@helix/contracts/strategy'

const LIFECYCLES = new Set<StrategyLifecycle>([
  'proposal',
  'backtested',
  'shadow',
  'canary',
  'production',
  'deprecated',
])
const OBJECT_MODELS = new Set<StrategyObjectModel>(['PRICE_EVENT', 'TRADE_THESIS'])
const SIGNAL_ACTIONS = new Set<string>(STRATEGY_SIGNAL_ACTIONS)
const POSITION_SIDES = new Set<string>(STRATEGY_POSITION_SIDES)
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/
const COMMIT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/

type UnknownRecord = Record<string, unknown>

function exactRecord(value: unknown, name: string, fields: readonly string[]): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  const result = value as UnknownRecord
  const actual = Object.keys(result).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new Error(`${name} must contain exactly: ${fields.join(', ')}`)
  }
  return result
}

function text(value: unknown, name: string) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new Error(`${name} must be a non-empty trimmed string`)
  }
  return value
}

function integer(value: unknown, name: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative safe integer`)
  }
  return value as number
}

function reasonCodes(value: unknown, name: string) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${name} must be a non-empty array`)
  const codes = value.map((item, index) => text(item, `${name}[${index}]`))
  if (new Set(codes).size !== codes.length) throw new Error(`${name} must not contain duplicates`)
  for (const code of codes) {
    if (!REASON_CODE_PATTERN.test(code)) throw new Error(`${name} contains invalid reason code ${code}`)
  }
  return codes
}

export function strategyTimeframeMilliseconds(value: unknown) {
  const timeframe = text(value, 'baseTimeframe')
  const match = /^(\d+)([mhdw])$/.exec(timeframe)
  if (!match || Number(match[1]) < 1) throw new Error('baseTimeframe must use Freqtrade minute, hour, day, or week syntax')
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2] as 'm' | 'h' | 'd' | 'w']
  const duration = Number(match[1]) * unit
  if (!Number.isSafeInteger(duration)) throw new Error('baseTimeframe duration is too large')
  return { timeframe, duration }
}

function identity(value: unknown): StrategyDecisionIdentity {
  const source = exactRecord(value, 'identity', [
    'strategyId',
    'strategyVersion',
    'strategyRepoCommit',
    'strategyConfigHash',
    'engineCommit',
    'marketDataSnapshotId',
  ])
  const normalized = {
    strategyId: text(source.strategyId, 'identity.strategyId'),
    strategyVersion: text(source.strategyVersion, 'identity.strategyVersion'),
    strategyRepoCommit: text(source.strategyRepoCommit, 'identity.strategyRepoCommit'),
    strategyConfigHash: text(source.strategyConfigHash, 'identity.strategyConfigHash'),
    engineCommit: text(source.engineCommit, 'identity.engineCommit'),
    marketDataSnapshotId: text(source.marketDataSnapshotId, 'identity.marketDataSnapshotId'),
  }
  if (!COMMIT_PATTERN.test(normalized.strategyRepoCommit)) throw new Error('identity.strategyRepoCommit must be a full Git commit')
  if (!HASH_PATTERN.test(normalized.strategyConfigHash)) throw new Error('identity.strategyConfigHash must be a SHA-256 hash')
  if (!COMMIT_PATTERN.test(normalized.engineCommit)) throw new Error('identity.engineCommit must be a full Git commit')
  return normalized
}

function signalRecord(
  value: unknown,
  index: number,
  objectModel: StrategyObjectModel,
  timeframeMs: number,
): StrategySignalRecord {
  const name = `signals[${index}]`
  const source = exactRecord(value, name, [
    'sequence',
    'signalId',
    'decisionId',
    'object',
    'action',
    'side',
    'sourceCandleOpenTime',
    'decisionTime',
    'reasonCodes',
  ])
  const object = exactRecord(source.object, `${name}.object`, ['model', 'id'])
  const model = text(object.model, `${name}.object.model`) as StrategyObjectModel
  if (!OBJECT_MODELS.has(model) || model !== objectModel) {
    throw new Error(`${name}.object.model must match artifact objectModel`)
  }
  const action = text(source.action, `${name}.action`)
  if (!SIGNAL_ACTIONS.has(action)) throw new Error(`${name}.action is invalid`)
  const side = text(source.side, `${name}.side`)
  if (!POSITION_SIDES.has(side)) throw new Error(`${name}.side is invalid`)
  const sourceCandleOpenTime = integer(source.sourceCandleOpenTime, `${name}.sourceCandleOpenTime`)
  const decisionTime = integer(source.decisionTime, `${name}.decisionTime`)
  if (sourceCandleOpenTime % timeframeMs !== 0) {
    throw new Error(`${name}.sourceCandleOpenTime must align to baseTimeframe`)
  }
  if (decisionTime !== sourceCandleOpenTime + timeframeMs) {
    throw new Error(`${name}.decisionTime must equal the source candle close time`)
  }
  return {
    sequence: integer(source.sequence, `${name}.sequence`),
    signalId: text(source.signalId, `${name}.signalId`),
    decisionId: text(source.decisionId, `${name}.decisionId`),
    object: { model, id: text(object.id, `${name}.object.id`) },
    action: action as StrategySignalRecord['action'],
    side: side as StrategySignalRecord['side'],
    sourceCandleOpenTime,
    decisionTime,
    reasonCodes: reasonCodes(source.reasonCodes, `${name}.reasonCodes`),
  }
}

function normalizePayload(value: unknown): StrategySignalArtifactPayload {
  const source = exactRecord(value, 'signal artifact payload', [
    'schemaVersion',
    'identity',
    'strategyLifecycle',
    'objectModel',
    'symbol',
    'baseTimeframe',
    'marketData',
    'signals',
  ])
  if (source.schemaVersion !== STRATEGY_SIGNAL_ARTIFACT_SCHEMA_VERSION) {
    throw new Error(`unsupported signal artifact schema ${String(source.schemaVersion)}`)
  }
  const strategyLifecycle = text(source.strategyLifecycle, 'strategyLifecycle') as StrategyLifecycle
  if (!LIFECYCLES.has(strategyLifecycle)) throw new Error('strategyLifecycle is invalid')
  const objectModel = text(source.objectModel, 'objectModel') as StrategyObjectModel
  if (!OBJECT_MODELS.has(objectModel)) throw new Error('objectModel is invalid')
  const symbol = text(source.symbol, 'symbol')
  if (/\s/.test(symbol)) throw new Error('symbol must not contain whitespace')
  const { timeframe, duration } = strategyTimeframeMilliseconds(source.baseTimeframe)
  const marketDataSource = exactRecord(source.marketData, 'marketData', [
    'firstCandleOpenTime',
    'lastCandleCloseTime',
  ])
  const marketData = {
    firstCandleOpenTime: integer(marketDataSource.firstCandleOpenTime, 'marketData.firstCandleOpenTime'),
    lastCandleCloseTime: integer(marketDataSource.lastCandleCloseTime, 'marketData.lastCandleCloseTime'),
  }
  if (marketData.firstCandleOpenTime % duration !== 0 || marketData.lastCandleCloseTime % duration !== 0) {
    throw new Error('marketData boundaries must align to baseTimeframe')
  }
  if (marketData.lastCandleCloseTime <= marketData.firstCandleOpenTime) {
    throw new Error('marketData.lastCandleCloseTime must follow firstCandleOpenTime')
  }
  if (!Array.isArray(source.signals)) throw new Error('signals must be an array')
  const signals = source.signals.map((item, index) => signalRecord(item, index, objectModel, duration))
  const signalIds = new Set<string>()
  const decisionIds = new Set<string>()
  const decisionTimes = new Set<number>()
  let openPosition: { objectId: string; side: StrategySignalRecord['side'] } | undefined
  let priorDecisionTime = -1
  for (const [index, signal] of signals.entries()) {
    if (signal.sequence !== index) throw new Error(`signals[${index}].sequence must equal ${index}`)
    if (signal.decisionTime < priorDecisionTime) throw new Error('signals must be ordered by decisionTime')
    if (signal.sourceCandleOpenTime < marketData.firstCandleOpenTime || signal.decisionTime > marketData.lastCandleCloseTime) {
      throw new Error(`signals[${index}] falls outside the marketData window`)
    }
    if (signalIds.has(signal.signalId)) throw new Error(`duplicate signalId ${signal.signalId}`)
    if (decisionIds.has(signal.decisionId)) throw new Error(`duplicate decisionId ${signal.decisionId}`)
    if (decisionTimes.has(signal.decisionTime)) {
      throw new Error(`multiple signals at decisionTime ${signal.decisionTime} are ambiguous`)
    }
    if (signal.action === 'ENTER') {
      if (openPosition) {
        throw new Error(`ENTER for object ${signal.object.id} overlaps open position for object ${openPosition.objectId}`)
      }
      openPosition = { objectId: signal.object.id, side: signal.side }
    } else {
      if (!openPosition) throw new Error(`EXIT for object ${signal.object.id} has no matching ENTER`)
      if (openPosition.objectId !== signal.object.id) {
        throw new Error(`EXIT for object ${signal.object.id} does not match open ENTER for object ${openPosition.objectId}`)
      }
      if (openPosition.side !== signal.side) {
        throw new Error(`EXIT side for object ${signal.object.id} does not match its ENTER`)
      }
      openPosition = undefined
    }
    signalIds.add(signal.signalId)
    decisionIds.add(signal.decisionId)
    decisionTimes.add(signal.decisionTime)
    priorDecisionTime = signal.decisionTime
  }
  return {
    schemaVersion: STRATEGY_SIGNAL_ARTIFACT_SCHEMA_VERSION,
    identity: identity(source.identity),
    strategyLifecycle,
    objectModel,
    symbol,
    baseTimeframe: timeframe,
    marketData,
    signals,
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('canonical signal artifacts only support safe integer numbers')
    return String(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as UnknownRecord
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  throw new Error(`unsupported canonical JSON value ${typeof value}`)
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as UnknownRecord)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

export function strategySignalArtifactHash(payload: StrategySignalArtifactPayload) {
  const normalized = normalizePayload(payload)
  return `sha256:${createHash('sha256').update(canonicalJson(normalized)).digest('hex')}`
}

export function createStrategySignalArtifact(payload: StrategySignalArtifactPayload): StrategySignalArtifact {
  const normalized = normalizePayload(payload)
  return deepFreeze({
    ...normalized,
    artifactHash: strategySignalArtifactHash(normalized),
  })
}

export function assertStrategySignalArtifact(value: unknown): StrategySignalArtifact {
  const source = exactRecord(value, 'signal artifact', [
    'schemaVersion',
    'identity',
    'strategyLifecycle',
    'objectModel',
    'symbol',
    'baseTimeframe',
    'marketData',
    'signals',
    'artifactHash',
  ])
  const artifactHash = text(source.artifactHash, 'artifactHash')
  if (!HASH_PATTERN.test(artifactHash)) throw new Error('artifactHash must be a SHA-256 hash')
  const payload = normalizePayload({
    schemaVersion: source.schemaVersion,
    identity: source.identity,
    strategyLifecycle: source.strategyLifecycle,
    objectModel: source.objectModel,
    symbol: source.symbol,
    baseTimeframe: source.baseTimeframe,
    marketData: source.marketData,
    signals: source.signals,
  })
  const expectedHash = strategySignalArtifactHash(payload)
  if (artifactHash !== expectedHash) throw new Error(`signal artifact hash mismatch: expected ${expectedHash}`)
  return deepFreeze({ ...payload, artifactHash })
}
