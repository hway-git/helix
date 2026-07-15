'use client'

import { useEffect, useRef } from 'react'
import {
  createChart,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type Time,
  type WhitespaceData,
} from 'lightweight-charts'
import type { Candle, RsiPoint } from '@/lib/market-data'
import { type ChartSyncController } from './chart-sync-controller'
import { baseChartOptions, chartColors, chartTime } from './lightweight-utils'

export function RSIChart({
  points,
  candles,
  sync,
}: {
  points: RsiPoint[]
  candles: Candle[]
  sync: ChartSyncController
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const rangeSeriesRef = useRef<ISeriesApi<'Line', Time> | null>(null)
  const rsiSeriesRef = useRef<ISeriesApi<'Line', Time> | null>(null)
  const valueByTimeRef = useRef(new Map<Time, number>())
  const initialRangeAppliedRef = useRef(false)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const colors = chartColors()
    const chart = createChart(container, {
      ...baseChartOptions(),
      timeScale: {
        ...baseChartOptions().timeScale,
        timeVisible: false,
      },
      rightPriceScale: {
        ...baseChartOptions().rightPriceScale,
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
    })

    const rangeSeries = chart.addLineSeries({
      color: 'transparent',
      lineWidth: 1,
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
    })
    const rsiSeries = chart.addLineSeries({
      color: colors.warning,
      lineWidth: 2,
      lastValueVisible: true,
      priceLineVisible: false,
      priceFormat: {
        type: 'price',
        precision: 1,
        minMove: 0.1,
      },
    })

    ;[
      { price: 70, color: colors.down, title: '70' },
      { price: 50, color: colors.grid, title: '50' },
      { price: 30, color: colors.up, title: '30' },
    ].forEach((line) => {
      rsiSeries.createPriceLine({
        price: line.price,
        color: line.color,
        lineStyle: line.price === 50 ? LineStyle.Solid : LineStyle.Dashed,
        lineWidth: 1,
        axisLabelVisible: true,
        title: line.title,
      })
    })

    chartRef.current = chart
    rangeSeriesRef.current = rangeSeries
    rsiSeriesRef.current = rsiSeries
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
        chart.setCrosshairPosition(value, time, rsiSeries)
      },
    })

    return () => {
      unregisterSync()
      chart.remove()
      chartRef.current = null
      rangeSeriesRef.current = null
      rsiSeriesRef.current = null
    }
  }, [sync])

  useEffect(() => {
    const chart = chartRef.current
    const rangeSeries = rangeSeriesRef.current
    const rsiSeries = rsiSeriesRef.current
    if (!chart || !rangeSeries || !rsiSeries) return

    const data: LineData<Time>[] = points.map((point) => ({
      time: chartTime(point.time),
      value: point.value,
    }))
    valueByTimeRef.current = new Map(data.map((point) => [point.time, point.value]))

    const timelineData: Array<LineData<Time> | WhitespaceData<Time>> = candles.map((candle, index) => {
      const time = chartTime(candle.time)
      if (index === 0) return { time, value: 0 }
      if (index === candles.length - 1) return { time, value: 100 }
      return { time }
    })
    rangeSeries.setData(timelineData)
    rsiSeries.setData(data)

    if (!initialRangeAppliedRef.current) {
      if (!sync.applyVisibleLogicalRange(chart)) chart.timeScale().fitContent()
      initialRangeAppliedRef.current = true
    }
  }, [candles, points, sync])

  return <div ref={containerRef} className="h-full w-full" aria-label="RSI 指标图" />
}
