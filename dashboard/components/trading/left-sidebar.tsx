'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Bot,
  CalendarDays,
  Crosshair,
  LoaderCircle,
  Newspaper,
  Plus,
  RefreshCw,
  Search,
  Shield,
  Star,
} from 'lucide-react'
import { Sparkline } from '@/components/charts/sparkline'
import {
  formatPrice,
  type EconomicCalendarEvent,
  type EconomicCalendarSnapshot,
  type IntradaySignalSnapshot,
  type IntradayTimeframeAnalysis,
  type MarketNewsItem,
  type MarketNewsSnapshot,
  type TradingPair,
} from '@/lib/market-data'
import { cn } from '@/lib/utils'

type InfoTab = 'signals' | 'strategies' | 'news' | 'data'

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
  { id: 'data', label: '数据', icon: CalendarDays },
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

function formatRelativeTime(timestamp: number) {
  if (!Number.isFinite(timestamp)) return '--'

  const diff = Math.max(Date.now() - timestamp, 0)
  const minute = 60_000
  const hour = minute * 60
  const day = hour * 24

  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)}m`
  if (diff < day) return `${Math.floor(diff / hour)}h`
  if (diff < day * 7) return `${Math.floor(diff / day)}d`

  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(timestamp)
}

function formatClockTime(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(timestamp)
}

function formatCalendarDay(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).format(timestamp)
}

function formatWeekRange(weekStart?: number, weekEnd?: number) {
  if (weekStart == null || weekEnd == null) return '本周'
  const format = (timestamp: number) =>
    new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(timestamp)
  return `${format(weekStart)} - ${format(weekEnd - 1)}`
}

function calendarImpactLabel(impact: EconomicCalendarEvent['impact']) {
  return impact === 'high' ? '高' : impact === 'medium' ? '中' : '低'
}

function calendarImpactClass(impact: EconomicCalendarEvent['impact']) {
  if (impact === 'high') return 'border-[var(--chart-2)]/50 text-[var(--chart-2)]'
  if (impact === 'medium') return 'border-[var(--chart-3)]/50 text-[var(--chart-3)]'
  return 'border-border text-muted-foreground'
}

const confidenceLabels = {
  low: '低',
  medium: '中',
  high: '高',
  'very-high': '很高',
} as const

function structureLabel(analysis: IntradayTimeframeAnalysis) {
  const high = analysis.priceAction.structureHigh === 'higher'
    ? 'HH'
    : analysis.priceAction.structureHigh === 'lower'
      ? 'LH'
      : analysis.priceAction.structureHigh === 'equal'
        ? 'EH'
        : '--'
  const low = analysis.priceAction.structureLow === 'higher'
    ? 'HL'
    : analysis.priceAction.structureLow === 'lower'
      ? 'LL'
      : analysis.priceAction.structureLow === 'equal'
        ? 'EL'
        : '--'
  return `${high}/${low}`
}

function macdLabel(analysis: IntradayTimeframeAnalysis) {
  if (analysis.macd.divergence === 'bullish') return '底背离'
  if (analysis.macd.divergence === 'bearish') return '顶背离'
  if (analysis.macd.cross === 'bullish') return '金叉'
  if (analysis.macd.cross === 'bearish') return '死叉'
  return analysis.macd.histogram > 0 ? '柱体 > 0' : analysis.macd.histogram < 0 ? '柱体 < 0' : '零轴'
}

function rsiLabel(analysis: IntradayTimeframeAnalysis) {
  const state = analysis.rsi.state === 'overbought' ? '超买' : analysis.rsi.state === 'oversold' ? '超卖' : '中性'
  return `${analysis.rsi.value.toFixed(1)} ${state}`
}

function paEventLabel(event: IntradayTimeframeAnalysis['priceAction']['event']) {
  const labels: Record<IntradayTimeframeAnalysis['priceAction']['event'], string> = {
    'bullish-break': '向上突破',
    'bearish-break': '向下突破',
    'bullish-retest': '多头回踩',
    'bearish-retest': '空头回踩',
    'bullish-rejection': '支撑拒绝',
    'bearish-rejection': '阻力拒绝',
    'bullish-sweep': '下扫收回',
    'bearish-sweep': '上扫收回',
    ambiguous: '柱内歧义',
    none: '无事件',
  }
  return labels[event]
}

function SignalPanel({ snapshot }: { snapshot: IntradaySignalSnapshot }) {
  const { signal } = snapshot
  const actionable = signal.status === 'actionable'
  const long = actionable && signal.side === 'long'
  const short = actionable && signal.side === 'short'
  const statusLabel = long ? 'LONG' : short ? 'SHORT' : 'WAIT'
  const statusClass = long
    ? 'text-[var(--chart-3)]'
    : short
      ? 'text-[var(--chart-2)]'
      : 'text-muted-foreground'
  const StatusIcon = long ? ArrowUpRight : short ? ArrowDownRight : Activity
  const biasLabel = signal.bias.side === 'long' ? '1H 偏多' : signal.bias.side === 'short' ? '1H 偏空' : '1H 中性'

  return (
    <div className="divide-y divide-border/70">
      <div className="px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className={cn('inline-flex min-w-0 items-center gap-1.5 font-mono text-sm font-semibold leading-none', statusClass)}>
            <StatusIcon className="size-4 shrink-0" />
            <span>{statusLabel}</span>
          </div>
          <div className="text-right font-mono text-[11px] leading-none tabular-nums text-foreground">
            {signal.confidence}% · {confidenceLabels[signal.confidenceLevel]}
          </div>
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] leading-4 text-muted-foreground">
          <span>{snapshot.activeSymbol} · {biasLabel}</span>
          <span>{new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(snapshot.generatedAt)}</span>
        </div>
      </div>

      {actionable && signal.entry && signal.stopLoss && (
        <div className="grid grid-cols-2 divide-x divide-border/70">
          <div className="min-w-0 px-3 py-2">
            <div className="flex items-center gap-1 text-[10px] leading-none text-muted-foreground">
              <Crosshair className="size-3" />
              建议入场 · {signal.entry.timeframe}
            </div>
            <div className="mt-1 font-mono text-xs font-medium tabular-nums text-foreground">
              {formatPrice(signal.entry.price)}
            </div>
            <div className="mt-0.5 truncate font-mono text-[9px] tabular-nums text-muted-foreground">
              {formatPrice(signal.entry.zoneLow)}–{formatPrice(signal.entry.zoneHigh)}
            </div>
          </div>
          <div className="min-w-0 px-3 py-2">
            <div className="flex items-center gap-1 text-[10px] leading-none text-muted-foreground">
              <Shield className="size-3" />
              结构止损
            </div>
            <div className="mt-1 font-mono text-xs font-medium tabular-nums text-[var(--chart-2)]">
              {formatPrice(signal.stopLoss.price)}
            </div>
            <div className="mt-0.5 truncate text-[9px] leading-3 text-muted-foreground" title={signal.stopLoss.basis}>
              {signal.stopLoss.basis}
            </div>
          </div>
        </div>
      )}

      <div>
        {(['1h', '15m', '5m'] as const).map((timeframe) => {
          const analysis = snapshot.timeframes[timeframe]
          if (!analysis) return null
          return (
            <div key={timeframe} className="grid grid-cols-[34px_minmax(0,1fr)] gap-2 border-b border-border/50 px-3 py-2 last:border-b-0">
              <div className="pt-0.5 font-mono text-[10px] font-semibold leading-none text-foreground">{timeframe.toUpperCase()}</div>
              <div className="min-w-0 text-[10px] leading-4">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-foreground">
                  <span>MACD {macdLabel(analysis)}</span>
                  <span>RSI {rsiLabel(analysis)}</span>
                </div>
                <div className="truncate text-muted-foreground" title={`PA ${structureLabel(analysis)} · ${paEventLabel(analysis.priceAction.event)} · 量 ${analysis.volume.ratio.toFixed(2)}x`}>
                  PA {structureLabel(analysis)} · {paEventLabel(analysis.priceAction.event)} · 量 {analysis.volume.ratio.toFixed(2)}x
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {signal.logic.length > 0 && (
        <div className="px-3 py-2">
          <div className="mb-1.5 text-[10px] font-medium leading-none text-muted-foreground">开单逻辑</div>
          <div className="space-y-1">
            {signal.logic.slice(0, 8).map((item) => (
              <div key={item} className="flex gap-1.5 text-[10px] leading-4 text-foreground">
                <span className="mt-[7px] size-1 shrink-0 rounded-full bg-muted-foreground" />
                <span>{item}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {signal.warnings.length > 0 && (
        <div className="px-3 py-2 text-[10px] leading-4 text-[var(--chart-4)]">
          {signal.warnings.slice(0, 3).join(' · ')}
        </div>
      )}
    </div>
  )
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
  const [signalSnapshot, setSignalSnapshot] = useState<IntradaySignalSnapshot | null>(null)
  const [signalLoading, setSignalLoading] = useState(false)
  const [signalError, setSignalError] = useState<string | null>(null)
  const [searchResults, setSearchResults] = useState<TradingPair[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [newsItems, setNewsItems] = useState<MarketNewsItem[]>([])
  const [newsLoading, setNewsLoading] = useState(false)
  const [newsError, setNewsError] = useState<string | null>(null)
  const [newsFetchedAt, setNewsFetchedAt] = useState<number | null>(null)
  const [calendarSnapshot, setCalendarSnapshot] = useState<EconomicCalendarSnapshot | null>(null)
  const [calendarLoading, setCalendarLoading] = useState(false)
  const [calendarError, setCalendarError] = useState<string | null>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null)
  const userResizedRef = useRef(false)

  const filteredPairs = useMemo(
    () => pairs.filter((p) => p.symbol.toLowerCase().includes(query.toLowerCase())),
    [pairs, query],
  )
  const knownInstruments = useMemo(() => new Set(pairs.map((pair) => pair.instrumentId)), [pairs])
  const instrumentsParam = useMemo(() => pairs.map((pair) => pair.instrumentId).join(','), [pairs])
  const externalResults = useMemo(
    () => searchResults.filter((pair) => !knownInstruments.has(pair.instrumentId)),
    [knownInstruments, searchResults],
  )
  const calendarGroups = useMemo(() => {
    const now = Date.now()
    const relevantEvents = (calendarSnapshot?.events ?? [])
      .filter((event) => event.scheduledAt >= now && event.impact !== 'low')
      .sort((left, right) => left.scheduledAt - right.scheduledAt)
    const groups = new Map<string, { timestamp: number; events: EconomicCalendarEvent[] }>()

    for (const event of relevantEvents) {
      const key = new Date(event.scheduledAt).toDateString()
      const group = groups.get(key)
      if (group) group.events.push(event)
      else groups.set(key, { timestamp: event.scheduledAt, events: [event] })
    }

    return [...groups.values()]
  }, [calendarSnapshot])

  const loadSignals = useCallback(async (signal?: AbortSignal) => {
    setSignalLoading(true)
    try {
      const params = new URLSearchParams({
        provider: 'okx',
        symbol: activeSymbol,
        instruments: instrumentsParam,
      })
      const response = await fetch(`/api/market/signals?${params.toString()}`, {
        cache: 'no-store',
        signal,
      })
      if (!response.ok) throw new Error(`信号接口 HTTP ${response.status}`)

      const payload = (await response.json()) as IntradaySignalSnapshot
      if (signal?.aborted) return
      setSignalSnapshot(payload)
      setSignalError(payload.source.status === 'offline' ? payload.source.errors[0] ?? '信号源不可用' : null)
    } catch (error) {
      if (signal?.aborted) return
      setSignalError(error instanceof Error ? error.message : '信号源不可用')
    } finally {
      if (!signal?.aborted) setSignalLoading(false)
    }
  }, [activeSymbol, instrumentsParam])

  useEffect(() => {
    const controller = new AbortController()
    void loadSignals(controller.signal)
    const timer = window.setInterval(() => void loadSignals(), 30_000)

    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [loadSignals])

  const loadNews = useCallback(async (signal?: AbortSignal) => {
    setNewsLoading(true)

    try {
      const response = await fetch('/api/market/news?limit=24', {
        cache: 'no-store',
        signal,
      })
      if (!response.ok) throw new Error(`新闻接口 HTTP ${response.status}`)

      const payload = (await response.json()) as MarketNewsSnapshot
      if (signal?.aborted) return

      setNewsItems(payload.items ?? [])
      setNewsFetchedAt(payload.source.fetchedAt)
      setNewsError(
        payload.ok
          ? payload.source.status === 'partial'
            ? payload.source.errors[0] ?? null
            : null
          : payload.source.errors[0] ?? '新闻源暂时不可用',
      )
    } catch (error) {
      if (signal?.aborted) return
      setNewsError(error instanceof Error ? error.message : '新闻源暂时不可用')
    } finally {
      if (!signal?.aborted) setNewsLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void loadNews(controller.signal)
    const timer = window.setInterval(() => void loadNews(), 120_000)

    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [loadNews])

  const loadCalendar = useCallback(async (signal?: AbortSignal) => {
    setCalendarLoading(true)

    try {
      const response = await fetch('/api/macro/calendar', {
        cache: 'no-store',
        signal,
      })
      if (!response.ok) throw new Error(`经济日历接口 HTTP ${response.status}`)

      const payload = (await response.json()) as EconomicCalendarSnapshot
      if (signal?.aborted) return

      setCalendarSnapshot(payload)
      setCalendarError(
        payload.ok
          ? payload.source.status === 'partial'
            ? payload.source.errors[0] ?? null
            : null
          : payload.source.errors[0] ?? '经济日历暂不可用',
      )
    } catch (error) {
      if (signal?.aborted) return
      setCalendarError(error instanceof Error ? error.message : '经济日历暂不可用')
    } finally {
      if (!signal?.aborted) setCalendarLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void loadCalendar(controller.signal)
    const timer = window.setInterval(() => void loadCalendar(), 300_000)

    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [loadCalendar])

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
        setSearchError(payload.ok ? null : payload.error ?? '交易对搜索不可用')
      } catch (error) {
        if (disposed || (error instanceof DOMException && error.name === 'AbortError')) return
        setSearchError(error instanceof Error ? error.message : '交易对搜索不可用')
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
                <span>合约市场</span>
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
        <div className="grid h-9 grid-cols-4 border-b border-border">
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
              <SectionTitle
                icon={<Activity className="size-3.5" />}
                title="日内信号"
                extra={
                  <button
                    type="button"
                    onClick={() => void loadSignals()}
                    disabled={signalLoading}
                    title="刷新信号"
                    aria-label="刷新信号"
                    className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-wait disabled:opacity-70"
                  >
                    {signalLoading ? <LoaderCircle className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                  </button>
                }
              />
              {signalSnapshot?.activeSymbol === activeSymbol ? (
                <SignalPanel snapshot={signalSnapshot} />
              ) : (
                <EmptyState label={signalError || (signalLoading ? '正在计算多周期信号' : '暂无可用信号')} />
              )}
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
              <SectionTitle
                icon={<Newspaper className="size-3.5" />}
                title="最近新闻"
                extra={
                  <button
                    type="button"
                    onClick={() => void loadNews()}
                    disabled={newsLoading}
                    title={newsFetchedAt ? `最后更新 ${formatClockTime(newsFetchedAt)}` : '刷新新闻'}
                    aria-label="刷新新闻"
                    className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-wait disabled:opacity-70"
                  >
                    {newsLoading ? <LoaderCircle className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                  </button>
                }
              />
              {newsError && newsItems.length > 0 && (
                <div className="border-y border-border/70 px-3 py-1.5 text-[10px] leading-4 text-muted-foreground">
                  {newsError}
                </div>
              )}
              {newsItems.length > 0 ? (
                <div className="divide-y divide-border/60">
                  {newsItems.map((item) => (
                    <a
                      key={item.id}
                      href={item.url}
                      target="_blank"
                      rel="noreferrer"
                      className="group flex min-h-[94px] flex-col gap-1.5 overflow-hidden px-3 py-2.5 transition-colors hover:bg-muted/40"
                    >
                      <div className="flex h-3.5 min-w-0 items-center gap-1.5 text-[10px] uppercase leading-none tracking-wide text-muted-foreground">
                        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
                          <span className="min-w-0 truncate">{item.source}</span>
                          {item.category && (
                            <>
                              <span className="shrink-0 text-muted-foreground/50">·</span>
                              <span className="min-w-0 truncate">{item.category}</span>
                            </>
                          )}
                        </div>
                        <span className="shrink-0 font-mono tabular-nums">
                          {formatRelativeTime(item.publishedAt)}
                        </span>
                      </div>
                      <div
                        className="overflow-hidden text-xs font-medium leading-[18px] text-foreground transition-colors group-hover:text-primary"
                        style={{ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2 }}
                      >
                        {item.title}
                      </div>
                      {item.summary && (
                        <div
                          className="overflow-hidden text-[11px] leading-4 text-muted-foreground"
                          style={{ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2 }}
                        >
                          {item.summary}
                        </div>
                      )}
                    </a>
                  ))}
                </div>
              ) : (
                <EmptyState label={newsLoading ? '正在加载新闻流' : newsError ?? '暂无真实新闻流'} />
              )}
            </div>
          )}

          {infoTab === 'data' && (
            <div className="h-full overflow-y-auto scrollbar-thin">
              <SectionTitle
                icon={<CalendarDays className="size-3.5" />}
                title="本周经济日历"
                extra={
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[9px] tabular-nums text-muted-foreground">
                      {formatWeekRange(calendarSnapshot?.weekStart, calendarSnapshot?.weekEnd)}
                    </span>
                    <button
                      type="button"
                      onClick={() => void loadCalendar()}
                      disabled={calendarLoading}
                      title={
                        calendarSnapshot
                          ? `最后更新 ${formatClockTime(calendarSnapshot.source.fetchedAt)}`
                          : '刷新经济日历'
                      }
                      aria-label="刷新经济日历"
                      className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-wait disabled:opacity-70"
                    >
                      {calendarLoading ? (
                        <LoaderCircle className="size-3 animate-spin" />
                      ) : (
                        <RefreshCw className="size-3" />
                      )}
                    </button>
                  </div>
                }
              />
              {calendarError && calendarGroups.length > 0 && (
                <div className="border-y border-border/70 px-3 py-1.5 text-[10px] leading-4 text-muted-foreground">
                  {calendarError}
                </div>
              )}
              {calendarGroups.length > 0 ? (
                <div>
                  {calendarGroups.map((group) => (
                    <section key={new Date(group.timestamp).toDateString()}>
                      <div className="border-y border-border/60 bg-muted/20 px-3 py-1.5 text-[10px] font-medium leading-none text-muted-foreground first:border-t-0">
                        {formatCalendarDay(group.timestamp)}
                      </div>
                      <div className="divide-y divide-border/60">
                        {group.events.map((event) => (
                          <div key={event.id} className="grid grid-cols-[38px_minmax(0,1fr)] gap-2 px-3 py-2.5 transition-colors hover:bg-muted/40">
                            <div className="pt-0.5 font-mono text-[11px] tabular-nums text-foreground">
                              {formatClockTime(event.scheduledAt)}
                            </div>
                            <div className="min-w-0">
                              <div className="flex min-w-0 items-start justify-between gap-2">
                                <div
                                  className="min-w-0 text-[11px] font-medium leading-4 text-foreground"
                                  title={event.titleZh ? event.title : undefined}
                                >
                                  {event.titleZh ?? event.title}
                                </div>
                                <div className="flex shrink-0 items-center gap-1 font-mono text-[9px] leading-none">
                                  <span className="text-muted-foreground">{event.currency}</span>
                                  <span className={cn('border px-1 py-0.5', calendarImpactClass(event.impact))}>
                                    {calendarImpactLabel(event.impact)}
                                  </span>
                                </div>
                              </div>
                              {(event.actual || event.forecast || event.previous) && (
                                <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 font-mono text-[9px] leading-none tabular-nums text-muted-foreground">
                                  {event.actual && <span className="text-foreground">实际 {event.actual}</span>}
                                  {event.forecast && <span>预期 {event.forecast}</span>}
                                  {event.previous && <span>前值 {event.previous}</span>}
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              ) : (
                <EmptyState
                  label={
                    calendarLoading
                      ? '正在加载本周日历'
                      : calendarError ?? '本周暂无待公布的高 / 中影响事件'
                  }
                />
              )}
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}
