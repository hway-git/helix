'use client'

import { cn } from '@/lib/utils'
import { formatPrice, type TradingPair } from '@/lib/market-data'

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span
        className={cn(
          'font-mono text-sm tabular-nums',
          tone === 'up' && 'text-up',
          tone === 'down' && 'text-down',
        )}
      >
        {value}
      </span>
    </div>
  )
}

function formatFundingRate(rate?: number) {
  if (rate == null || !Number.isFinite(rate)) return '--'
  return `${(rate * 100).toFixed(4)}%`
}

export function SymbolHeader({ pair }: { pair: TradingPair }) {
  const positive = pair.change >= 0
  const contractLabel = pair.contractType === 'perpetual' ? '永续' : '现货'
  const fundingTone = pair.fundingRate == null ? undefined : pair.fundingRate >= 0 ? 'up' : 'down'

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-border bg-card/40 px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="flex size-8 items-center justify-center rounded-md bg-primary/15 font-mono text-xs font-bold text-primary">
          {pair.base.slice(0, 3)}
        </div>
        <div>
          <div className="flex items-center gap-2 text-base font-semibold leading-none">
            {pair.base}
            <span className="text-muted-foreground">/{pair.quote}</span>
            <span className="inline-flex h-5 items-center rounded bg-muted px-1.5 text-[10px] font-normal text-muted-foreground">
              {contractLabel}
            </span>
          </div>
          <div className="text-[11px] text-muted-foreground">
            {contractLabel} · {pair.instrumentId}
          </div>
        </div>
      </div>

      <div className="flex items-baseline gap-2">
        <span className={cn('font-mono text-2xl font-semibold tabular-nums', positive ? 'text-up' : 'text-down')}>
          {formatPrice(pair.price)}
        </span>
        <span className={cn('font-mono text-sm tabular-nums', positive ? 'text-up' : 'text-down')}>
          {positive ? '+' : ''}
          {pair.change.toFixed(2)}%
        </span>
      </div>

      <div className="ml-auto flex items-center gap-6">
        <Stat label="24h 最高" value={pair.high24h == null ? '--' : formatPrice(pair.high24h)} tone="up" />
        <Stat label="24h 最低" value={pair.low24h == null ? '--' : formatPrice(pair.low24h)} tone="down" />
        <Stat label="24h 量" value={pair.volume} />
        <Stat label="资金费率" value={formatFundingRate(pair.fundingRate)} tone={fundingTone} />
        <Stat label="数据源" value={pair.stale ? 'STALE' : 'LIVE'} />
      </div>
    </div>
  )
}
