'use client'

import {
  Activity,
  Bell,
  Database,
  Lock,
  Settings,
  ShieldCheck,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const modes = ['行情', '回测', '实盘', '执行', '审计']

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
        'inline-flex h-7 items-center gap-1.5 rounded border px-2 font-mono text-[11px] leading-none tabular-nums [&_svg]:shrink-0',
        tone === 'neutral' && 'border-border bg-background/50 text-muted-foreground',
        tone === 'up' && 'border-up/30 bg-up/10 text-up',
        tone === 'warn' && 'border-[var(--chart-3)]/40 bg-[var(--chart-3)]/10 text-[var(--chart-3)]',
        tone === 'locked' && 'border-down/30 bg-down/10 text-down',
      )}
    >
      {icon}
      {label}
    </span>
  )
}

export function TerminalStatusBar() {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-sidebar px-3">
      <div className="flex items-center gap-2 pr-2">
        <div className="flex size-7 items-center justify-center rounded bg-primary text-primary-foreground">
          <Activity className="size-4" />
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
        <StatusChip icon={<Database className="size-3.5" />} label="模拟数据" tone="warn" />
        <StatusChip icon={<ShieldCheck className="size-3.5" />} label="风控正常" tone="up" />
        <StatusChip icon={<Lock className="size-3.5" />} label="实盘锁定" tone="locked" />
      </div>

      <div className="ml-auto flex items-center gap-2 xl:ml-0">
        <div className="hidden items-center gap-1 font-mono sm:flex">
          <span className="text-[10px] text-muted-foreground">PnL</span>
          <span className="text-xs text-up">+2.84%</span>
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
