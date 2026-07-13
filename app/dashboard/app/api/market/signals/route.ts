import { NextResponse, type NextRequest } from 'next/server'
import {
  createOkxSwapPair,
  mergeTradingPairs,
  TRADING_PAIRS,
  type IntradaySignalSnapshot,
  type TradingPair,
} from '@/lib/market-data'
import { getMarketDataProvider, resolveTradingPair } from '@/lib/server/market-providers'
import { buildIntradaySignal } from '@/lib/server/signals/intraday'
import { getWatchlistSnapshot } from '@/lib/server/watchlist'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CACHE_TTL_MS = 20_000
const ERROR_CACHE_TTL_MS = 3_000
const signalCache = new Map<string, { expiresAt: number; payload: IntradaySignalSnapshot }>()

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

function errorSnapshot(activePair: TradingPair, providerName: string, error: unknown): IntradaySignalSnapshot {
  const message = error instanceof Error ? error.message : '信号数据源不可用'
  const result = buildIntradaySignal({
    tickSize: 1,
    candles: { '5m': [], '15m': [], '1h': [] },
  })

  return {
    ok: false,
    activeSymbol: activePair.symbol,
    generatedAt: Date.now(),
    ...result,
    source: {
      name: providerName,
      status: 'offline',
      fetchedAt: Date.now(),
      errors: [message],
    },
  }
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const provider = getMarketDataProvider(url.searchParams.get('provider') ?? 'okx')
  const pairs = await pairsFromRequest(url)
  const activePair = resolveTradingPair(pairs, url.searchParams.get('symbol'))
  const cacheKey = `${provider.id}:${activePair.instrumentId}`
  const cached = signalCache.get(cacheKey)

  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.payload, { headers: { 'Cache-Control': 'no-store' } })
  }

  let payload: IntradaySignalSnapshot
  try {
    const [metadata, fiveMinute, fifteenMinute, hourly] = await Promise.all([
      provider.getInstrumentMetadata({ pair: activePair }),
      provider.getCandles({ pair: activePair, interval: '5m', limit: 300, closedOnly: true }),
      provider.getCandles({ pair: activePair, interval: '15m', limit: 300, closedOnly: true }),
      provider.getCandles({ pair: activePair, interval: '1h', limit: 300, closedOnly: true }),
    ])
    const result = buildIntradaySignal({
      tickSize: metadata.tickSize,
      candles: { '5m': fiveMinute, '15m': fifteenMinute, '1h': hourly },
    })
    payload = {
      ok: result.signal.status !== 'insufficient-data',
      activeSymbol: activePair.symbol,
      generatedAt: Date.now(),
      ...result,
      source: {
        name: provider.name,
        status: result.signal.status === 'insufficient-data' ? 'partial' : 'live',
        fetchedAt: Date.now(),
        errors: result.signal.status === 'insufficient-data' ? result.signal.warnings : [],
      },
    }
  } catch (error) {
    payload = errorSnapshot(activePair, provider.name, error)
  }

  signalCache.set(cacheKey, {
    expiresAt: Date.now() + (payload.ok ? CACHE_TTL_MS : ERROR_CACHE_TTL_MS),
    payload,
  })
  return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } })
}
