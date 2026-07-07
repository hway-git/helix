'use client'

import { useMemo, useState } from 'react'
import { Check, Database, Plus } from 'lucide-react'
import { IndicatorCard } from './indicator-card'
import { SymbolHeader } from './symbol-header'
import { CandlestickChart } from '@/components/charts/candlestick-chart'
import { RSIChart } from '@/components/charts/rsi-chart'
import { MACDChart } from '@/components/charts/macd-chart'
import { VolumeChart } from '@/components/charts/volume-chart'
import {
  generateCandles,
  computeRSI,
  computeMACD,
  TRADING_PAIRS,
} from '@/lib/market-data'
import { cn } from '@/lib/utils'

type IndicatorType = 'rsi' | 'macd' | 'volume'

const TIMEFRAMES = ['1m', '5m', '15m', '1H', '4H', '1D']

const META: Record<IndicatorType, { title: string; badge: string; height: string }> = {
  rsi: { title: 'RSI 相对强弱指标', badge: 'RSI · 14', height: 'h-40' },
  macd: { title: 'MACD 指数平滑异同', badge: '12 · 26 · 9', height: 'h-44' },
  volume: { title: '成交量', badge: 'Volume', height: 'h-36' },
}

export function CenterPanel({ activeSymbol }: { activeSymbol: string }) {
  const [indicators, setIndicators] = useState<IndicatorType[]>(['rsi', 'macd'])
  const [timeframe, setTimeframe] = useState('15m')
  const [menuOpen, setMenuOpen] = useState(false)

  const pair = TRADING_PAIRS.find((p) => p.symbol === activeSymbol) ?? TRADING_PAIRS[0]

  // 基于交易对生成可复现数据
  const seed = useMemo(
    () => pair.symbol.split('').reduce((a, c) => a + c.charCodeAt(0), 0),
    [pair.symbol],
  )
  const candles = useMemo(() => generateCandles(90, seed, pair.price), [seed, pair.price])
  const rsi = useMemo(() => computeRSI(candles), [candles])
  const macd = useMemo(() => computeMACD(candles), [candles])

  const lastRsi = rsi[rsi.length - 1]
  const lastMacd = macd[macd.length - 1]

  const move = (index: number, dir: -1 | 1) => {
    setIndicators((prev) => {
      const next = [...prev]
      const target = index + dir
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  const remove = (index: number) => setIndicators((prev) => prev.filter((_, i) => i !== index))
  const add = (type: IndicatorType) => {
    setIndicators((prev) => (prev.includes(type) ? prev : [...prev, type]))
    setMenuOpen(false)
  }

  const renderChart = (type: IndicatorType) => {
    switch (type) {
      case 'rsi':
        return <RSIChart values={rsi} />
      case 'macd':
        return <MACDChart points={macd} />
      case 'volume':
        return <VolumeChart candles={candles} />
    }
  }

  const readout = (type: IndicatorType): React.ReactNode => {
    if (type === 'rsi' && !Number.isNaN(lastRsi)) {
      const tone = lastRsi >= 70 ? 'text-down' : lastRsi <= 30 ? 'text-up' : 'text-foreground'
      return <span className={tone}>{lastRsi.toFixed(1)}</span>
    }
    if (type === 'macd' && lastMacd) {
      return (
        <>
          <span className="text-[var(--chart-2)]">DIF {lastMacd.macd.toFixed(1)}</span>
          <span className="text-[var(--chart-3)]">DEA {lastMacd.signal.toFixed(1)}</span>
          <span className={lastMacd.hist >= 0 ? 'text-up' : 'text-down'}>
            MACD {lastMacd.hist.toFixed(1)}
          </span>
        </>
      )
    }
    return null
  }

  const allTypes: IndicatorType[] = ['rsi', 'macd', 'volume']

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <SymbolHeader pair={pair} />

      <div className="flex h-[392px] shrink-0 flex-col border-b border-border">
        <div className="flex h-10 items-center gap-2 border-b border-border bg-card/20 px-4">
          <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
            {TIMEFRAMES.map((t) => (
              <button
                key={t}
                onClick={() => setTimeframe(t)}
                className={cn(
                  'inline-flex h-6 items-center justify-center rounded px-2 font-mono text-[11px] leading-none transition-colors',
                  timeframe === t
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t}
              </button>
            ))}
          </div>

          <div className="hidden items-center gap-2 font-mono text-[11px] text-muted-foreground xl:flex">
            <span className="inline-flex h-6 items-center gap-1 rounded border border-[var(--chart-3)]/40 bg-[var(--chart-3)]/10 px-2 leading-none text-[var(--chart-3)] [&_svg]:shrink-0">
              <Database className="size-3.5" />
              模拟 K 线
            </span>
          </div>

          <div className="relative ml-auto">
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-[11px] font-medium leading-none text-foreground transition-colors hover:border-ring hover:bg-muted/50 [&_svg]:shrink-0"
            >
              <Plus className="size-3.5" />
              添加指标
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} aria-hidden="true" />
                <div className="absolute right-0 top-full z-20 mt-1 w-44 overflow-hidden rounded-md border border-border bg-popover py-1 shadow-xl">
                  {allTypes.map((t) => {
                    const enabled = indicators.includes(t)
                    return (
                      <button
                        key={t}
                        onClick={() => add(t)}
                        disabled={enabled}
                        className="flex w-full items-center justify-between px-3 py-2 text-left text-xs transition-colors hover:bg-muted disabled:opacity-40"
                      >
                        {META[t].title}
                        {enabled && <Check className="size-3.5 text-primary" />}
                      </button>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="relative min-h-0 flex-1 px-1 py-1">
          <CandlestickChart candles={candles} />
        </div>
      </div>

      {/* 可编辑指标卡片列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin p-3">
        {indicators.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <p className="text-sm">暂无指标卡片</p>
            <button
              onClick={() => setMenuOpen(true)}
              className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted"
            >
              添加指标
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {indicators.map((type, i) => (
              <IndicatorCard
                key={type}
                title={META[type].title}
                badge={META[type].badge}
                height={META[type].height}
                readout={readout(type)}
                canMoveUp={i > 0}
                canMoveDown={i < indicators.length - 1}
                onMoveUp={() => move(i, -1)}
                onMoveDown={() => move(i, 1)}
                onRemove={() => remove(i)}
              >
                {renderChart(type)}
              </IndicatorCard>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
