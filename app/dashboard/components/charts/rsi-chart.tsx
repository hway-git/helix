'use client'

import { useEffect, useRef } from 'react'
import { createChart, LineStyle, type LineData, type Time } from 'lightweight-charts'
import { baseChartOptions, chartColors } from './lightweight-utils'

function rsiTime(index: number): Time {
  return (index + 1) as Time
}

export function RSIChart({ values }: { values: number[] }) {
  const containerRef = useRef<HTMLDivElement>(null)

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

    const data: LineData<Time>[] = values
      .map((value, index) => ({ time: rsiTime(index), value }))
      .filter((point) => !Number.isNaN(point.value))

    if (values.length > 1) {
      rangeSeries.setData([
        { time: rsiTime(0), value: 0 },
        { time: rsiTime(values.length - 1), value: 100 },
      ])
    }
    rsiSeries.setData(data)

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

    chart.timeScale().fitContent()

    const resizeObserver = new ResizeObserver(() => {
      chart.timeScale().fitContent()
    })
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      chart.remove()
    }
  }, [values])

  return <div ref={containerRef} className="h-full w-full" aria-label="RSI 指标图" />
}
