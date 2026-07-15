'use client'

import { useEffect, useRef } from 'react'
import {
  createChart,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type Time,
  type WhitespaceData,
} from 'lightweight-charts'
import type { Candle, MacdPoint } from '@/lib/market-data'
import { type ChartSyncController } from './chart-sync-controller'
import { baseChartOptions, chartColors, chartTime } from './lightweight-utils'

export function MACDChart({
  points,
  candles,
  sync,
}: {
  points: MacdPoint[]
  candles: Candle[]
  sync: ChartSyncController
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const timelineSeriesRef = useRef<ISeriesApi<'Line', Time> | null>(null)
  const histogramRef = useRef<ISeriesApi<'Histogram', Time> | null>(null)
  const macdLineRef = useRef<ISeriesApi<'Line', Time> | null>(null)
  const signalLineRef = useRef<ISeriesApi<'Line', Time> | null>(null)
  const valueByTimeRef = useRef(new Map<Time, number>())
  const initialRangeAppliedRef = useRef(false)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const colors = chartColors()
    const chart = createChart(container, baseChartOptions())

    const timelineSeries = chart.addLineSeries({
      color: 'transparent',
      lineWidth: 1,
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
    })
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

    chartRef.current = chart
    timelineSeriesRef.current = timelineSeries
    histogramRef.current = histogram
    macdLineRef.current = macdLine
    signalLineRef.current = signalLine
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
        chart.setCrosshairPosition(value, time, macdLine)
      },
    })

    return () => {
      unregisterSync()
      chart.remove()
      chartRef.current = null
      timelineSeriesRef.current = null
      histogramRef.current = null
      macdLineRef.current = null
      signalLineRef.current = null
    }
  }, [sync])

  useEffect(() => {
    const chart = chartRef.current
    const timelineSeries = timelineSeriesRef.current
    const histogram = histogramRef.current
    const macdLine = macdLineRef.current
    const signalLine = signalLineRef.current
    if (!chart || !timelineSeries || !histogram || !macdLine || !signalLine) return

    const colors = chartColors()
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
    const timelineData: WhitespaceData<Time>[] = candles.map((candle) => ({
      time: chartTime(candle.time),
    }))
    valueByTimeRef.current = new Map(macdData.map((point) => [point.time, point.value]))

    timelineSeries.setData(timelineData)
    histogram.setData(histogramData)
    macdLine.setData(macdData)
    signalLine.setData(signalData)

    if (!initialRangeAppliedRef.current) {
      if (!sync.applyVisibleLogicalRange(chart)) chart.timeScale().fitContent()
      initialRangeAppliedRef.current = true
    }
  }, [candles, points, sync])

  return <div ref={containerRef} className="h-full w-full" aria-label="MACD 指标图" />
}
