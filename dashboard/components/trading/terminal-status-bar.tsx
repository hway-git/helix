'use client'

import Image from 'next/image'
import {
  Database,
  Lock,
} from 'lucide-react'
import { cn } from '@/lib/utils'

type MarketSource = {
  name: string
  market: string
  status: 'live' | 'partial'
  fetchedAt: number
  errors: string[]
} | null

type StreamStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'error'

type StreamHealth = {
  tickerStatus: StreamStatus
  candleStatus: StreamStatus
  lastMessageAt: number | null
}

function isStreamDegraded(stream?: StreamHealth) {
  if (!stream) return false
  return [stream.tickerStatus, stream.candleStatus].some((status) => status === 'reconnecting' || status === 'error')
}

function streamStatusLabel(stream?: StreamHealth) {
  if (!stream) return null
  if (stream.tickerStatus === 'live' && stream.candleStatus === 'live') return 'WS 实时'
  if (isStreamDegraded(stream)) return stream.tickerStatus === 'error' || stream.candleStatus === 'error' ? 'WS 异常' : 'WS 重连'
  if (stream.tickerStatus === 'connecting' || stream.candleStatus === 'connecting') return 'WS 连接中'
  return null
}

function StatusChip({
  icon,
  label,
  tone = 'neutral',
}: {
  icon: React.ReactNode
  label: string
  tone?: 'neutral' | 'up' | 'warn' | 'locked'
}) {
  return (
    <span
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded border px-2 text-[11px] tabular-nums',
        tone === 'neutral' && 'border-border bg-background/50 text-muted-foreground',
        tone === 'up' && 'border-up/30 bg-up/10 text-up',
        tone === 'warn' && 'border-[var(--chart-3)]/40 bg-[var(--chart-3)]/10 text-[var(--chart-3)]',
        tone === 'locked' && 'border-down/30 bg-down/10 text-down',
      )}
    >
      <span className="flex size-3.5 items-center justify-center [&_svg]:block [&_svg]:size-3.5 [&_svg]:shrink-0">
        {icon}
      </span>
      <span className="flex h-3.5 translate-y-px items-center font-mono leading-[14px]">{label}</span>
    </span>
  )
}

export function TerminalStatusBar({
  source,
  loading,
  error,
  stream,
}: {
  source: MarketSource
  loading: boolean
  error: string | null
  stream?: StreamHealth
}) {
  const updatedAt = source
    ? new Date(source.fetchedAt).toLocaleTimeString('zh-CN', { hour12: false })
    : '--:--:--'
  const streamLabel = streamStatusLabel(stream)
  const streamDegraded = isStreamDegraded(stream)
  const dataLabel = error
    ? '行情异常'
    : loading
      ? '行情更新中'
      : streamDegraded
        ? `行情 ${streamLabel}`
        : source?.status === 'live'
          ? `行情 ${streamLabel ?? '实时'}`
          : '行情 REST 补偿'
  const dataTone = error || streamDegraded ? 'warn' : source?.status === 'live' ? 'up' : 'neutral'

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-sidebar px-3">
      <div className="flex items-center gap-2 pr-2">
        <div className="flex size-7 items-center justify-center overflow-hidden rounded bg-background ring-1 ring-border">
          <Image
            src="/helix-logo.png"
            alt="Helix"
            width={28}
            height={28}
            className="size-7 object-cover"
            priority
          />
        </div>
        <div className="leading-none">
          <div className="text-sm font-bold tracking-tight">
            HELIX<span className="text-primary">.</span>TERMINAL
          </div>
          <div className="mt-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">CoinOS Agent</div>
        </div>
      </div>

      <div className="ml-auto hidden min-w-0 items-center gap-2 xl:flex">
        <StatusChip icon={<Database className="size-3.5" />} label={dataLabel} tone={dataTone} />
        <StatusChip icon={<Lock className="size-3.5" />} label="实盘锁定" tone="locked" />
      </div>

      <div className="ml-auto flex items-center gap-1 font-mono text-muted-foreground xl:ml-0">
        <span className="text-[10px]">更新</span>
        <span className="text-xs">{updatedAt}</span>
      </div>
    </header>
  )
}
