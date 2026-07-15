import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const MARKET_DATASET_SCHEMA_VERSION = 'helix.market-dataset/v1';

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TIMEFRAME_PATTERN = /^(\d+)([mhdw])$/;
const TIMEFRAME_UNITS_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

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

function finite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
}

export function marketTimeframeMilliseconds(value) {
  const timeframe = text(value, 'timeframe');
  const match = TIMEFRAME_PATTERN.exec(timeframe);
  if (!match || Number(match[1]) < 1) throw new Error(`invalid timeframe ${timeframe}`);
  const duration = Number(match[1]) * TIMEFRAME_UNITS_MS[match[2]];
  if (!Number.isSafeInteger(duration)) throw new Error(`timeframe ${timeframe} is too large`);
  return duration;
}

function normalizeCandle(value, name, duration) {
  const source = exactRecord(value, name, ['time', 'open', 'high', 'low', 'close', 'volume']);
  const candle = {
    time: integer(source.time, `${name}.time`),
    open: finite(source.open, `${name}.open`),
    high: finite(source.high, `${name}.high`),
    low: finite(source.low, `${name}.low`),
    close: finite(source.close, `${name}.close`),
    volume: finite(source.volume, `${name}.volume`),
  };
  if (candle.time % duration) throw new Error(`${name}.time must align to its timeframe`);
  if (candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0 || candle.volume < 0) {
    throw new Error(`${name} contains invalid OHLCV values`);
  }
  if (candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close)) {
    throw new Error(`${name} has incoherent OHLC values`);
  }
  return candle;
}

function normalizePayload(value) {
  const source = exactRecord(value, 'historical dataset payload', [
    'schemaVersion', 'source', 'capturedThrough', 'timeframes',
  ]);
  if (source.schemaVersion !== MARKET_DATASET_SCHEMA_VERSION) {
    throw new Error(`unsupported historical dataset schema ${String(source.schemaVersion)}`);
  }
  const sourceRecord = exactRecord(source.source, 'source', ['provider', 'market', 'instrumentId', 'symbol']);
  const normalizedSource = {
    provider: text(sourceRecord.provider, 'source.provider'),
    market: text(sourceRecord.market, 'source.market'),
    instrumentId: text(sourceRecord.instrumentId, 'source.instrumentId'),
    symbol: text(sourceRecord.symbol, 'source.symbol'),
  };
  const capturedThrough = integer(source.capturedThrough, 'capturedThrough');
  if (!source.timeframes || typeof source.timeframes !== 'object' || Array.isArray(source.timeframes)) {
    throw new Error('timeframes must be an object');
  }
  const entries = Object.entries(source.timeframes).sort(([left], [right]) => left.localeCompare(right));
  if (!entries.length) throw new Error('timeframes must not be empty');
  const timeframes = {};
  for (const [timeframe, value] of entries) {
    const duration = marketTimeframeMilliseconds(timeframe);
    if (!Array.isArray(value) || !value.length) throw new Error(`timeframes.${timeframe} must be a non-empty array`);
    const candles = value.map((candle, index) => normalizeCandle(
      candle,
      `timeframes.${timeframe}[${index}]`,
      duration,
    ));
    for (let index = 1; index < candles.length; index += 1) {
      if (candles[index].time - candles[index - 1].time !== duration) {
        throw new Error(`timeframes.${timeframe} contains a gap before index ${index}`);
      }
    }
    if (candles.at(-1).time + duration > capturedThrough) {
      throw new Error(`timeframes.${timeframe} contains a candle not closed by capturedThrough`);
    }
    timeframes[timeframe] = candles;
  }
  return {
    schemaVersion: MARKET_DATASET_SCHEMA_VERSION,
    source: normalizedSource,
    capturedThrough,
    timeframes,
  };
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical historical datasets require finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  throw new Error(`unsupported canonical JSON value ${typeof value}`);
}

export function marketDatasetHash(payload) {
  const normalized = normalizePayload(payload);
  return `sha256:${createHash('sha256').update(canonicalJson(normalized)).digest('hex')}`;
}

export function verifyMarketDataset(value) {
  const source = exactRecord(value, 'historical dataset', [
    'schemaVersion', 'source', 'capturedThrough', 'timeframes', 'datasetHash',
  ]);
  const datasetHash = text(source.datasetHash, 'datasetHash');
  if (!HASH_PATTERN.test(datasetHash)) throw new Error('datasetHash must be a SHA-256 hash');
  const payload = normalizePayload({
    schemaVersion: source.schemaVersion,
    source: source.source,
    capturedThrough: source.capturedThrough,
    timeframes: source.timeframes,
  });
  const expectedHash = marketDatasetHash(payload);
  if (datasetHash !== expectedHash) throw new Error(`historical dataset hash mismatch: expected ${expectedHash}`);
  return { ...payload, datasetHash };
}

export function loadMarketDataset(file) {
  try {
    return verifyMarketDataset(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    throw new Error(`cannot read market dataset ${file}: ${error.message}`);
  }
}

export function freqtradeOhlcvFile(dataset, timeframe) {
  const candles = dataset.timeframes[timeframe];
  if (!candles) throw new Error(`market dataset is missing base timeframe ${timeframe}`);
  if (dataset.source.market !== 'futures') {
    throw new Error(`unsupported market dataset market ${dataset.source.market}; expected futures`);
  }
  const pair = ['/', ' ', '.', '@', '$', '+', ':'].reduce(
    (filename, character) => filename.replaceAll(character, '_'),
    dataset.source.symbol,
  );
  const content = `${JSON.stringify(candles.map((candle) => [
    candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume,
  ]))}\n`;
  return {
    relativePath: `futures/${pair}-${timeframe}-futures.json`,
    content,
    dataHash: `sha256:${createHash('sha256').update(content).digest('hex')}`,
  };
}
