import {
  createOkxSwapPair,
  formatUsdVolume,
  type Candle,
  type MarketLevels,
  type MarketSnapshot,
  type TradingPair,
} from '@/lib/market-data'
import type { MarketDataProvider } from './types'

type OkxEnvelope<T> = {
  code: string
  msg: string
  data?: T
}

type OkxTicker = {
  instId: string
  last?: string
  open24h?: string
  high24h?: string
  low24h?: string
  volCcy24h?: string
  ts?: string
}

type OkxFundingRate = {
  instId: string
  fundingRate?: string
  nextFundingTime?: string
  fundingTime?: string
}

const OKX_BASE_URL = 'https://www.okx.com'
const CANDLE_LIMIT = '300'
const MONDAY_DAILY_LIMIT = '14'
const OKX_INTERVALS = new Map([
  ['1m', '1m'],
  ['3m', '3m'],
  ['5m', '5m'],
  ['15m', '15m'],
  ['30m', '30m'],
  ['1h', '1H'],
  ['2h', '2H'],
  ['4h', '4H'],
  ['6h', '6H'],
  ['12h', '12H'],
  ['1d', '1D'],
  ['1w', '1W'],
])

function numberFrom(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function normalizeInterval(value: string | null): string {
  const normalized = (value || '15m').toLowerCase()
  return OKX_INTERVALS.has(normalized) ? normalized : '15m'
}

async function requestOkx<T>(path: string, params: Record<string, string>) {
  const url = new URL(path, OKX_BASE_URL)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)

  const response = await fetch(url, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`OKX HTTP ${response.status}`)

  const body = (await response.json()) as OkxEnvelope<T>
  if (body.code !== '0') throw new Error(body.msg || `OKX code ${body.code}`)
  return body.data ?? ([] as T)
}

function withTicker(pair: TradingPair, ticker?: OkxTicker): TradingPair {
  const price = numberFrom(ticker?.last)
  const open24h = numberFrom(ticker?.open24h)
  const high24h = numberFrom(ticker?.high24h)
  const low24h = numberFrom(ticker?.low24h)
  const volume = numberFrom(ticker?.volCcy24h)
  const updatedAt = numberFrom(ticker?.ts)
  const change = price == null || open24h == null || open24h === 0 ? undefined : ((price - open24h) / open24h) * 100

  if (price == null || change == null) return { ...pair, sparkline: [], stale: true }

  return {
    ...pair,
    price,
    change,
    high24h,
    low24h,
    volume: volume == null ? '--' : formatUsdVolume(volume),
    sparkline: [],
    stale: false,
    updatedAt: updatedAt ?? Date.now(),
  }
}

export async function searchOkxSwapPairs(query: string): Promise<TradingPair[]> {
  const normalized = query.trim().toUpperCase().replace('/', '-')
  if (normalized.length < 2) return []

  const tickers = await requestOkx<OkxTicker[]>('/api/v5/market/tickers', { instType: 'SWAP' })
  return tickers
    .filter((ticker) => ticker.instId.endsWith('-USDT-SWAP'))
    .filter((ticker) => ticker.instId.includes(normalized))
    .slice(0, 12)
    .map((ticker) => {
      const pair = createOkxSwapPair(ticker.instId)
      return pair ? withTicker(pair, ticker) : null
    })
    .filter((pair): pair is TradingPair => pair != null)
}

function withFunding(pair: TradingPair, funding?: OkxFundingRate): TradingPair {
  const fundingRate = numberFrom(funding?.fundingRate)
  const nextFundingTime = numberFrom(funding?.nextFundingTime)
  const fundingUpdatedAt = numberFrom(funding?.fundingTime)

  if (fundingRate == null) return pair
  return {
    ...pair,
    fundingRate,
    nextFundingTime,
    fundingUpdatedAt,
  }
}

function normalizeCandles(rows: string[][]): Candle[] {
  return rows
    .map((row) => ({
      time: numberFrom(row[0]) ?? 0,
      open: numberFrom(row[1]) ?? 0,
      high: numberFrom(row[2]) ?? 0,
      low: numberFrom(row[3]) ?? 0,
      close: numberFrom(row[4]) ?? 0,
      volume: numberFrom(row[6]) ?? numberFrom(row[5]) ?? 0,
    }))
    .filter((candle) => candle.time > 0 && candle.open > 0 && candle.high > 0 && candle.low > 0 && candle.close > 0)
    .sort((a, b) => a.time - b.time)
}

function startOfUtcMonday(time: number): number {
  const date = new Date(time)
  const day = date.getUTCDay() || 7
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day + 1)
}

function mondayLevelsFromDailyCandles(candles: Candle[]): MarketLevels | undefined {
  const latest = candles.at(-1)
  if (!latest) return undefined

  const startTime = startOfUtcMonday(latest.time)
  const endTime = startTime + 24 * 60 * 60 * 1000
  const monday = candles.find((candle) => candle.time >= startTime && candle.time < endTime)
  if (!monday) return undefined

  return {
    monday: {
      high: monday.high,
      low: monday.low,
      startTime,
      endTime,
    },
  }
}

export const okxMarketProvider: MarketDataProvider = {
  id: 'okx',
  name: 'OKX Market Data',
  market: 'okx',
  supportedIntervals: new Set(OKX_INTERVALS.keys()),
  normalizeInterval,
  async getSnapshot({ activePair, pairs, interval }) {
    const fetchedAt = Date.now()
    const errors: string[] = []
    let resolvedPairs: TradingPair[] = pairs.map((pair) => ({ ...pair, sparkline: [], stale: true }))
    let resolvedActivePair = resolvedPairs.find((pair) => pair.symbol === activePair.symbol) ?? resolvedPairs[0]
    let candles: Candle[] = []
    let levels: MarketLevels | undefined

    try {
      const tickers = await requestOkx<OkxTicker[]>('/api/v5/market/tickers', { instType: 'SWAP' })
      const byInstrumentId = new Map(tickers.map((ticker) => [ticker.instId, ticker]))
      resolvedPairs = pairs.map((pair) => withTicker(pair, byInstrumentId.get(pair.instrumentId)))
      resolvedActivePair = resolvedPairs.find((pair) => pair.symbol === activePair.symbol) ?? resolvedPairs[0]
    } catch (error) {
      errors.push(`tickers: ${error instanceof Error ? error.message : 'unknown error'}`)
    }

    try {
      const rows = await requestOkx<string[][]>('/api/v5/market/candles', {
        instId: activePair.instrumentId,
        bar: OKX_INTERVALS.get(interval) ?? '15m',
        limit: CANDLE_LIMIT,
      })
      candles = normalizeCandles(rows)
      const sparkline = candles.slice(-32).map((candle) => candle.close)
      resolvedActivePair = { ...resolvedActivePair, sparkline }
      resolvedPairs = resolvedPairs.map((pair) => (pair.symbol === resolvedActivePair.symbol ? resolvedActivePair : pair))
    } catch (error) {
      errors.push(`candles ${activePair.instrumentId}: ${error instanceof Error ? error.message : 'unknown error'}`)
    }

    try {
      const rows = await requestOkx<string[][]>('/api/v5/market/candles', {
        instId: activePair.instrumentId,
        bar: '1Dutc',
        limit: MONDAY_DAILY_LIMIT,
      })
      levels = mondayLevelsFromDailyCandles(normalizeCandles(rows))
    } catch (error) {
      errors.push(`monday levels ${activePair.instrumentId}: ${error instanceof Error ? error.message : 'unknown error'}`)
    }

    try {
      const rows = await requestOkx<OkxFundingRate[]>('/api/v5/public/funding-rate', {
        instId: activePair.instrumentId,
      })
      resolvedActivePair = withFunding(resolvedActivePair, rows[0])
      resolvedPairs = resolvedPairs.map((pair) => (pair.symbol === resolvedActivePair.symbol ? resolvedActivePair : pair))
    } catch (error) {
      errors.push(`funding ${activePair.instrumentId}: ${error instanceof Error ? error.message : 'unknown error'}`)
    }

    return {
      ok: errors.length === 0,
      activeSymbol: activePair.symbol,
      timeframe: interval,
      pairs: resolvedPairs,
      activePair: resolvedActivePair,
      candles,
      levels,
      source: {
        name: this.name,
        market: this.market,
        contractType: activePair.contractType,
        status: errors.length === 0 ? 'live' : 'partial',
        fetchedAt,
        errors,
      },
    }
  },
}
