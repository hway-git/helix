'use client'

import { useState } from 'react'
import {
  ClipboardList,
  FlaskConical,
  History,
  ListChecks,
  PanelBottomClose,
  PanelBottomOpen,
  ShieldCheck,
  Wallet,
} from 'lucide-react'
import { cn } from '@/lib/utils'

type TabId = 'positions' | 'orders' | 'backtest' | 'risk' | 'audit'
type TableRow = Record<string, string | number>

const tabs: Array<{ id: TabId; label: string; icon: React.ElementType }> = [
  { id: 'positions', label: '持仓', icon: Wallet },
  { id: 'orders', label: '订单', icon: ClipboardList },
  { id: 'backtest', label: '回测', icon: FlaskConical },
  { id: 'risk', label: '风控', icon: ShieldCheck },
  { id: 'audit', label: '审计', icon: History },
]

const positions: TableRow[] = [
  { symbol: 'BTC/USDT', side: 'Long', size: '0.42 BTC', entry: '63,180.5', mark: '64,218.5', pnl: '+436.0', risk: '0.36R' },
  { symbol: 'ETH/USDT', side: 'Long', size: '3.20 ETH', entry: '3,101.7', mark: '3,142.9', pnl: '+131.8', risk: '0.22R' },
  { symbol: 'SOL/USDT', side: 'Short', size: '80 SOL', entry: '151.4', mark: '148.2', pnl: '+256.0', risk: '0.31R' },
]

const orders: TableRow[] = [
  { id: 'O-1942', symbol: 'BTC/USDT', type: 'Stop Market', side: 'Sell', price: '62,400.0', status: '已提交' },
  { id: 'O-1943', symbol: 'ETH/USDT', type: 'Limit', side: 'Buy', price: '3,068.0', status: '等待成交' },
  { id: 'O-1944', symbol: 'SOL/USDT', type: 'Take Profit', side: 'Buy', price: '144.8', status: '等待触发' },
]

const backtests: TableRow[] = [
  { strategy: 'Trend Rider', range: '2025-01-01 / 2026-06-30', trades: 186, win: '58.4%', sharpe: '1.72', dd: '7.8%' },
  { strategy: 'Mean Revert', range: '2025-07-01 / 2026-06-30', trades: 92, win: '54.1%', sharpe: '1.18', dd: '5.2%' },
  { strategy: 'Breakout Scalper', range: '2026-01-01 / 2026-06-30', trades: 268, win: '49.6%', sharpe: '0.86', dd: '11.3%' },
]

const riskRules: TableRow[] = [
  { rule: '单笔风险', value: '0.50%', state: '正常' },
  { rule: '日内最大亏损', value: '2.00%', state: '正常' },
  { rule: '最大并发持仓', value: '3 / 5', state: '正常' },
  { rule: '实盘开关', value: 'Locked', state: '锁定' },
]

const audit: TableRow[] = [
  { time: '09:42:18', actor: 'Agent', event: '生成 BTC/USDT 入场预览', result: '等待确认' },
  { time: '09:41:02', actor: 'Risk', event: '检查日内亏损阈值', result: '通过' },
  { time: '09:39:56', actor: 'Backtest', event: 'Trend Rider 15m 回测完成', result: '通过' },
]

function DataTable({
  columns,
  rows,
}: {
  columns: string[]
  rows: TableRow[]
}) {
  return (
    <div className="h-full overflow-auto scrollbar-thin">
      <table className="w-full min-w-[720px] border-separate border-spacing-0 text-left text-xs">
        <thead className="sticky top-0 z-10 bg-sidebar text-[10px] uppercase tracking-wider text-muted-foreground">
          <tr>
            {columns.map((column) => (
              <th key={column} className="border-b border-border px-3 py-2 font-medium">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="font-mono hover:bg-muted/30">
              {columns.map((column) => {
                const value = row[column]
                const positive = typeof value === 'string' && value.startsWith('+')
                const locked = value === '锁定' || value === 'Locked'
                return (
                  <td
                    key={column}
                    className={cn(
                      'border-b border-border/60 px-3 py-2 tabular-nums',
                      positive && 'text-up',
                      locked && 'text-down',
                    )}
                  >
                    {value}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function renderPanel(active: TabId) {
  if (active === 'positions') {
    return (
      <DataTable
        columns={['symbol', 'side', 'size', 'entry', 'mark', 'pnl', 'risk']}
        rows={positions}
      />
    )
  }
  if (active === 'orders') {
    return (
      <DataTable
        columns={['id', 'symbol', 'type', 'side', 'price', 'status']}
        rows={orders}
      />
    )
  }
  if (active === 'backtest') {
    return (
      <DataTable
        columns={['strategy', 'range', 'trades', 'win', 'sharpe', 'dd']}
        rows={backtests}
      />
    )
  }
  if (active === 'risk') {
    return (
      <DataTable
        columns={['rule', 'value', 'state']}
        rows={riskRules}
      />
    )
  }
  return (
    <DataTable
      columns={['time', 'actor', 'event', 'result']}
      rows={audit}
    />
  )
}

export function BottomWorkbench() {
  const [active, setActive] = useState<TabId>('positions')
  const [collapsed, setCollapsed] = useState(false)

  return (
    <section
      className={cn(
        'flex shrink-0 flex-col border-t border-border bg-sidebar',
        collapsed ? 'h-10' : 'h-[238px]',
      )}
    >
      <div className={cn('flex h-10 items-center justify-between', !collapsed && 'border-b border-border')}>
        <div className="flex h-full items-center">
          {tabs.map((tab) => {
            const Icon = tab.icon
            const selected = active === tab.id
            return (
              <button
                key={tab.id}
                onClick={() => {
                  setActive(tab.id)
                  if (collapsed) setCollapsed(false)
                }}
                className={cn(
                  'inline-flex h-full items-center gap-1.5 border-r border-border px-3 text-xs leading-none transition-colors [&_svg]:shrink-0',
                  selected ? 'bg-background text-foreground' : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                )}
              >
                <Icon className="size-3.5" />
                {tab.label}
              </button>
            )
          })}
        </div>
        <div className="flex items-center gap-2 px-2">
          <div className="hidden items-center gap-2 font-mono text-[10px] leading-none text-muted-foreground sm:flex">
            <ListChecks className="size-3.5 text-up" />
            EVENT_LOG_SYNCED
          </div>
          <button
            type="button"
            aria-label={collapsed ? '展开底部控制台' : '收起底部控制台'}
            title={collapsed ? '展开底部控制台' : '收起底部控制台'}
            onClick={() => setCollapsed((value) => !value)}
            className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {collapsed ? <PanelBottomOpen className="size-4" /> : <PanelBottomClose className="size-4" />}
          </button>
        </div>
      </div>
      {!collapsed && <div className="min-h-0 flex-1">{renderPanel(active)}</div>}
    </section>
  )
}
