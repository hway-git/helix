import { createHash } from 'node:crypto'
import type { Candle } from '@helix/contracts/market'
import {
  STRATEGY_HISTORICAL_DATASET_SCHEMA_VERSION,
  type StrategyHistoricalDataset,
  type StrategyHistoricalDatasetPayload,
} from '@helix/contracts/strategy'
import { strategyTimeframeMilliseconds } from './signal-artifact'

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/
type UnknownRecord = Record<string, unknown>

function exactRecord(value: unknown, name: string, fields: readonly string[]): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new Error(`${name} must contain exactly: ${fields.join(', ')}`)
  }
  return value as UnknownRecord
}

function text(value: unknown, name: string) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new Error(`${name} must be a non-empty trimmed string`)
  }
  return value
}

function integer(value: unknown, name: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${name} must be a non-negative safe integer`)
  return value as number
}

function number(value: unknown, name: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be finite`)
  return value
}

function normalizeCandle(value: unknown, name: string, duration: number): Candle {
  const source = exactRecord(value, name, ['time', 'open', 'high', 'low', 'close', 'volume'])
  const candle = {
    time: integer(source.time, `${name}.time`),
    open: number(source.open, `${name}.open`),
    high: number(source.high, `${name}.high`),
    low: number(source.low, `${name}.low`),
    close: number(source.close, `${name}.close`),
    volume: number(source.volume, `${name}.volume`),
  }
  if (candle.time % duration !== 0) throw new Error(`${name}.time must align to its timeframe`)
  if (candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0 || candle.volume < 0) {
    throw new Error(`${name} contains invalid OHLCV values`)
  }
  if (candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close)) {
    throw new Error(`${name} has incoherent OHLC values`)
  }
  return candle
}

function normalizePayload(value: unknown): StrategyHistoricalDatasetPayload {
  const source = exactRecord(value, 'historical dataset payload', [
    'schemaVersion', 'source', 'capturedThrough', 'timeframes',
  ])
  if (source.schemaVersion !== STRATEGY_HISTORICAL_DATASET_SCHEMA_VERSION) {
    throw new Error(`unsupported historical dataset schema ${String(source.schemaVersion)}`)
  }
  const sourceRecord = exactRecord(source.source, 'source', ['provider', 'market', 'instrumentId', 'symbol'])
  const normalizedSource = {
    provider: text(sourceRecord.provider, 'source.provider'),
    market: text(sourceRecord.market, 'source.market'),
    instrumentId: text(sourceRecord.instrumentId, 'source.instrumentId'),
    symbol: text(sourceRecord.symbol, 'source.symbol'),
  }
  const capturedThrough = integer(source.capturedThrough, 'capturedThrough')
  const timeframeRecord = source.timeframes
  if (!timeframeRecord || typeof timeframeRecord !== 'object' || Array.isArray(timeframeRecord)) {
    throw new Error('timeframes must be an object')
  }
  const timeframeEntries = Object.entries(timeframeRecord as UnknownRecord).sort(([left], [right]) => left.localeCompare(right))
  if (timeframeEntries.length === 0) throw new Error('timeframes must not be empty')
  const timeframes: Record<string, Candle[]> = {}
  for (const [timeframe, value] of timeframeEntries) {
    const { duration } = strategyTimeframeMilliseconds(timeframe)
    if (!Array.isArray(value) || value.length === 0) throw new Error(`timeframes.${timeframe} must be a non-empty array`)
    const candles = value.map((candle, index) => normalizeCandle(candle, `timeframes.${timeframe}[${index}]`, duration))
    for (let index = 1; index < candles.length; index += 1) {
      if (candles[index]!.time - candles[index - 1]!.time !== duration) {
        throw new Error(`timeframes.${timeframe} contains a gap before index ${index}`)
      }
    }
    if (candles.at(-1)!.time + duration > capturedThrough) {
      throw new Error(`timeframes.${timeframe} contains a candle not closed by capturedThrough`)
    }
    timeframes[timeframe] = candles
  }
  return {
    schemaVersion: STRATEGY_HISTORICAL_DATASET_SCHEMA_VERSION,
    source: normalizedSource,
    capturedThrough,
    timeframes,
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical historical datasets require finite numbers')
    return JSON.stringify(value)
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

export function strategyHistoricalDatasetHash(payload: StrategyHistoricalDatasetPayload) {
  const normalized = normalizePayload(payload)
  return `sha256:${createHash('sha256').update(canonicalJson(normalized)).digest('hex')}`
}

export function createStrategyHistoricalDataset(payload: StrategyHistoricalDatasetPayload): StrategyHistoricalDataset {
  const normalized = normalizePayload(payload)
  return deepFreeze({ ...normalized, datasetHash: strategyHistoricalDatasetHash(normalized) })
}

export function assertStrategyHistoricalDataset(value: unknown): StrategyHistoricalDataset {
  const source = exactRecord(value, 'historical dataset', [
    'schemaVersion', 'source', 'capturedThrough', 'timeframes', 'datasetHash',
  ])
  const datasetHash = text(source.datasetHash, 'datasetHash')
  if (!HASH_PATTERN.test(datasetHash)) throw new Error('datasetHash must be a SHA-256 hash')
  const payload = normalizePayload({
    schemaVersion: source.schemaVersion,
    source: source.source,
    capturedThrough: source.capturedThrough,
    timeframes: source.timeframes,
  })
  const expectedHash = strategyHistoricalDatasetHash(payload)
  if (datasetHash !== expectedHash) throw new Error(`historical dataset hash mismatch: expected ${expectedHash}`)
  return deepFreeze({ ...payload, datasetHash })
}
