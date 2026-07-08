'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createChart,
  LineStyle,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LineData,
  type MouseEventParams,
  type Time,
} from 'lightweight-charts'
import { formatPrice, type Candle, type MarketLevels } from '@/lib/market-data'
import { baseChartOptions, chartColors, chartTime } from './lightweight-utils'

const EMA_PERIOD = 20
const INITIAL_VISIBLE_BARS = 96

type CandleReadout = Candle & {
  ema20?: number
}

function toCandlestickData(candle: Candle): CandlestickData<Time> {
  return {
    time: chartTime(candle.time),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
  }
}

function buildEma(candles: Candle[], period: number): LineData<Time>[] {
  if (candles.length < period) return []

  const multiplier = 2 / (period + 1)
  let previous = candles.slice(0, period).reduce((sum, candle) => sum + candle.close, 0) / period
  const points: LineData<Time>[] = [
    {
      time: chartTime(candles[period - 1].time),
      value: previous,
    },
  ]

  for (let i = period; i < candles.length; i += 1) {
    previous = (candles[i].close - previous) * multiplier + previous
    points.push({
      time: chartTime(candles[i].time),
      value: previous,
    })
  }

  return points
}

function formatTime(time: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(time))
}

function formatVolume(value: number) {
  if (!Number.isFinite(value)) return '--'
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

function readoutToneClass(tone?: 'up' | 'down' | 'accent' | 'warning' | 'mondayLow') {
  if (tone === 'up') return 'text-up'
  if (tone === 'down') return 'text-down'
  if (tone === 'accent') return 'text-[var(--chart-2)]'
  if (tone === 'warning') return 'text-[var(--chart-3)]'
  if (tone === 'mondayLow') return 'text-[var(--chart-5)]'
  return 'text-foreground'
}

function ReadoutItem({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'up' | 'down' | 'accent' | 'warning' | 'mondayLow'
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-muted-foreground">{label}</span>
      <span className={readoutToneClass(tone)}>{value}</span>
    </span>
  )
}

export function CandlestickChart({
  candles,
  levels,
  rangeKey,
  showEma20 = true,
}: {
  candles: Candle[]
  levels?: MarketLevels
  rangeKey: string
  showEma20?: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick', Time> | null>(null)
  const emaSeriesRef = useRef<ISeriesApi<'Line', Time> | null>(null)
  const priceLinesRef = useRef<IPriceLine[]>([])
  const candleByTimeRef = useRef(new Map<Time, Candle>())
  const emaByTimeRef = useRef(new Map<Time, number>())
  const initialRangeAppliedRef = useRef(false)
  const ema20 = useMemo(() => (showEma20 ? buildEma(candles, EMA_PERIOD) : []), [candles, showEma20])
  const [hoveredCandle, setHoveredCandle] = useState<CandleReadout | null>(null)

  const latestCandle = candles.at(-1)
  const latestEma = ema20.at(-1)?.value
  const displayCandle =
    hoveredCandle ??
    (latestCandle
      ? {
          ...latestCandle,
          ema20: typeof latestEma === 'number' ? latestEma : undefined,
        }
      : null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const colors = chartColors()
    const chart = createChart(container, baseChartOptions())
    const series = chart.addCandlestickSeries({
      upColor: colors.up,
      downColor: colors.down,
      borderUpColor: colors.up,
      borderDownColor: colors.down,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
      priceLineVisible: true,
      lastValueVisible: true,
    })

    chartRef.current = chart
    candleSeriesRef.current = series
    emaSeriesRef.current = null
    priceLinesRef.current = []
    initialRangeAppliedRef.current = false
    setHoveredCandle(null)

    const onCrosshairMove = (param: MouseEventParams<Time>) => {
      if (!param.time) {
        setHoveredCandle(null)
        return
      }

      const candle = candleByTimeRef.current.get(param.time)
      setHoveredCandle(candle ? { ...candle, ema20: emaByTimeRef.current.get(param.time) } : null)
    }
    chart.subscribeCrosshairMove(onCrosshairMove)

    return () => {
      chart.unsubscribeCrosshairMove(onCrosshairMove)
      chart.remove()
      chartRef.current = null
      candleSeriesRef.current = null
      emaSeriesRef.current = null
      priceLinesRef.current = []
    }
  }, [rangeKey])

  useEffect(() => {
    const chart = chartRef.current
    const series = candleSeriesRef.current
    if (!chart || !series) return

    const data = candles.map(toCandlestickData)
    const candleByTime = new Map<Time, Candle>()
    const emaByTime = new Map<Time, number>()
    for (const candle of candles) candleByTime.set(chartTime(candle.time), candle)
    for (const point of ema20) emaByTime.set(point.time, point.value)
    candleByTimeRef.current = candleByTime
    emaByTimeRef.current = emaByTime

    series.setData(data)

    if (!initialRangeAppliedRef.current) {
      if (data.length > INITIAL_VISIBLE_BARS) {
        chart.timeScale().setVisibleLogicalRange({
          from: data.length - INITIAL_VISIBLE_BARS,
          to: data.length + 4,
        })
      } else {
        chart.timeScale().fitContent()
      }
      initialRangeAppliedRef.current = true
    }
  }, [candles, ema20])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return

    const colors = chartColors()
    if (!showEma20) {
      if (emaSeriesRef.current) chart.removeSeries(emaSeriesRef.current)
      emaSeriesRef.current = null
      return
    }

    if (!emaSeriesRef.current) {
      emaSeriesRef.current = chart.addLineSeries({
        color: colors.accent,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        title: 'EMA20',
      })
    }
    emaSeriesRef.current.setData(ema20)
  }, [ema20, showEma20])

  useEffect(() => {
    const series = candleSeriesRef.current
    if (!series) return

    const colors = chartColors()
    for (const line of priceLinesRef.current) series.removePriceLine(line)
    priceLinesRef.current = []

    if (!levels?.monday) return

    priceLinesRef.current = [
      series.createPriceLine({
        price: levels.monday.high,
        color: colors.warning,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'Monday High',
      }),
      series.createPriceLine({
        price: levels.monday.low,
        color: colors.mondayLow,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'Monday Low',
      }),
    ]
  }, [levels])

  return (
    <div className="relative h-full w-full">
      {displayCandle && (
        <div className="pointer-events-none absolute left-3 top-3 z-10 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-x-3 gap-y-1 rounded border border-border bg-background/90 px-2 py-1.5 font-mono text-[11px] leading-none shadow-sm backdrop-blur">
          <ReadoutItem label="T" value={formatTime(displayCandle.time)} />
          <ReadoutItem label="O" value={formatPrice(displayCandle.open)} />
          <ReadoutItem label="H" value={formatPrice(displayCandle.high)} tone="up" />
          <ReadoutItem label="L" value={formatPrice(displayCandle.low)} tone="down" />
          <ReadoutItem label="C" value={formatPrice(displayCandle.close)} />
          <ReadoutItem label="Vol" value={formatVolume(displayCandle.volume)} />
          {levels?.monday && (
            <>
              <ReadoutItem label="Mon H" value={formatPrice(levels.monday.high)} tone="warning" />
              <ReadoutItem label="Mon L" value={formatPrice(levels.monday.low)} tone="mondayLow" />
            </>
          )}
          {showEma20 && (
            <ReadoutItem
              label="EMA20"
              value={displayCandle.ema20 == null ? '--' : formatPrice(displayCandle.ema20)}
              tone="accent"
            />
          )}
        </div>
      )}
      <div ref={containerRef} className="h-full w-full" aria-label="K线走势图" />
    </div>
  )
}
