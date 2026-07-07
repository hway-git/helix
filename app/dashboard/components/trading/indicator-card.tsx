'use client'

import { ChevronUp, ChevronDown, X, Maximize2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export function IndicatorCard({
  title,
  badge,
  readout,
  height = 'h-64',
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onRemove,
  children,
}: {
  title: string
  badge?: string
  readout?: React.ReactNode
  height?: string
  canMoveUp: boolean
  canMoveDown: boolean
  onMoveUp: () => void
  onMoveDown: () => void
  onRemove: () => void
  children: React.ReactNode
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2 leading-none">
        <h3 className="text-xs font-semibold tracking-wide">{title}</h3>
        {badge && (
          <span className="inline-flex h-5 items-center rounded border border-border bg-muted/50 px-1.5 font-mono text-[10px] text-muted-foreground">
            {badge}
          </span>
        )}
        {readout && <div className="ml-1 flex items-center gap-3 font-mono text-[11px]">{readout}</div>}
        <div className="ml-auto flex items-center gap-0.5">
          <IconBtn label="上移" disabled={!canMoveUp} onClick={onMoveUp}>
            <ChevronUp className="size-3.5" />
          </IconBtn>
          <IconBtn label="下移" disabled={!canMoveDown} onClick={onMoveDown}>
            <ChevronDown className="size-3.5" />
          </IconBtn>
          <IconBtn label="全屏">
            <Maximize2 className="size-3" />
          </IconBtn>
          <IconBtn label="移除卡片" onClick={onRemove} danger>
            <X className="size-3.5" />
          </IconBtn>
        </div>
      </header>
      <div className={cn('relative w-full px-1 py-1', height)}>{children}</div>
    </section>
  )
}

function IconBtn({
  children,
  label,
  onClick,
  disabled,
  danger,
}: {
  children: React.ReactNode
  label: string
  onClick?: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex size-6 items-center justify-center rounded text-muted-foreground transition-colors',
        'hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-25',
        danger && 'hover:bg-down/15 hover:text-down',
      )}
    >
      {children}
    </button>
  )
}
