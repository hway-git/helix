'use client'

import { useEffect, useRef } from 'react'
import { createChart, type HistogramData, type Time } from 'lightweight-charts'
import type { Candle } from '@/lib/market-data'
import { baseChartOptions, chartColors, chartTime } from './lightweight-utils'

export function VolumeChart({ candles }: { candles: Candle[] }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const colors = chartColors()
    const chart = createChart(container, {
      ...baseChartOptions(),
      rightPriceScale: {
        ...baseChartOptions().rightPriceScale,
        scaleMargins: { top: 0.08, bottom: 0 },
      },
    })
    const histogram = chart.addHistogramSeries({
      base: 0,
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: {
        type: 'volume',
      },
    })

    const data: HistogramData<Time>[] = candles.map((candle) => ({
      time: chartTime(candle.time),
      value: candle.volume,
      color: candle.close >= candle.open ? colors.up : colors.down,
    }))

    histogram.setData(data)
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

  return <div ref={containerRef} className="h-full w-full" aria-label="成交量图" />
}
