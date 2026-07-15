'use client'

import { useEffect, useRef } from 'react'
import type { AgentMarketChartResult } from '@helix/contracts/agent'
import {
  createChart,
  LineStyle,
  type IPriceLine,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts'
import { baseChartOptions, chartColors, chartTime } from '../charts/lightweight-utils'

export function AgentMarketChart({ chart }: { chart: AgentMarketChartResult }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const colors = chartColors()
    const api = createChart(container, baseChartOptions())
    const series = api.addCandlestickSeries({
      upColor: colors.up,
      downColor: colors.down,
      borderUpColor: colors.up,
      borderDownColor: colors.down,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
      priceLineVisible: true,
      lastValueVisible: true,
    })
    series.setData(chart.candles.map((candle) => ({
      time: chartTime(candle.time),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    })))
    const markers: SeriesMarker<Time>[] = chart.annotations.flatMap((annotation) => {
      if (annotation.type === 'price-line') return []
      const short = annotation.direction === 'short'
      return [{
        time: chartTime(annotation.time),
        position: short ? 'aboveBar' : 'belowBar',
        shape: annotation.type === 'expectation'
          ? short ? 'arrowDown' : 'arrowUp'
          : 'circle',
        color: short ? colors.down : annotation.direction === 'long' ? colors.up : colors.warning,
        text: annotation.text,
      }]
    })
    series.setMarkers(markers.sort((left, right) => Number(left.time) - Number(right.time)))
    const lines: IPriceLine[] = chart.annotations.flatMap((annotation) => (
      annotation.type === 'price-line'
        ? [series.createPriceLine({
            price: annotation.price,
            color: colors.warning,
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: annotation.text,
          })]
        : []
    ))
    api.timeScale().fitContent()
    return () => {
      for (const line of lines) series.removePriceLine(line)
      api.remove()
    }
  }, [chart])

  return (
    <div className="overflow-hidden rounded border border-border bg-background/35">
      <div className="flex items-center justify-between border-b border-border px-2.5 py-2 font-mono text-[10px] text-muted-foreground">
        <span>{chart.symbol} · {chart.timeframe}</span>
        <span>{chart.source.name}</span>
      </div>
      <div ref={containerRef} className="h-56 w-full" aria-label={`${chart.symbol} ${chart.timeframe} 市场图表`} />
    </div>
  )
}
