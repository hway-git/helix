import { ColorType, CrosshairMode, type DeepPartial, type ChartOptions, type Time } from 'lightweight-charts'

export function chartTime(time: number): Time {
  return Math.floor(time / 1000) as Time
}

export function chartColors() {
  return {
    background: 'transparent',
    foreground: '#e5e7eb',
    muted: '#8b949e',
    border: 'rgba(255,255,255,0.09)',
    grid: 'rgba(255,255,255,0.06)',
    up: '#22c55e',
    down: '#ef4444',
    accent: '#38bdf8',
    warning: '#eab308',
    mondayLow: '#a78bfa',
  }
}

export function baseChartOptions(): DeepPartial<ChartOptions> {
  const colors = chartColors()

  return {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: colors.background },
      textColor: colors.muted,
      fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)',
      fontSize: 10,
    },
    grid: {
      vertLines: { color: colors.grid },
      horzLines: { color: colors.grid },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
    },
    rightPriceScale: {
      borderColor: colors.border,
      scaleMargins: {
        top: 0.1,
        bottom: 0.12,
      },
    },
    timeScale: {
      borderColor: colors.border,
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 8,
      barSpacing: 8,
      fixLeftEdge: false,
      fixRightEdge: false,
    },
    handleScroll: {
      mouseWheel: true,
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: false,
    },
    handleScale: {
      axisPressedMouseMove: true,
      mouseWheel: true,
      pinch: true,
    },
  }
}
