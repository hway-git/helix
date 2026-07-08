'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { LeftSidebar } from '@/components/trading/left-sidebar'
import { CenterPanel } from '@/components/trading/center-panel'
import { AgentChat } from '@/components/trading/agent-chat'
import { BottomWorkbench } from '@/components/trading/bottom-workbench'
import { TerminalStatusBar } from '@/components/trading/terminal-status-bar'
import {
  createOkxSwapPair,
  formatPrice,
  formatUsdVolume,
  mergeTradingPairs,
  TRADING_PAIRS,
  type Candle,
  type IndicatorSnapshot,
  type MarketSnapshot,
  type TradingPair,
} from '@/lib/market-data'
import { useOkxMarketStream, type OkxCandleUpdate, type OkxTickerUpdate } from '@/hooks/use-okx-market-stream'
import { cn } from '@/lib/utils'

const MARKET_FALLBACK_REFRESH_MS = 120_000
const INDICATOR_REFRESH_MS = 60_000
const MAX_CANDLES = 500
const WATCHLIST_STORAGE_KEY = 'helix.watchlist.instruments'

function toApiInterval(timeframe: string) {
  return timeframe.toLowerCase()
}

function mergeCandle(candles: Candle[], update: OkxCandleUpdate) {
  const nextCandle: Candle = {
    time: update.time,
    open: update.open,
    high: update.high,
    low: update.low,
    close: update.close,
    volume: update.volume,
  }
  const index = candles.findIndex((candle) => candle.time === update.time)

  if (index >= 0) {
    const next = candles.slice()
    next[index] = nextCandle
    return next
  }

  return [...candles, nextCandle].sort((a, b) => a.time - b.time).slice(-MAX_CANDLES)
}

function pairWithTickerUpdate(pair: TradingPair, update: OkxTickerUpdate): TradingPair {
  const price = update.price ?? pair.price
  const open24h = update.open24h
  const change = open24h == null || open24h === 0 ? pair.change : ((price - open24h) / open24h) * 100

  return {
    ...pair,
    price,
    change,
    high24h: update.high24h ?? pair.high24h,
    low24h: update.low24h ?? pair.low24h,
    volume: update.volume24h == null ? pair.volume : formatUsdVolume(update.volume24h),
    updatedAt: update.updatedAt,
    stale: false,
  }
}

export default function Page() {
  const [activeSymbol, setActiveSymbol] = useState('BTC/USDT')
  const [timeframe, setTimeframe] = useState('15m')
  const [watchlistPairs, setWatchlistPairs] = useState<TradingPair[]>(TRADING_PAIRS)
  const [consoleCollapsed, setConsoleCollapsed] = useState(false)
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null)
  const [indicatorSnapshot, setIndicatorSnapshot] = useState<IndicatorSnapshot | null>(null)
  const [marketLoading, setMarketLoading] = useState(true)
  const [marketError, setMarketError] = useState<string | null>(null)
  const [indicatorLoading, setIndicatorLoading] = useState(true)
  const [indicatorError, setIndicatorError] = useState<string | null>(null)
  const instrumentsParam = useMemo(
    () => watchlistPairs.map((pair) => pair.instrumentId).join(','),
    [watchlistPairs],
  )

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(WATCHLIST_STORAGE_KEY)
      if (!saved) return

      const instruments = JSON.parse(saved)
      if (!Array.isArray(instruments)) return

      const savedPairs = instruments
        .filter((value): value is string => typeof value === 'string')
        .map(createOkxSwapPair)
        .filter((pair): pair is TradingPair => pair != null)

      if (savedPairs.length > 0) {
        setWatchlistPairs(mergeTradingPairs([...TRADING_PAIRS, ...savedPairs]))
      }
    } catch {
      // Ignore invalid local watchlist state.
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let controller: AbortController | null = null

    const loadMarket = async (showLoading = true) => {
      controller?.abort()
      controller = new AbortController()
      if (showLoading) setMarketLoading(true)

      try {
        const params = new URLSearchParams({
          provider: 'okx',
          symbol: activeSymbol,
          interval: toApiInterval(timeframe),
          instruments: instrumentsParam,
        })
        const response = await fetch(`/api/market/snapshot?${params.toString()}`, {
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`行情接口 HTTP ${response.status}`)
        const nextSnapshot = (await response.json()) as MarketSnapshot
        if (disposed) return
        setSnapshot(nextSnapshot)
        setMarketError(nextSnapshot.source.errors[0] ?? null)
      } catch (error) {
        if (disposed || (error instanceof DOMException && error.name === 'AbortError')) return
        setMarketError(error instanceof Error ? error.message : '行情接口不可用')
      } finally {
        if (!disposed && showLoading) setMarketLoading(false)
      }
    }

    void loadMarket()
    const timer = window.setInterval(() => void loadMarket(false), MARKET_FALLBACK_REFRESH_MS)

    return () => {
      disposed = true
      controller?.abort()
      window.clearInterval(timer)
    }
  }, [activeSymbol, instrumentsParam, timeframe])

  useEffect(() => {
    let disposed = false
    let controller: AbortController | null = null

    const loadIndicators = async (showLoading = true) => {
      controller?.abort()
      controller = new AbortController()
      if (showLoading) setIndicatorLoading(true)

      try {
        const params = new URLSearchParams({
          provider: 'okx',
          symbol: activeSymbol,
          interval: toApiInterval(timeframe),
          instruments: instrumentsParam,
        })
        const response = await fetch(`/api/market/indicators?${params.toString()}`, {
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`指标接口 HTTP ${response.status}`)
        const nextSnapshot = (await response.json()) as IndicatorSnapshot
        if (disposed) return
        setIndicatorSnapshot(nextSnapshot)
        setIndicatorError(nextSnapshot.source.status === 'offline' ? (nextSnapshot.source.errors[0] ?? null) : null)
      } catch (error) {
        if (disposed || (error instanceof DOMException && error.name === 'AbortError')) return
        setIndicatorError(error instanceof Error ? error.message : '指标接口不可用')
      } finally {
        if (!disposed && showLoading) setIndicatorLoading(false)
      }
    }

    void loadIndicators()
    const timer = window.setInterval(() => void loadIndicators(false), INDICATOR_REFRESH_MS)

    return () => {
      disposed = true
      controller?.abort()
      window.clearInterval(timer)
    }
  }, [activeSymbol, instrumentsParam, timeframe])

  const snapshotMatches = snapshot?.activeSymbol === activeSymbol && snapshot.timeframe === toApiInterval(timeframe)
  const pairs = snapshot?.pairs?.length ? mergeTradingPairs([...watchlistPairs, ...snapshot.pairs]) : watchlistPairs
  const activePair = useMemo(
    () => (snapshotMatches ? snapshot.activePair : pairs.find((pair) => pair.symbol === activeSymbol)) ?? pairs[0],
    [activeSymbol, pairs, snapshot, snapshotMatches],
  )
  const candles = snapshotMatches ? snapshot.candles : []
  const levels = snapshotMatches ? snapshot.levels : undefined
  const indicatorMatches = indicatorSnapshot?.activeSymbol === activeSymbol && indicatorSnapshot.timeframe === toApiInterval(timeframe)
  const indicators = indicatorMatches ? indicatorSnapshot.indicators : undefined

  useEffect(() => {
    const price = formatPrice(activePair.price)
    const change = Number.isFinite(activePair.change)
      ? ` ${activePair.change >= 0 ? '+' : ''}${activePair.change.toFixed(2)}%`
      : ''
    document.title = price === '--'
      ? `${activePair.symbol} · Helix`
      : `${activePair.symbol} ${price}${change} · Helix`
  }, [activePair.change, activePair.price, activePair.symbol])

  const handleAddPair = useCallback((pair: TradingPair) => {
    setWatchlistPairs((current) => {
      const next = mergeTradingPairs([...current, pair])
      window.localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(next.map((item) => item.instrumentId)))
      return next
    })
    setActiveSymbol(pair.symbol)
  }, [])

  const handleTickerUpdate = useCallback((update: OkxTickerUpdate) => {
    setSnapshot((current) => {
      if (!current) return current

      const pairs = current.pairs.map((pair) =>
        pair.instrumentId === update.instrumentId ? pairWithTickerUpdate(pair, update) : pair,
      )
      const activePair =
        current.activePair.instrumentId === update.instrumentId
          ? pairWithTickerUpdate(current.activePair, update)
          : current.activePair

      return {
        ...current,
        pairs,
        activePair,
        source: {
          ...current.source,
          status: current.source.errors.length === 0 ? 'live' : current.source.status,
          fetchedAt: update.updatedAt,
        },
      }
    })
  }, [])

  const handleCandleUpdate = useCallback((update: OkxCandleUpdate) => {
    setSnapshot((current) => {
      if (!current || current.activePair.instrumentId !== update.instrumentId) return current

      const candles = mergeCandle(current.candles, update)
      const sparkline = candles.slice(-32).map((candle) => candle.close)
      const activePair: TradingPair = {
        ...current.activePair,
        price: update.close,
        sparkline,
        updatedAt: update.time,
        stale: false,
      }
      const pairs = current.pairs.map((pair) =>
        pair.instrumentId === update.instrumentId
          ? { ...pair, price: update.close, sparkline, updatedAt: update.time, stale: false }
          : pair,
      )

      return {
        ...current,
        candles,
        pairs,
        activePair,
        source: {
          ...current.source,
          status: current.source.errors.length === 0 ? 'live' : current.source.status,
          fetchedAt: Date.now(),
        },
      }
    })
  }, [])

  useOkxMarketStream({
    pairs,
    activePair,
    timeframe,
    onTicker: handleTickerUpdate,
    onCandle: handleCandleUpdate,
  })

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <TerminalStatusBar source={snapshot?.source ?? null} loading={marketLoading} error={marketError} />

      <div className="flex min-h-0 flex-1 flex-col">
        <div
          className={cn(
            'grid min-h-0 flex-1 grid-cols-1',
            consoleCollapsed
              ? 'lg:grid-cols-[280px_minmax(0,1fr)_48px] xl:grid-cols-[300px_minmax(0,1fr)_48px]'
              : 'lg:grid-cols-[280px_minmax(0,1fr)_360px] xl:grid-cols-[300px_minmax(0,1fr)_390px]',
          )}
        >
          <div className="hidden min-h-0 border-r border-border lg:block">
            <LeftSidebar
              pairs={pairs}
              activeSymbol={activeSymbol}
              loading={marketLoading}
              onSelect={setActiveSymbol}
              onAddPair={handleAddPair}
            />
          </div>

          <main className="min-h-0 overflow-hidden">
            <CenterPanel
              pair={activePair}
              candles={candles}
              timeframe={timeframe}
              loading={marketLoading && !snapshotMatches}
              error={marketError}
              levels={levels}
              indicators={indicators}
              indicatorLoading={indicatorLoading && !indicatorMatches}
              indicatorError={indicatorError}
              onTimeframeChange={setTimeframe}
            />
          </main>

          <div className="hidden min-h-0 border-l border-border lg:block">
            <AgentChat collapsed={consoleCollapsed} onCollapsedChange={setConsoleCollapsed} />
          </div>
        </div>

        <BottomWorkbench />
      </div>
    </div>
  )
}
