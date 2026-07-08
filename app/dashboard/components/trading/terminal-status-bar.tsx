'use client'

import Image from 'next/image'
import {
  Bell,
  Database,
  Lock,
  Settings,
  ShieldCheck,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const modes = ['行情', '回测', '实盘', '执行', '审计']

type MarketSource = {
  name: string
  market: string
  status: 'live' | 'partial'
  fetchedAt: number
  errors: string[]
} | null

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
}: {
  source: MarketSource
  loading: boolean
  error: string | null
}) {
  const updatedAt = source
    ? new Date(source.fetchedAt).toLocaleTimeString('zh-CN', { hour12: false })
    : '--:--:--'
  const marketName = source?.market?.toUpperCase() ?? 'OKX'
  const dataLabel = error ? '行情异常' : loading ? '行情更新中' : source?.status === 'live' ? `${marketName} 实时` : `${marketName} 部分`
  const dataTone = error ? 'warn' : source?.status === 'live' ? 'up' : 'neutral'

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

      <nav className="hidden items-center gap-1 md:flex">
        {modes.map((item, i) => (
          <button
            key={item}
            className={cn(
              'inline-flex h-7 items-center justify-center rounded px-2.5 text-xs leading-none transition-colors',
              i === 0 ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
            )}
          >
            {item}
          </button>
        ))}
      </nav>

      <div className="ml-auto hidden min-w-0 items-center gap-2 xl:flex">
        <StatusChip icon={<Database className="size-3.5" />} label={dataLabel} tone={dataTone} />
        <StatusChip icon={<ShieldCheck className="size-3.5" />} label="风控正常" tone="up" />
        <StatusChip icon={<Lock className="size-3.5" />} label="实盘锁定" tone="locked" />
      </div>

      <div className="ml-auto flex items-center gap-2 xl:ml-0">
        <div className="hidden items-center gap-1 font-mono sm:flex">
          <span className="text-[10px] text-muted-foreground">更新</span>
          <span className="text-xs text-muted-foreground">{updatedAt}</span>
        </div>
        <button aria-label="通知" title="通知" className="text-muted-foreground transition-colors hover:text-foreground">
          <Bell className="size-4" />
        </button>
        <button aria-label="设置" title="设置" className="text-muted-foreground transition-colors hover:text-foreground">
          <Settings className="size-4" />
        </button>
      </div>
    </header>
  )
}
