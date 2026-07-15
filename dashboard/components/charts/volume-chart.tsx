'use client'

import { useEffect, useRef } from 'react'
import { createChart, type HistogramData, type IChartApi, type ISeriesApi, type Time } from 'lightweight-charts'
import type { Candle } from '@/lib/market-data'
import { type ChartSyncController } from './chart-sync-controller'
import { baseChartOptions, chartColors, chartTime } from './lightweight-utils'

export function VolumeChart({ candles, sync }: { candles: Candle[]; sync: ChartSyncController }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const histogramRef = useRef<ISeriesApi<'Histogram', Time> | null>(null)
  const valueByTimeRef = useRef(new Map<Time, number>())
  const initialRangeAppliedRef = useRef(false)

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

    chartRef.current = chart
    histogramRef.current = histogram
    initialRangeAppliedRef.current = false

    const unregisterSync = sync.register({
      chart,
      setCrosshairTime: (time) => {
        if (time == null) {
          chart.clearCrosshairPosition()
          return
        }
        const value = valueByTimeRef.current.get(time)
        if (value == null) {
          chart.clearCrosshairPosition()
          return
        }
        chart.setCrosshairPosition(value, time, histogram)
      },
    })

    return () => {
      unregisterSync()
      chart.remove()
      chartRef.current = null
      histogramRef.current = null
    }
  }, [sync])

  useEffect(() => {
    const chart = chartRef.current
    const histogram = histogramRef.current
    if (!chart || !histogram) return

    const colors = chartColors()
    const data: HistogramData<Time>[] = candles.map((candle) => ({
      time: chartTime(candle.time),
      value: candle.volume,
      color: candle.close >= candle.open ? colors.up : colors.down,
    }))
    valueByTimeRef.current = new Map(data.map((point) => [point.time, point.value]))
    histogram.setData(data)

    if (!initialRangeAppliedRef.current) {
      if (!sync.applyVisibleLogicalRange(chart)) chart.timeScale().fitContent()
      initialRangeAppliedRef.current = true
    }
  }, [candles, sync])

  return <div ref={containerRef} className="h-full w-full" aria-label="成交量图" />
}
