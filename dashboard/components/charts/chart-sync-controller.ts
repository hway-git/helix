import type { IChartApi, LogicalRange, MouseEventParams, Time } from 'lightweight-charts'

type ChartSyncParticipant = {
  chart: IChartApi
  setCrosshairTime: (time: Time | null) => void
  onCrosshairTime?: (time: Time | null) => void
}

type RegisteredParticipant = ChartSyncParticipant & {
  suppressCrosshair: boolean
  suppressRange: boolean
}

function releaseOnNextFrame(callback: () => void) {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(callback)
    return
  }
  queueMicrotask(callback)
}

export class ChartSyncController {
  private readonly participants = new Set<RegisteredParticipant>()
  private visibleLogicalRange: LogicalRange | null = null

  register(participant: ChartSyncParticipant) {
    const registered: RegisteredParticipant = {
      ...participant,
      suppressCrosshair: false,
      suppressRange: false,
    }

    const onVisibleLogicalRangeChange = (range: LogicalRange | null) => {
      if (!range || registered.suppressRange) return

      this.visibleLogicalRange = { ...range }
      for (const target of this.participants) {
        if (target !== registered) this.setVisibleLogicalRange(target, range)
      }
    }

    const onCrosshairMove = (param: MouseEventParams<Time>) => {
      if (registered.suppressCrosshair) return

      const time = param.time ?? null
      for (const target of this.participants) {
        target.onCrosshairTime?.(time)
        if (target !== registered) this.setCrosshairTime(target, time)
      }
    }

    this.participants.add(registered)
    participant.chart.timeScale().subscribeVisibleLogicalRangeChange(onVisibleLogicalRangeChange)
    participant.chart.subscribeCrosshairMove(onCrosshairMove)

    return () => {
      participant.chart.timeScale().unsubscribeVisibleLogicalRangeChange(onVisibleLogicalRangeChange)
      participant.chart.unsubscribeCrosshairMove(onCrosshairMove)
      this.participants.delete(registered)
    }
  }

  applyVisibleLogicalRange(chart: IChartApi) {
    if (!this.visibleLogicalRange) return false

    const participant = [...this.participants].find((item) => item.chart === chart)
    if (!participant) return false

    this.setVisibleLogicalRange(participant, this.visibleLogicalRange)
    return true
  }

  private setVisibleLogicalRange(participant: RegisteredParticipant, range: LogicalRange) {
    participant.suppressRange = true
    participant.chart.timeScale().setVisibleLogicalRange(range)
    releaseOnNextFrame(() => {
      participant.suppressRange = false
    })
  }

  private setCrosshairTime(participant: RegisteredParticipant, time: Time | null) {
    participant.suppressCrosshair = true
    participant.setCrosshairTime(time)
    releaseOnNextFrame(() => {
      participant.suppressCrosshair = false
    })
  }
}
