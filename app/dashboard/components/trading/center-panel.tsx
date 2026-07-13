'use client'

import { useEffect, useState } from 'react'
import { Check, Plus } from 'lucide-react'
import { IndicatorCard } from './indicator-card'
import { SymbolHeader } from './symbol-header'
import { CandlestickChart } from '@/components/charts/candlestick-chart'
import { MACDChart } from '@/components/charts/macd-chart'
import { RSIChart } from '@/components/charts/rsi-chart'
import { VolumeChart } from '@/components/charts/volume-chart'
import { type Candle, type MarketLevels, type TechnicalIndicators, type TradingPair } from '@/lib/market-data'
import { cn } from '@/lib/utils'

type IndicatorType = 'rsi' | 'macd' | 'volume'

const TIMEFRAMES = ['1m', '5m', '15m', '1H', '4H', '1D']

const META: Record<IndicatorType, { title: string; badge: string; height: string }> = {
  rsi: { title: 'RSI 相对强弱', badge: 'RSI · 14', height: 'h-32' },
  macd: { title: 'MACD 指数平滑异同', badge: 'MACD · 12·26·9', height: 'h-32' },
  volume: { title: '成交量', badge: 'Volume', height: 'h-32' },
}

function IndicatorEmptyState({ loading, message }: { loading: boolean; message: string }) {
  return (
    <div className="flex h-full items-center justify-center px-3 text-center text-xs text-muted-foreground">
      {loading ? '正在加载指标' : message}
    </div>
  )
}

export function CenterPanel({
  pair,
  candles,
  timeframe,
  loading,
  error,
  levels,
  indicators: technicalIndicators,
  indicatorLoading,
  indicatorError,
  onTimeframeChange,
}: {
  pair: TradingPair
  candles: Candle[]
  timeframe: string
  loading: boolean
  error: string | null
  levels?: MarketLevels
  indicators?: TechnicalIndicators
  indicatorLoading: boolean
  indicatorError: string | null
  onTimeframeChange: (timeframe: string) => void
}) {
  const [indicators, setIndicators] = useState<IndicatorType[]>(['rsi', 'macd', 'volume'])
  const [activeIndicatorIndex, setActiveIndicatorIndex] = useState(0)
  const [showEma20, setShowEma20] = useState(true)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    setActiveIndicatorIndex((index) => Math.min(index, Math.max(indicators.length - 1, 0)))
  }, [indicators.length])

  const showPreviousIndicator = () => setActiveIndicatorIndex((index) => Math.max(index - 1, 0))
  const showNextIndicator = () => setActiveIndicatorIndex((index) => Math.min(index + 1, indicators.length - 1))
  const removeActiveIndicator = () => setIndicators((prev) => prev.filter((_, i) => i !== activeIndicatorIndex))
  const add = (type: IndicatorType) => {
    const existingIndex = indicators.indexOf(type)
    if (existingIndex >= 0) {
      setActiveIndicatorIndex(existingIndex)
    } else {
      setIndicators((prev) => [...prev, type])
      setActiveIndicatorIndex(indicators.length)
    }
    setMenuOpen(false)
  }

  const renderChart = (type: IndicatorType) => {
    switch (type) {
      case 'rsi':
        return technicalIndicators?.rsi.length ? (
          <RSIChart points={technicalIndicators.rsi} />
        ) : (
          <IndicatorEmptyState loading={indicatorLoading} message={indicatorError || 'RSI14 数据不足'} />
        )
      case 'macd':
        return technicalIndicators?.macd.length ? (
          <MACDChart points={technicalIndicators.macd} />
        ) : (
          <IndicatorEmptyState loading={indicatorLoading} message={indicatorError || 'MACD 数据不足'} />
        )
      case 'volume':
        return <VolumeChart candles={candles} />
    }
  }

  const readout = (type: IndicatorType): React.ReactNode => {
    if (type === 'rsi') {
      const latest = technicalIndicators?.rsi.at(-1)?.value
      return latest == null ? null : <span>RSI {latest.toFixed(1)}</span>
    }
    if (type === 'macd') {
      const latest = technicalIndicators?.macd.at(-1)
      if (!latest) return null
      return (
        <>
          <span className="text-[var(--chart-2)]">DIF {latest.macd.toFixed(2)}</span>
          <span className="text-[var(--chart-3)]">DEA {latest.signal.toFixed(2)}</span>
          <span className={latest.hist >= 0 ? 'text-up' : 'text-down'}>Hist {latest.hist.toFixed(2)}</span>
        </>
      )
    }

    const latestVolume = candles.at(-1)?.volume
    return latestVolume == null ? null : <span>Vol {latestVolume.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>
  }

  const allTypes: IndicatorType[] = ['rsi', 'macd', 'volume']
  const activeIndicator = indicators[activeIndicatorIndex]

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <SymbolHeader pair={pair} />

      <div className="flex min-h-0 flex-1 flex-col border-b border-border">
        <div className="flex h-10 items-center gap-2 border-b border-border bg-card/20 px-4">
          <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
            {TIMEFRAMES.map((t) => (
              <button
                key={t}
                onClick={() => onTimeframeChange(t)}
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
                  <button
                    onClick={() => {
                      setShowEma20((value) => !value)
                      setMenuOpen(false)
                    }}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-xs transition-colors hover:bg-muted"
                  >
                    EMA20 趋势线
                    {showEma20 && <Check className="size-3.5 text-primary" />}
                  </button>
                  <div className="my-1 h-px bg-border" />
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
          {candles.length > 0 ? (
            <CandlestickChart
              candles={candles}
              levels={levels}
              rangeKey={`${pair.instrumentId}:${timeframe}`}
              showEma20={showEma20}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              {loading ? '正在加载 K 线' : error ? 'K 线暂不可用' : '暂无 K 线数据'}
            </div>
          )}
        </div>
      </div>

      {/* 单指标查看区：多指标通过卡片右上角箭头切换 */}
      <div className="h-[190px] shrink-0 overflow-hidden p-2">
        {!activeIndicator ? (
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
          <IndicatorCard
            key={activeIndicator}
            title={META[activeIndicator].title}
            badge={`${META[activeIndicator].badge} · ${activeIndicatorIndex + 1}/${indicators.length}`}
            height={META[activeIndicator].height}
            readout={readout(activeIndicator)}
            canMoveUp={activeIndicatorIndex > 0}
            canMoveDown={activeIndicatorIndex < indicators.length - 1}
            onMoveUp={showPreviousIndicator}
            onMoveDown={showNextIndicator}
            onRemove={removeActiveIndicator}
          >
            {renderChart(activeIndicator)}
          </IndicatorCard>
        )}
      </div>
    </div>
  )
}
