import type { Candle } from '@helix/contracts/market'
import type { StrategyHistoricalDataset } from '@helix/contracts/strategy'
import { createStrategyHistoricalDataset } from './historical-dataset'
import { strategyTimeframeMilliseconds } from './signal-artifact'

const OKX_HISTORY_URL = 'https://www.okx.com/api/v5/market/history-candles'
const PAGE_LIMIT = 300
const OKX_BARS: Record<string, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1H',
  '4h': '4H',
  '1d': '1Dutc',
}

type OkxResponse = {
  code: string
  msg?: string
  data?: string[][]
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

function finiteNumber(value: unknown, field: string) {
  const number = typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(number)) throw new Error(`${field} must be numeric`)
  return number
}

function normalizeRow(row: string[], timeframe: string): Candle | null {
  if (!Array.isArray(row) || row.length < 9) throw new Error(`OKX ${timeframe} returned an incomplete candle row`)
  if (row[8] !== '1') return null
  return {
    time: finiteNumber(row[0], `${timeframe}.time`),
    open: finiteNumber(row[1], `${timeframe}.open`),
    high: finiteNumber(row[2], `${timeframe}.high`),
    low: finiteNumber(row[3], `${timeframe}.low`),
    close: finiteNumber(row[4], `${timeframe}.close`),
    volume: finiteNumber(row[6] || row[5], `${timeframe}.volume`),
  }
}

async function fetchTimeframe(options: {
  instrumentId: string
  timeframe: string
  startTime: number
  endTime: number
  fetchImpl: FetchLike
}) {
  const bar = OKX_BARS[options.timeframe]
  if (!bar) throw new Error(`unsupported OKX historical timeframe ${options.timeframe}`)
  const { duration } = strategyTimeframeMilliseconds(options.timeframe)
  if (options.startTime % duration !== 0 || options.endTime % duration !== 0) {
    throw new Error(`${options.timeframe} history boundaries must align to the timeframe`)
  }
  const byTime = new Map<number, Candle>()
  let cursor = options.endTime
  let priorOldest = Number.POSITIVE_INFINITY

  while (true) {
    const url = new URL(OKX_HISTORY_URL)
    url.searchParams.set('instId', options.instrumentId)
    url.searchParams.set('bar', bar)
    url.searchParams.set('limit', String(PAGE_LIMIT))
    url.searchParams.set('after', String(cursor))
    const response = await options.fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) throw new Error(`OKX historical ${options.timeframe} HTTP ${response.status}`)
    const body = await response.json() as OkxResponse
    if (body.code !== '0') throw new Error(body.msg || `OKX historical ${options.timeframe} code ${body.code}`)
    const rows = body.data ?? []
    if (rows.length === 0) break
    let oldest = Number.POSITIVE_INFINITY
    for (const row of rows) {
      const candle = normalizeRow(row, options.timeframe)
      if (!candle) continue
      oldest = Math.min(oldest, candle.time)
      if (candle.time >= options.startTime && candle.time + duration <= options.endTime) {
        byTime.set(candle.time, candle)
      }
    }
    if (!Number.isFinite(oldest)) throw new Error(`OKX historical ${options.timeframe} page contained no closed candles`)
    if (oldest <= options.startTime) break
    if (oldest >= priorOldest) throw new Error(`OKX historical ${options.timeframe} pagination did not move backward`)
    priorOldest = oldest
    cursor = oldest
  }

  const candles = [...byTime.values()].sort((left, right) => left.time - right.time)
  if (candles.length === 0) throw new Error(`OKX returned no closed ${options.timeframe} candles in the requested window`)
  return candles
}

export async function fetchOkxHistoricalDataset(options: {
  instrumentId: string
  symbol: string
  timeframes: readonly string[]
  startTime: number
  endTime: number
  fetchImpl?: FetchLike
}): Promise<StrategyHistoricalDataset> {
  if (!options.instrumentId.trim() || !options.symbol.trim()) throw new Error('instrumentId and symbol are required')
  if (!Number.isSafeInteger(options.startTime) || !Number.isSafeInteger(options.endTime)
    || options.startTime < 0 || options.endTime <= options.startTime) {
    throw new Error('historical startTime/endTime must be an increasing integer range')
  }
  const timeframes = [...new Set(options.timeframes)]
  if (timeframes.length === 0) throw new Error('at least one historical timeframe is required')
  const fetchImpl = options.fetchImpl ?? fetch
  const series: Record<string, Candle[]> = {}
  for (const timeframe of timeframes) {
    series[timeframe] = await fetchTimeframe({
      instrumentId: options.instrumentId,
      timeframe,
      startTime: options.startTime,
      endTime: options.endTime,
      fetchImpl,
    })
  }
  return createStrategyHistoricalDataset({
    schemaVersion: 'helix.market-dataset/v1',
    source: {
      provider: 'okx',
      market: 'futures',
      instrumentId: options.instrumentId,
      symbol: options.symbol,
    },
    capturedThrough: options.endTime,
    timeframes: series,
  })
}
