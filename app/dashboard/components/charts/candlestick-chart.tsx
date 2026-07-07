'use client'

import { useEffect, useRef } from 'react'
import { createChart, type CandlestickData, type Time } from 'lightweight-charts'
import type { Candle } from '@/lib/market-data'
import { baseChartOptions, chartColors, chartTime } from './lightweight-utils'

export function CandlestickChart({ candles }: { candles: Candle[] }) {
  const containerRef = useRef<HTMLDivElement>(null)

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

    const data: CandlestickData<Time>[] = candles.map((candle) => ({
      time: chartTime(candle.time),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    }))

    series.setData(data)
    chart.timeScale().fitContent()

    const resizeObserver = new ResizeObserver(() => {
      chart.timeScale().fitContent()
    })
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      chart.remove()
    }
  }, [candles])

  return <div ref={containerRef} className="h-full w-full" aria-label="K线走势图" />
}
