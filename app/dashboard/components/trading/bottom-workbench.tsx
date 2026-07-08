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

const positions: TableRow[] = []
const orders: TableRow[] = []
const backtests: TableRow[] = []

const riskRules: TableRow[] = [
  { rule: '单笔风险', value: '0.50%', state: '正常' },
  { rule: '日内最大亏损', value: '2.00%', state: '正常' },
  { rule: '最大并发持仓', value: '3 / 5', state: '正常' },
  { rule: '实盘开关', value: 'Locked', state: '锁定' },
]

const audit: TableRow[] = []

function DataTable({
  columns,
  rows,
  emptyLabel,
}: {
  columns: string[]
  rows: TableRow[]
  emptyLabel: string
}) {
  if (rows.length === 0) {
    return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">{emptyLabel}</div>
  }

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
        emptyLabel="暂无真实持仓数据"
      />
    )
  }
  if (active === 'orders') {
    return (
      <DataTable
        columns={['id', 'symbol', 'type', 'side', 'price', 'status']}
        rows={orders}
        emptyLabel="暂无真实订单数据"
      />
    )
  }
  if (active === 'backtest') {
    return (
      <DataTable
        columns={['strategy', 'range', 'trades', 'win', 'sharpe', 'dd']}
        rows={backtests}
        emptyLabel="暂无真实回测结果"
      />
    )
  }
  if (active === 'risk') {
    return (
      <DataTable
        columns={['rule', 'value', 'state']}
        rows={riskRules}
        emptyLabel="暂无风控规则"
      />
    )
  }
  return (
    <DataTable
      columns={['time', 'actor', 'event', 'result']}
      rows={audit}
      emptyLabel="暂无审计事件"
    />
  )
}

export function BottomWorkbench() {
  const [active, setActive] = useState<TabId>('positions')
  const [collapsed, setCollapsed] = useState(false)

  const selectTab = (tab: TabId) => {
    if (tab === active) {
      setCollapsed((value) => !value)
      return
    }

    setActive(tab)
    setCollapsed(false)
  }

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
                onClick={() => selectTab(tab.id)}
                aria-expanded={selected ? !collapsed : undefined}
                title={selected ? (collapsed ? `展开${tab.label}` : `收起${tab.label}`) : `打开${tab.label}`}
                className={cn(
                  'inline-flex h-full items-center gap-1.5 border-r border-border px-3 text-xs leading-none transition-colors [&_svg]:shrink-0',
                  selected ? 'bg-background text-foreground' : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                )}
              >
                <Icon className="size-3.5" />
                {tab.label}
                {selected && (
                  <span className="ml-1 text-muted-foreground">
                    {collapsed ? <PanelBottomOpen className="size-3.5" /> : <PanelBottomClose className="size-3.5" />}
                  </span>
                )}
              </button>
            )
          })}
        </div>
        <div className="flex items-center gap-2 px-3">
          <div className="hidden items-center gap-2 font-mono text-[10px] leading-none text-muted-foreground sm:flex">
            <ListChecks className="size-3.5 text-muted-foreground" />
            ACCOUNT_OFFLINE
          </div>
        </div>
      </div>
      {!collapsed && <div className="min-h-0 flex-1">{renderPanel(active)}</div>}
    </section>
  )
}
