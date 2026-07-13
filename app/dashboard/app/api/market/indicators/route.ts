import { NextResponse, type NextRequest } from 'next/server'
import {
  createOkxSwapPair,
  mergeTradingPairs,
  TRADING_PAIRS,
  type IndicatorSnapshot,
  type TradingPair,
} from '@/lib/market-data'
import { getMarketDataProvider, resolveTradingPair } from '@/lib/server/market-providers'
import { calculateTechnicalIndicators } from '@/lib/server/technical-indicators/calculate'
import { getWatchlistSnapshot } from '@/lib/server/watchlist'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CACHE_TTL_MS = 12_000
const ERROR_CACHE_TTL_MS = 3_000
const indicatorCache = new Map<string, { expiresAt: number; payload: IndicatorSnapshot }>()

async function pairsFromRequest(url: URL) {
  const instruments = (url.searchParams.get('instruments') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map(createOkxSwapPair)
    .filter((pair): pair is TradingPair => pair != null)

  if (instruments.length === 0) return (await getWatchlistSnapshot()).pairs
  return mergeTradingPairs([...TRADING_PAIRS, ...instruments])
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const provider = getMarketDataProvider(url.searchParams.get('provider') ?? 'okx')
  const pairs = await pairsFromRequest(url)
  const activePair = resolveTradingPair(pairs, url.searchParams.get('symbol'))
  const interval = provider.normalizeInterval(url.searchParams.get('interval'))
  const cacheKey = `${provider.id}:${activePair.symbol}:${interval}`
  const cached = indicatorCache.get(cacheKey)

  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.payload, { headers: { 'Cache-Control': 'no-store' } })
  }

  let payload: IndicatorSnapshot
  try {
    const candles = await provider.getCandles({ pair: activePair, interval, limit: 300 })
    const indicators = calculateTechnicalIndicators(candles)
    const errors: string[] = []
    if (indicators.rsi.length === 0) errors.push('RSI14 数据不足')
    if (indicators.macd.length === 0) errors.push('MACD 数据不足')
    payload = {
      ok: errors.length === 0,
      activeSymbol: activePair.symbol,
      timeframe: interval,
      indicators,
      source: {
        name: '行情指标',
        status: errors.length === 0 ? 'live' : 'partial',
        fetchedAt: Date.now(),
        errors,
      },
    }
  } catch (error) {
    payload = {
      ok: false,
      activeSymbol: activePair.symbol,
      timeframe: interval,
      indicators: { rsi: [], macd: [] },
      source: {
        name: '行情指标',
        status: 'offline',
        fetchedAt: Date.now(),
        errors: [error instanceof Error ? error.message : '指标源不可用'],
      },
    }
  }

  indicatorCache.set(cacheKey, {
    expiresAt: Date.now() + (payload.ok ? CACHE_TTL_MS : ERROR_CACHE_TTL_MS),
    payload,
  })

  return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } })
}
