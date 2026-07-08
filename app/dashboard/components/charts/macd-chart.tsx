'use client'

import { useEffect, useRef } from 'react'
import { createChart, type HistogramData, type LineData, type Time } from 'lightweight-charts'
import type { MacdPoint } from '@/lib/market-data'
import { baseChartOptions, chartColors, chartTime } from './lightweight-utils'

export function MACDChart({ points }: { points: MacdPoint[] }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const colors = chartColors()
    const chart = createChart(container, baseChartOptions())

    const histogram = chart.addHistogramSeries({
      base: 0,
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: {
        type: 'price',
        precision: 2,
        minMove: 0.01,
      },
    })
    const macdLine = chart.addLineSeries({
      color: colors.accent,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    })
    const signalLine = chart.addLineSeries({
      color: colors.warning,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    })

    const histogramData: HistogramData<Time>[] = points.map((point) => ({
      time: chartTime(point.time),
      value: point.hist,
      color: point.hist >= 0 ? colors.up : colors.down,
    }))
    const macdData: LineData<Time>[] = points.map((point) => ({
      time: chartTime(point.time),
      value: point.macd,
    }))
    const signalData: LineData<Time>[] = points.map((point) => ({
      time: chartTime(point.time),
      value: point.signal,
    }))

    histogram.setData(histogramData)
    macdLine.setData(macdData)
    signalLine.setData(signalData)
    chart.timeScale().fitContent()

    const resizeObserver = new ResizeObserver(() => {
      chart.timeScale().fitContent()
    })
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      chart.remove()
    }
  }, [points])

  return <div ref={containerRef} className="h-full w-full" aria-label="MACD 指标图" />
}
