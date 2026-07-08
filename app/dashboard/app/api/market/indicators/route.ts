import { NextResponse, type NextRequest } from 'next/server'
import {
  createOkxSwapPair,
  mergeTradingPairs,
  TRADING_PAIRS,
  type IndicatorSnapshot,
  type TradingPair,
} from '@/lib/market-data'
import { getMarketDataProvider, resolveTradingPair } from '@/lib/server/market-providers'
import { emptyIndicatorSnapshot, getFreqtradeIndicators } from '@/lib/server/technical-indicators/freqtrade'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CACHE_TTL_MS = 12_000
const ERROR_CACHE_TTL_MS = 3_000
const indicatorCache = new Map<string, { expiresAt: number; payload: IndicatorSnapshot }>()

function pairsFromRequest(url: URL) {
  const instruments = (url.searchParams.get('instruments') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map(createOkxSwapPair)
    .filter((pair): pair is TradingPair => pair != null)

  return mergeTradingPairs([...TRADING_PAIRS, ...instruments])
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const provider = getMarketDataProvider(url.searchParams.get('provider') ?? 'okx')
  const pairs = pairsFromRequest(url)
  const activePair = resolveTradingPair(pairs, url.searchParams.get('symbol'))
  const interval = provider.normalizeInterval(url.searchParams.get('interval'))
  const cacheKey = `${provider.id}:${activePair.symbol}:${interval}`
  const cached = indicatorCache.get(cacheKey)

  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.payload, { headers: { 'Cache-Control': 'no-store' } })
  }

  let payload: IndicatorSnapshot
  try {
    payload = await getFreqtradeIndicators({ activePair, interval })
  } catch (error) {
    payload = emptyIndicatorSnapshot({ activePair, interval, error })
  }

  indicatorCache.set(cacheKey, {
    expiresAt: Date.now() + (payload.ok ? CACHE_TTL_MS : ERROR_CACHE_TTL_MS),
    payload,
  })

  return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } })
}
