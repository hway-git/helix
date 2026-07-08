import { NextResponse, type NextRequest } from 'next/server'
import { createOkxSwapPair, mergeTradingPairs, TRADING_PAIRS, type MarketSnapshot, type TradingPair } from '@/lib/market-data'
import { getMarketDataProvider, resolveTradingPair } from '@/lib/server/market-providers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CACHE_TTL_MS = 12_000
const ERROR_CACHE_TTL_MS = 2_000
const snapshotCache = new Map<string, { expiresAt: number; payload: MarketSnapshot }>()

function emptyPair(pair: TradingPair): TradingPair {
  return { ...pair, sparkline: [], stale: true }
}

function pairsFromRequest(url: URL) {
  const instruments = (url.searchParams.get('instruments') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map(createOkxSwapPair)
    .filter((pair): pair is TradingPair => pair != null)

  return mergeTradingPairs([...TRADING_PAIRS, ...instruments])
}

function errorSnapshot({
  activePair,
  pairs,
  interval,
  providerName,
  providerMarket,
  error,
}: {
  activePair: TradingPair
  pairs: TradingPair[]
  interval: string
  providerName: string
  providerMarket: string
  error: unknown
}): MarketSnapshot {
  const emptyPairs = pairs.map(emptyPair)
  return {
    ok: false,
    activeSymbol: activePair.symbol,
    timeframe: interval,
    pairs: emptyPairs,
    activePair: emptyPairs.find((pair) => pair.symbol === activePair.symbol) ?? emptyPairs[0],
    candles: [],
    source: {
      name: providerName,
      market: providerMarket,
      contractType: activePair.contractType,
      status: 'partial',
      fetchedAt: Date.now(),
      errors: [error instanceof Error ? error.message : 'market provider failed'],
    },
  }
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const provider = getMarketDataProvider(url.searchParams.get('provider') ?? 'okx')
  const pairs = pairsFromRequest(url)
  const activePair = resolveTradingPair(pairs, url.searchParams.get('symbol'))
  const interval = provider.normalizeInterval(url.searchParams.get('interval'))
  const cacheKey = `${provider.id}:${activePair.symbol}:${interval}:${pairs.map((pair) => pair.instrumentId).join(',')}`
  const cached = snapshotCache.get(cacheKey)

  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.payload, { headers: { 'Cache-Control': 'no-store' } })
  }

  let payload: MarketSnapshot
  try {
    payload = await provider.getSnapshot({ activePair, pairs, interval })
  } catch (error) {
    payload = errorSnapshot({
      activePair,
      pairs,
      interval,
      providerName: provider.name,
      providerMarket: provider.market,
      error,
    })
  }

  snapshotCache.set(cacheKey, {
    expiresAt: Date.now() + (payload.ok ? CACHE_TTL_MS : ERROR_CACHE_TTL_MS),
    payload,
  })

  return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } })
}
