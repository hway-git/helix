'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, Bot, Newspaper, Percent, Search, Star } from 'lucide-react'
import { Sparkline } from '@/components/charts/sparkline'
import {
  FUNDING_RATES,
  NEWS,
  SIGNALS,
  STRATEGIES,
  TRADING_PAIRS,
  formatPrice,
} from '@/lib/market-data'
import { cn } from '@/lib/utils'

type InfoTab = 'funding' | 'signals' | 'strategies' | 'news'

const INFO_PANEL_FALLBACK_HEIGHT = 236
const INFO_PANEL_DEFAULT_RATIO = 0.5
const INFO_PANEL_MIN_HEIGHT = 156
const PAIR_LIST_MIN_VISIBLE_HEIGHT = 304

const infoTabs: Array<{ id: InfoTab; label: string; icon: React.ElementType }> = [
  { id: 'funding', label: '资金', icon: Percent },
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

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

export function LeftSidebar({
  activeSymbol,
  onSelect,
}: {
  activeSymbol: string
  onSelect: (symbol: string) => void
}) {
  const [query, setQuery] = useState('')
  const [infoTab, setInfoTab] = useState<InfoTab>('funding')
  const [infoHeight, setInfoHeight] = useState<number | null>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null)
  const userResizedRef = useRef(false)

  const pairs = useMemo(
    () => TRADING_PAIRS.filter((p) => p.symbol.toLowerCase().includes(query.toLowerCase())),
    [query],
  )

  const tagColor = (tag: string) =>
    tag === '利好'
      ? 'text-up border-up/30 bg-up/10'
      : tag === '利空'
        ? 'text-down border-down/30 bg-down/10'
        : 'text-muted-foreground border-border bg-muted/40'

  const signalTone = (side: string) =>
    side === 'long'
      ? 'border-up/30 bg-up/10 text-up'
      : side === 'short'
        ? 'border-down/30 bg-down/10 text-down'
        : 'border-border bg-muted/40 text-muted-foreground'

  const modeTone = (mode: string) =>
    mode === '监控'
      ? 'text-up'
      : mode === '实盘'
        ? 'text-[var(--chart-2)]'
        : 'text-muted-foreground'

  const getMaxInfoHeight = () => {
    const sidebarHeight = sidebarRef.current?.getBoundingClientRect().height ?? 0
    if (!sidebarHeight) return INFO_PANEL_FALLBACK_HEIGHT
    return Math.max(INFO_PANEL_MIN_HEIGHT, sidebarHeight - PAIR_LIST_MIN_VISIBLE_HEIGHT)
  }

  const getDefaultInfoHeight = () => {
    const sidebarHeight = sidebarRef.current?.getBoundingClientRect().height ?? 0
    if (!sidebarHeight) return INFO_PANEL_FALLBACK_HEIGHT
    return clamp(Math.round(sidebarHeight * INFO_PANEL_DEFAULT_RATIO), INFO_PANEL_MIN_HEIGHT, getMaxInfoHeight())
  }

  useEffect(() => {
    const element = sidebarRef.current
    if (!element) return

    const syncPanelHeight = () => {
      setInfoHeight((height) => {
        if (height == null || !userResizedRef.current) return getDefaultInfoHeight()
        return clamp(height, INFO_PANEL_MIN_HEIGHT, getMaxInfoHeight())
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
    setInfoHeight(clamp(nextHeight, INFO_PANEL_MIN_HEIGHT, getMaxInfoHeight()))
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
          {pairs.map((p) => {
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
        </div>
      </div>

      <button
        type="button"
        role="separator"
        aria-label="调整左侧情报面板高度"
        aria-orientation="horizontal"
        aria-valuemin={INFO_PANEL_MIN_HEIGHT}
        aria-valuemax={Math.round(getMaxInfoHeight())}
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
          {infoTab === 'funding' && (
            <div className="h-full">
              <SectionTitle
                icon={<Percent className="size-3.5" />}
                title="资金费率"
                extra={<span className="font-mono text-[10px] text-muted-foreground">下次 02:14:08</span>}
              />
              <div className="grid grid-cols-3 gap-px bg-border/50 px-3 pb-3">
                {FUNDING_RATES.map((f) => {
                  const positive = f.rate >= 0
                  return (
                    <div key={f.symbol} className="flex flex-col gap-0.5 bg-sidebar px-2 py-1.5">
                      <span className="text-[10px] text-muted-foreground">{f.symbol}</span>
                      <span className={cn('font-mono text-xs tabular-nums', positive ? 'text-up' : 'text-down')}>
                        {positive ? '+' : ''}
                        {f.rate.toFixed(4)}%
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {infoTab === 'signals' && (
            <div className="h-full overflow-y-auto scrollbar-thin">
              <SectionTitle icon={<Activity className="size-3.5" />} title="策略信号" />
              <div className="space-y-1.5 px-3 pb-3">
                {SIGNALS.map((signal) => (
                  <button
                    key={signal.id}
                    onClick={() => onSelect(signal.symbol)}
                    className="flex w-full items-center gap-2 rounded border border-border/70 bg-background/35 px-2 py-1.5 text-left leading-none transition-colors hover:border-ring"
                  >
                    <span className={cn('inline-flex h-5 w-12 items-center justify-center rounded border px-1.5 font-mono text-[10px]', signalTone(signal.side))}>
                      {signal.side.toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-[11px]">{signal.symbol}</div>
                      <div className="truncate text-[10px] text-muted-foreground">{signal.source}</div>
                    </div>
                    <div className="text-right font-mono">
                      <div className="text-[11px] tabular-nums">{signal.confidence}%</div>
                      <div className="text-[10px] text-muted-foreground">{signal.age}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {infoTab === 'strategies' && (
            <div className="h-full overflow-y-auto scrollbar-thin">
              <SectionTitle icon={<Bot className="size-3.5" />} title="策略实例" />
              <div className="space-y-2 px-3 pb-3">
                {STRATEGIES.map((strategy) => (
                  <div key={strategy.id} className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{strategy.name}</div>
                      <div className="font-mono text-[10px] text-muted-foreground">
                        {strategy.symbol} · {strategy.timeframe}
                      </div>
                    </div>
                    <div className={cn('font-mono text-[11px]', modeTone(strategy.mode))}>{strategy.mode}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">Win {strategy.winRate.toFixed(1)}%</div>
                    <div className="font-mono text-[10px] text-muted-foreground">DD {strategy.maxDrawdown.toFixed(1)}%</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {infoTab === 'news' && (
            <div className="h-full overflow-y-auto scrollbar-thin">
              <SectionTitle icon={<Newspaper className="size-3.5" />} title="最近新闻" />
              <ul className="flex flex-col gap-2.5 px-3 pb-3">
                {NEWS.map((n) => (
                  <li key={n.id} className="group cursor-pointer border-b border-border/50 pb-2.5 last:border-0">
                    <div className="mb-1 flex items-center gap-2">
                      <span
                        className={cn(
                          'rounded border px-1 py-px text-[9px] font-medium',
                          tagColor(n.tag),
                        )}
                      >
                        {n.tag}
                      </span>
                      <span className="text-[10px] text-muted-foreground">{n.source}</span>
                      <span className="ml-auto text-[10px] text-muted-foreground">{n.time}</span>
                    </div>
                    <p className="text-xs leading-relaxed text-foreground/90 transition-colors group-hover:text-primary">
                      {n.title}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}
