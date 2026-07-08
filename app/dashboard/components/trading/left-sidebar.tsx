'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, Bot, LoaderCircle, Newspaper, Plus, Search, Star } from 'lucide-react'
import { Sparkline } from '@/components/charts/sparkline'
import { formatPrice, type TradingPair } from '@/lib/market-data'
import { cn } from '@/lib/utils'

type InfoTab = 'signals' | 'strategies' | 'news'

const INFO_PANEL_FALLBACK_HEIGHT = 236
const INFO_PANEL_DEFAULT_RATIO = 0.5
const PAIR_LIST_HEADER_HEIGHT = 74
const PAIR_ROW_HEIGHT = 44
const PAIRS_VISIBLE_WHEN_PANEL_MIN = 10
const PAIRS_VISIBLE_WHEN_PANEL_MAX = 5

const infoTabs: Array<{ id: InfoTab; label: string; icon: React.ElementType }> = [
  { id: 'signals', label: '信号', icon: Activity },
  { id: 'strategies', label: '策略', icon: Bot },
  { id: 'news', label: '新闻', icon: Newspaper },
]

function SectionTitle({ icon, title, extra }: { icon: React.ReactNode; title: string; extra?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-3 py-2">
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase leading-none tracking-wider text-muted-foreground">
        <span className="flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3.5">{icon}</span>
        <span>{title}</span>
      </div>
      {extra}
    </div>
  )
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center px-3 text-center text-xs text-muted-foreground">
      {label}
    </div>
  )
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

export function LeftSidebar({
  pairs,
  activeSymbol,
  loading,
  onSelect,
  onAddPair,
}: {
  pairs: TradingPair[]
  activeSymbol: string
  loading: boolean
  onSelect: (symbol: string) => void
  onAddPair: (pair: TradingPair) => void
}) {
  const [query, setQuery] = useState('')
  const [infoTab, setInfoTab] = useState<InfoTab>('signals')
  const [infoHeight, setInfoHeight] = useState<number | null>(null)
  const [searchResults, setSearchResults] = useState<TradingPair[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null)
  const userResizedRef = useRef(false)

  const filteredPairs = useMemo(
    () => pairs.filter((p) => p.symbol.toLowerCase().includes(query.toLowerCase())),
    [pairs, query],
  )
  const knownInstruments = useMemo(() => new Set(pairs.map((pair) => pair.instrumentId)), [pairs])
  const externalResults = useMemo(
    () => searchResults.filter((pair) => !knownInstruments.has(pair.instrumentId)),
    [knownInstruments, searchResults],
  )

  useEffect(() => {
    const normalized = query.trim()
    if (normalized.length < 2) {
      setSearchResults([])
      setSearchError(null)
      setSearching(false)
      return
    }

    let disposed = false
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setSearching(true)
      setSearchError(null)

      try {
        const response = await fetch(`/api/market/search?q=${encodeURIComponent(normalized)}`, {
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`搜索接口 HTTP ${response.status}`)
        const payload = (await response.json()) as { ok: boolean; pairs?: TradingPair[]; error?: string }
        if (disposed) return
        setSearchResults(payload.pairs ?? [])
        setSearchError(payload.ok ? null : payload.error ?? 'OKX 搜索不可用')
      } catch (error) {
        if (disposed || (error instanceof DOMException && error.name === 'AbortError')) return
        setSearchError(error instanceof Error ? error.message : 'OKX 搜索不可用')
      } finally {
        if (!disposed) setSearching(false)
      }
    }, 250)

    return () => {
      disposed = true
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [query])

  const getInfoPanelBounds = () => {
    const sidebarHeight = sidebarRef.current?.getBoundingClientRect().height ?? 0
    if (!sidebarHeight) return { min: INFO_PANEL_FALLBACK_HEIGHT, max: INFO_PANEL_FALLBACK_HEIGHT }

    const panelMin = sidebarHeight - PAIR_LIST_HEADER_HEIGHT - PAIR_ROW_HEIGHT * PAIRS_VISIBLE_WHEN_PANEL_MIN
    const panelMax = sidebarHeight - PAIR_LIST_HEADER_HEIGHT - PAIR_ROW_HEIGHT * PAIRS_VISIBLE_WHEN_PANEL_MAX
    return {
      min: Math.max(96, Math.min(panelMin, panelMax)),
      max: Math.max(96, Math.max(panelMin, panelMax)),
    }
  }

  const getDefaultInfoHeight = () => {
    const sidebarHeight = sidebarRef.current?.getBoundingClientRect().height ?? 0
    const { min, max } = getInfoPanelBounds()
    if (!sidebarHeight) return INFO_PANEL_FALLBACK_HEIGHT
    return clamp(Math.round(sidebarHeight * INFO_PANEL_DEFAULT_RATIO), min, max)
  }

  useEffect(() => {
    const element = sidebarRef.current
    if (!element) return

    const syncPanelHeight = () => {
      setInfoHeight((height) => {
        const { min, max } = getInfoPanelBounds()
        if (height == null || !userResizedRef.current) return getDefaultInfoHeight()
        return clamp(height, min, max)
      })
    }

    syncPanelHeight()
    const observer = new ResizeObserver(syncPanelHeight)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const startResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    userResizedRef.current = true
    dragRef.current = { startY: event.clientY, startHeight: infoHeight ?? getDefaultInfoHeight() }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const resizePanel = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragRef.current) return
    event.preventDefault()
    const delta = dragRef.current.startY - event.clientY
    const nextHeight = dragRef.current.startHeight + delta
    const { min, max } = getInfoPanelBounds()
    setInfoHeight(clamp(nextHeight, min, max))
  }

  const stopResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  return (
    <aside ref={sidebarRef} className="flex h-full w-full flex-col overflow-hidden bg-sidebar">
      {/* 交易对列表 */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="px-3 pb-1 pt-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索交易对"
              className="h-8 w-full rounded-md border border-border bg-background/60 pl-8 pr-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
            />
          </div>
        </div>
        <div className="flex items-center justify-between px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
          <span>交易对</span>
          <span>最新价 / 24h</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          {filteredPairs.map((p) => {
            const positive = p.change >= 0
            const active = p.symbol === activeSymbol
            return (
              <button
                key={p.symbol}
                onClick={() => onSelect(p.symbol)}
                className={cn(
                  'group relative flex w-full items-center gap-2 px-3 py-2 text-left transition-colors',
                  active ? 'bg-primary/10' : 'hover:bg-muted/50',
                )}
              >
                {active && <span className="absolute left-0 h-6 w-0.5 rounded-r bg-primary" />}
                <Star
                  className={cn(
                    'size-3 shrink-0',
                    active ? 'fill-primary text-primary' : 'text-muted-foreground/40',
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium">
                    {p.base}
                    <span className="text-muted-foreground">/{p.quote}</span>
                  </div>
                  <div className="text-[10px] text-muted-foreground">Vol {p.volume}</div>
                </div>
                <Sparkline data={p.sparkline} positive={positive} />
                <div className="w-[74px] shrink-0 text-right">
                  <div className="font-mono text-xs tabular-nums">{formatPrice(p.price)}</div>
                  <div className={cn('font-mono text-[10px] tabular-nums', positive ? 'text-up' : 'text-down')}>
                    {positive ? '+' : ''}
                    {p.change.toFixed(2)}%
                  </div>
                </div>
              </button>
            )
          })}
          {filteredPairs.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              {loading ? '正在加载行情' : '没有匹配的交易对'}
            </div>
          )}
          {(externalResults.length > 0 || searching || searchError) && (
            <div className="border-t border-border/70">
              <div className="flex items-center justify-between px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                <span>OKX 合约</span>
                {searching && <LoaderCircle className="size-3 animate-spin" />}
              </div>
              {externalResults.map((pair) => {
                const positive = pair.change >= 0
                return (
                  <button
                    key={pair.instrumentId}
                    type="button"
                    onClick={() => onAddPair(pair)}
                    className="group flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/50"
                  >
                    <span className="flex size-5 shrink-0 items-center justify-center rounded border border-border text-muted-foreground group-hover:border-primary group-hover:text-primary">
                      <Plus className="size-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium">
                        {pair.base}
                        <span className="text-muted-foreground">/{pair.quote}</span>
                      </div>
                      <div className="text-[10px] text-muted-foreground">Vol {pair.volume}</div>
                    </div>
                    <div className="w-[74px] shrink-0 text-right">
                      <div className="font-mono text-xs tabular-nums">{formatPrice(pair.price)}</div>
                      <div className={cn('font-mono text-[10px] tabular-nums', positive ? 'text-up' : 'text-down')}>
                        {positive ? '+' : ''}
                        {pair.change.toFixed(2)}%
                      </div>
                    </div>
                  </button>
                )
              })}
              {searchError && <div className="px-3 py-2 text-xs text-[var(--chart-3)]">{searchError}</div>}
            </div>
          )}
        </div>
      </div>

      <button
        type="button"
        role="separator"
        aria-label="调整左侧情报面板高度"
        aria-orientation="horizontal"
        aria-valuemin={Math.round(getInfoPanelBounds().min)}
        aria-valuemax={Math.round(getInfoPanelBounds().max)}
        aria-valuenow={Math.round(infoHeight ?? getDefaultInfoHeight())}
        onPointerDown={startResize}
        onPointerMove={resizePanel}
        onPointerUp={stopResize}
        onPointerCancel={stopResize}
        className="group flex h-2 shrink-0 cursor-row-resize touch-none items-center justify-center border-t border-border bg-sidebar transition-colors hover:bg-muted/40"
      >
        <span className="h-px w-10 bg-border transition-colors group-hover:bg-ring" />
      </button>

      <div className="flex shrink-0 flex-col" style={{ height: infoHeight ?? '50%' }}>
        <div className="grid h-9 grid-cols-3 border-b border-border">
          {infoTabs.map((tab) => {
            const Icon = tab.icon
            const selected = infoTab === tab.id
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setInfoTab(tab.id)}
                className={cn(
                  'inline-flex items-center justify-center gap-1.5 border-r border-border text-xs leading-none transition-colors last:border-r-0 [&_svg]:shrink-0',
                  selected ? 'bg-background text-foreground' : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                )}
              >
                <Icon className="size-3.5" />
                {tab.label}
              </button>
            )
          })}
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {infoTab === 'signals' && (
            <div className="h-full overflow-y-auto scrollbar-thin">
              <SectionTitle icon={<Activity className="size-3.5" />} title="策略信号" />
              <EmptyState label="暂无真实策略信号" />
            </div>
          )}

          {infoTab === 'strategies' && (
            <div className="h-full overflow-y-auto scrollbar-thin">
              <SectionTitle icon={<Bot className="size-3.5" />} title="策略实例" />
              <EmptyState label="暂无 freqtrade 策略实例" />
            </div>
          )}

          {infoTab === 'news' && (
            <div className="h-full overflow-y-auto scrollbar-thin">
              <SectionTitle icon={<Newspaper className="size-3.5" />} title="最近新闻" />
              <EmptyState label="暂无真实新闻流" />
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}
