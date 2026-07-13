'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Bot,
  ClipboardList,
  FlaskConical,
  History,
  KeyRound,
  ListChecks,
  LoaderCircle,
  Lock,
  PanelBottomClose,
  PanelBottomOpen,
  Rocket,
  ShieldCheck,
  Unlock,
  Wallet,
  X,
} from 'lucide-react'
import type { AccountSnapshot, AccountTableRow } from '@/lib/account-data'
import type {
  FreqtradeBacktestResult,
  FreqtradeDryRunDeployResult,
  FreqtradeSnapshot,
  FreqtradeTableRow,
} from '@/lib/freqtrade-data'
import { cn } from '@/lib/utils'

type TabId = 'balances' | 'positions' | 'orders' | 'history' | 'backtest' | 'automation' | 'risk' | 'audit'
type TableRow = AccountTableRow | FreqtradeTableRow
type CredentialForm = {
  apiKey: string
  apiSecret: string
  passphrase: string
}
type BacktestForm = {
  strategy: string
  timeframe: string
  timerange: string
  pairs: string
}
type ControlSession = {
  authorized: boolean
  mode: 'local' | 'token' | 'disabled' | 'misconfigured'
  tokenConfigured: boolean
  expiresAt: number | null
}

const tabs: Array<{ id: TabId; label: string; icon: React.ElementType }> = [
  { id: 'balances', label: '资产', icon: Wallet },
  { id: 'positions', label: '持仓', icon: Wallet },
  { id: 'orders', label: '订单', icon: ClipboardList },
  { id: 'history', label: '历史', icon: History },
  { id: 'backtest', label: '回测', icon: FlaskConical },
  { id: 'automation', label: '自动化', icon: Bot },
  { id: 'risk', label: '风控', icon: ShieldCheck },
  { id: 'audit', label: '审计', icon: History },
]

const ACCOUNT_REFRESH_MS = 15_000
const FREQTRADE_REFRESH_MS = 15_000

function DataTable({
  columns,
  rows,
  emptyLabel,
  detail,
}: {
  columns: string[]
  rows: TableRow[]
  emptyLabel: string
  detail?: string | null
}) {
  if (rows.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center text-xs text-muted-foreground">
        <div>{emptyLabel}</div>
        {detail && <div className="max-w-[720px] truncate font-mono text-[10px] text-[var(--chart-3)]">{detail}</div>}
      </div>
    )
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

function accountStatusLabel(snapshot: AccountSnapshot | null, loading: boolean, error: string | null) {
  if (loading && !snapshot) return 'ACCOUNT_SYNCING'
  if (snapshot?.source.auth.label === 'KEY_MISSING') return 'KEY_MISSING'
  if (snapshot?.source.auth.label === 'KEY_INVALID') return 'KEY_INVALID'
  if (snapshot?.source.status === 'offline') return 'ACCOUNT_OFFLINE'
  if (snapshot?.source.status === 'partial') return 'ACCOUNT_PARTIAL'
  if (snapshot?.source.status === 'live') return 'READ_ONLY · TRADE_LOCKED'
  if (error) return 'ACCOUNT_OFFLINE'
  return 'ACCOUNT_OFFLINE'
}

function accountDetail(snapshot: AccountSnapshot | null, error: string | null) {
  if (error) return error
  return snapshot?.source.errors[0] ?? null
}

function freqtradeStatusLabel(snapshot: FreqtradeSnapshot | null, loading: boolean, error: string | null) {
  if (loading && !snapshot) return 'FT_SYNCING'
  if (snapshot?.source.status === 'live' && snapshot.daemon.dryRun === true) return 'FT_DRY_RUN_CONTROL'
  if (snapshot?.source.status === 'live' && snapshot.daemon.dryRun === false) return 'FT_LIVE_OBSERVED'
  if (snapshot?.source.status === 'live') return 'FT_CONTROL_READY'
  if (snapshot?.source.status === 'partial') return 'FT_PARTIAL'
  if (snapshot?.source.status === 'offline') return 'FT_OFFLINE'
  if (error) return 'FT_OFFLINE'
  return 'FT_OFFLINE'
}

function freqtradeDetail(snapshot: FreqtradeSnapshot | null, error: string | null) {
  if (error) return error
  return snapshot?.source.errors[0] ?? null
}

function readinessState(ready: boolean, blockedLabel = '阻断') {
  return ready ? '就绪' : blockedLabel
}

function automationReadinessRows(
  accountSnapshot: AccountSnapshot | null,
  freqtradeSnapshot: FreqtradeSnapshot | null,
): TableRow[] {
  const accountAuth = accountSnapshot?.source.auth
  const daemon = freqtradeSnapshot?.daemon
  const hasStrategy = Boolean(daemon?.strategy && daemon.strategy !== '--')
  const pairCount = daemon?.pairs.length ?? 0
  const strategyVerified = hasStrategy && (freqtradeSnapshot?.tables.strategies ?? [])
    .some((row) => row.strategy === daemon?.strategy && row.verification === '已回测')

  return [
    { rule: 'live_trade_lock', value: 'LIVE_LOCKED', state: '锁定' },
    {
      rule: 'account_key',
      value: accountAuth?.label ?? 'ACCOUNT_OFFLINE',
      state: accountAuth?.status === 'configured' ? '就绪' : '待配置',
    },
    {
      rule: 'freqtrade_daemon',
      value: daemon?.online ? 'ONLINE' : 'OFFLINE',
      state: readinessState(Boolean(daemon?.online), '离线'),
    },
    {
      rule: 'mode',
      value: daemon?.dryRun === false ? 'LIVE' : daemon?.dryRun === true ? 'DRY_RUN' : '--',
      state: daemon?.dryRun == null ? '未知' : daemon.dryRun ? '模拟' : '实盘',
    },
    {
      rule: 'strategy',
      value: daemon?.strategy ?? '--',
      state: readinessState(hasStrategy, '未选择'),
    },
    {
      rule: 'pairs',
      value: pairCount,
      state: readinessState(pairCount > 0, '未配置'),
    },
    {
      rule: 'backtests',
      value: hasStrategy ? (strategyVerified ? 'CURRENT_CODE' : 'NO_EVIDENCE') : '--',
      state: hasStrategy ? readinessState(strategyVerified, '待验证') : '未选择',
    },
  ]
}

function emptyCredentialForm(): CredentialForm {
  return {
    apiKey: '',
    apiSecret: '',
    passphrase: '',
  }
}

function emptyBacktestForm(): BacktestForm {
  return {
    strategy: '',
    timeframe: '15m',
    timerange: '',
    pairs: '',
  }
}

async function postAccountCredentials(form: CredentialForm) {
  const response = await fetch('/api/account/credentials', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: form.apiKey,
      apiSecret: form.apiSecret,
      passphrase: form.passphrase || undefined,
    }),
  })
  const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null
  if (!response.ok || !payload?.ok) throw new Error(payload?.error ?? `账户配置 HTTP ${response.status}`)
}

async function postBacktest(form: BacktestForm) {
  const response = await fetch('/api/freqtrade/backtest', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      strategy: form.strategy,
      timeframe: form.timeframe,
      timerange: form.timerange || undefined,
      pairs: form.pairs
        .split(',')
        .map((pair) => pair.trim())
        .filter(Boolean),
    }),
  })
  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean
    error?: string
    result?: FreqtradeBacktestResult
  } | null
  if (!response.ok || !payload?.ok || !payload.result) throw new Error(payload?.error ?? `回测接口 HTTP ${response.status}`)
  return payload.result
}

async function postDryRunDeploy(strategy: string, pairs: string, maxOpenTrades: string) {
  const maxOpen = Number(maxOpenTrades)
  const response = await fetch('/api/freqtrade/deploy', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      strategy,
      pairs: pairs
        .split(',')
        .map((pair) => pair.trim())
        .filter(Boolean),
      maxOpenTrades: Number.isInteger(maxOpen) ? maxOpen : undefined,
    }),
  })
  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean
    error?: string
    result?: FreqtradeDryRunDeployResult
  } | null
  if (!response.ok || !payload?.ok || !payload.result) throw new Error(payload?.error ?? `部署接口 HTTP ${response.status}`)
  return payload.result
}

async function requestControlSession(method: 'GET' | 'POST' | 'DELETE', token?: string) {
  const response = await fetch('/api/control/session', {
    method,
    cache: 'no-store',
    headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
    body: method === 'POST' ? JSON.stringify({ token }) : undefined,
  })
  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean
    error?: string
    session?: ControlSession
  } | null
  if (!response.ok || !payload?.ok || !payload.session) {
    throw new Error(payload?.error ?? `控制会话 HTTP ${response.status}`)
  }
  return payload.session
}

function controlStatusLabel(session: ControlSession | null, loading: boolean) {
  if (loading) return 'CONTROL_CHECK'
  if (session?.mode === 'local' && session.authorized) return 'CONTROL_LOCAL'
  if (session?.authorized) return 'CONTROL_UNLOCKED'
  if (session?.mode === 'misconfigured') return 'CONTROL_CONFIG_ERROR'
  if (session?.mode === 'disabled') return 'CONTROL_DISABLED'
  return 'CONTROL_LOCKED'
}

function validDaemonValue(value: string) {
  return value && value !== '--'
}

function backtestDefaults(snapshot: FreqtradeSnapshot | null): Partial<BacktestForm> {
  if (!snapshot) return {}

  return {
    strategy: validDaemonValue(snapshot.daemon.strategy) ? snapshot.daemon.strategy : undefined,
    timeframe: validDaemonValue(snapshot.daemon.timeframe) ? snapshot.daemon.timeframe : undefined,
    pairs: snapshot.daemon.pairs.length > 0 ? snapshot.daemon.pairs.join(', ') : undefined,
  }
}

function backtestStrategies(snapshot: FreqtradeSnapshot | null) {
  const names = snapshot?.tables.strategies.map((row) => String(row.strategy ?? '')).filter(Boolean) ?? []
  if (snapshot && validDaemonValue(snapshot.daemon.strategy)) names.unshift(snapshot.daemon.strategy)
  return Array.from(new Set(names))
}

function AutomationPanel({
  rows,
  loading,
  detail,
  deployStrategy,
  deployPairs,
  deployMaxOpenTrades,
  deploying,
  deployError,
  deployOutput,
  onDeployStrategyChange,
  onDeployPairsChange,
  onDeployMaxOpenTradesChange,
  onDeploySubmit,
}: {
  rows: TableRow[]
  loading: boolean
  detail?: string | null
  deployStrategy: string
  deployPairs: string
  deployMaxOpenTrades: string
  deploying: boolean
  deployError: string | null
  deployOutput: FreqtradeDryRunDeployResult | null
  onDeployStrategyChange: (strategy: string) => void
  onDeployPairsChange: (pairs: string) => void
  onDeployMaxOpenTradesChange: (value: string) => void
  onDeploySubmit: (event: React.FormEvent<HTMLFormElement>) => void
}) {
  const strategyOptions = rows
    .map((row) => String(row.strategy ?? ''))
    .filter(Boolean)
  const deployHasBacktest = deployStrategy
    ? rows.some((row) => String(row.strategy ?? '') === deployStrategy && row.verification === '已回测')
    : false
  const deployBlocked = Boolean(deployStrategy && !deployHasBacktest)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <form onSubmit={onDeploySubmit} className="flex shrink-0 flex-wrap items-end gap-2 border-b border-border bg-background/10 px-3 py-2">
        <label className="min-w-[200px] flex-1 space-y-1">
          <span className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
            <span>Dry-run Deploy</span>
            {deployStrategy && (
              <span className={cn('font-mono', deployHasBacktest ? 'text-up' : 'text-[var(--chart-3)]')}>
                {deployHasBacktest ? 'BACKTESTED' : 'NEED_BACKTEST'}
              </span>
            )}
          </span>
          <select
            value={deployStrategy}
            onChange={(event) => onDeployStrategyChange(event.target.value)}
            className="h-8 w-full rounded-md border border-border bg-background/60 px-2 font-mono text-xs text-foreground outline-none focus:border-ring"
          >
            <option value="">选择策略</option>
            {strategyOptions.map((strategy) => (
              <option key={strategy} value={strategy}>{strategy}</option>
            ))}
          </select>
        </label>
        <label className="min-w-[230px] flex-1 space-y-1">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Pairs</span>
          <input
            value={deployPairs}
            onChange={(event) => onDeployPairsChange(event.target.value)}
            placeholder="BTC/USDT:USDT, ETH/USDT:USDT"
            className="h-8 w-full rounded-md border border-border bg-background/60 px-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
          />
        </label>
        <label className="w-24 space-y-1">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Max Open</span>
          <input
            value={deployMaxOpenTrades}
            onChange={(event) => onDeployMaxOpenTradesChange(event.target.value)}
            inputMode="numeric"
            placeholder="3"
            className="h-8 w-full rounded-md border border-border bg-background/60 px-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
          />
        </label>
        <button
          type="submit"
          disabled={deploying || !deployStrategy || deployBlocked}
          title={deployBlocked ? '请先在回测 tab 完成该策略回测' : undefined}
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border px-3 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          {deploying ? <LoaderCircle className="size-3.5 animate-spin" /> : <Rocket className="size-3.5" />}
          模拟部署
        </button>
      </form>
      {(deployError || deployOutput || deployBlocked) && (
        <div className="shrink-0 border-b border-border px-3 py-1.5 font-mono text-[10px] leading-4">
          {deployError ? (
            <span className="text-[var(--chart-3)]">{deployError}</span>
          ) : deployBlocked ? (
            <span className="text-[var(--chart-3)]">请先在回测 tab 完成 {deployStrategy} 的回测，再模拟部署</span>
          ) : deployOutput ? (
            <span className="text-muted-foreground">
              {deployOutput.strategy} · DRY_RUN · {deployOutput.pairs.length || 'existing'} pairs · max {deployOutput.maxOpenTrades ?? '--'} · {deployOutput.note}
            </span>
          ) : null}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <DataTable
          columns={['strategy', 'status', 'timeframe', 'mode', 'verification']}
          rows={rows}
          emptyLabel={loading ? '正在同步自动化策略' : '暂无可部署策略。策略文件需要先完成回测验证'}
          detail={detail}
        />
      </div>
    </div>
  )
}

function BacktestPanel({
  rows,
  loading,
  detail,
  form,
  running,
  error,
  output,
  strategies,
  defaults,
  onFormChange,
  onSubmit,
}: {
  rows: TableRow[]
  loading: boolean
  detail?: string | null
  form: BacktestForm
  running: boolean
  error: string | null
  output: FreqtradeBacktestResult | null
  strategies: string[]
  defaults: Partial<BacktestForm>
  onFormChange: (patch: Partial<BacktestForm>) => void
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
}) {
  const applyDefaults = () => onFormChange({
    strategy: defaults.strategy ?? form.strategy,
    timeframe: defaults.timeframe ?? form.timeframe,
    pairs: defaults.pairs ?? form.pairs,
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <form onSubmit={onSubmit} className="flex shrink-0 flex-wrap items-end gap-2 border-b border-border bg-background/20 px-3 py-2">
        <label className="min-w-[150px] flex-1 space-y-1">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Strategy</span>
          {strategies.length > 0 ? (
            <select
              value={form.strategy}
              onChange={(event) => onFormChange({ strategy: event.target.value })}
              className="h-8 w-full rounded-md border border-border bg-background/60 px-2 font-mono text-xs text-foreground outline-none focus:border-ring"
            >
              <option value="">选择策略</option>
              {strategies.map((strategy) => (
                <option key={strategy} value={strategy}>{strategy}</option>
              ))}
            </select>
          ) : (
            <input
              value={form.strategy}
              onChange={(event) => onFormChange({ strategy: event.target.value })}
              placeholder="MyStrategy"
              className="h-8 w-full rounded-md border border-border bg-background/60 px-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
            />
          )}
        </label>
        <label className="w-24 space-y-1">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Timeframe</span>
          <input
            value={form.timeframe}
            onChange={(event) => onFormChange({ timeframe: event.target.value })}
            className="h-8 w-full rounded-md border border-border bg-background/60 px-2 font-mono text-xs text-foreground outline-none focus:border-ring"
          />
        </label>
        <label className="w-40 space-y-1">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Timerange</span>
          <input
            value={form.timerange}
            onChange={(event) => onFormChange({ timerange: event.target.value })}
            placeholder="20250101-20251231"
            className="h-8 w-full rounded-md border border-border bg-background/60 px-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
          />
        </label>
        <label className="min-w-[170px] flex-1 space-y-1">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Pairs</span>
          <input
            value={form.pairs}
            onChange={(event) => onFormChange({ pairs: event.target.value })}
            placeholder="BTC/USDT:USDT, ETH/USDT:USDT"
            className="h-8 w-full rounded-md border border-border bg-background/60 px-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
          />
        </label>
        <button
          type="submit"
          disabled={running || !form.strategy.trim()}
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {running && <LoaderCircle className="size-3.5 animate-spin" />}
          回测
        </button>
        <button
          type="button"
          disabled={!defaults.strategy && !defaults.timeframe && !defaults.pairs}
          onClick={applyDefaults}
          className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          当前配置
        </button>
      </form>
      {(error || output) && (
        <div className="shrink-0 border-b border-border px-3 py-1.5 font-mono text-[10px] leading-4">
          {error ? (
            <span className="text-[var(--chart-3)]">{error}</span>
          ) : output ? (
            <div className="space-y-1 text-muted-foreground">
              <div>{output.strategy} · {output.timeframe} · {output.timerange}</div>
              {output.output && (
                <pre className="max-h-14 overflow-auto whitespace-pre-wrap rounded border border-border/70 bg-background/50 p-2 scrollbar-thin">
                  {output.output}
                </pre>
              )}
            </div>
          ) : null}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <DataTable
          columns={['strategy', 'range', 'timeframe', 'trades', 'profit', 'win', 'drawdown', 'verification', 'file']}
          rows={rows}
          emptyLabel={loading
            ? '正在同步回测结果'
            : strategies.length > 0
            ? '暂无回测结果。选择策略和历史区间后开始回测'
              : '暂无可回测策略。策略文件由 Agent 写入后会出现在这里'}
          detail={detail}
        />
      </div>
    </div>
  )
}

function renderPanel({
  active,
  accountSnapshot,
  accountLoading,
  accountError,
  freqtradeSnapshot,
  freqtradeLoading,
  freqtradeError,
  deployStrategy,
  deployPairs,
  deployMaxOpenTrades,
  deploying,
  deployError,
  deployOutput,
  localAuditRows,
  backtestForm,
  backtestRunning,
  backtestError,
  backtestOutput,
  onDeployStrategyChange,
  onDeployPairsChange,
  onDeployMaxOpenTradesChange,
  onDeploySubmit,
  backtestStrategies,
  backtestDefaults,
  onBacktestFormChange,
  onBacktestSubmit,
}: {
  active: TabId
  accountSnapshot: AccountSnapshot | null
  accountLoading: boolean
  accountError: string | null
  freqtradeSnapshot: FreqtradeSnapshot | null
  freqtradeLoading: boolean
  freqtradeError: string | null
  deployStrategy: string
  deployPairs: string
  deployMaxOpenTrades: string
  deploying: boolean
  deployError: string | null
  deployOutput: FreqtradeDryRunDeployResult | null
  localAuditRows: FreqtradeTableRow[]
  backtestForm: BacktestForm
  backtestRunning: boolean
  backtestError: string | null
  backtestOutput: FreqtradeBacktestResult | null
  onDeployStrategyChange: (strategy: string) => void
  onDeployPairsChange: (pairs: string) => void
  onDeployMaxOpenTradesChange: (value: string) => void
  onDeploySubmit: (event: React.FormEvent<HTMLFormElement>) => void
  backtestStrategies: string[]
  backtestDefaults: Partial<BacktestForm>
  onBacktestFormChange: (patch: Partial<BacktestForm>) => void
  onBacktestSubmit: (event: React.FormEvent<HTMLFormElement>) => void
}) {
  const accountErrorDetail = accountDetail(accountSnapshot, accountError)
  const freqtradeErrorDetail = freqtradeDetail(freqtradeSnapshot, freqtradeError)

  if (active === 'balances') {
    return (
      <DataTable
        columns={['asset', 'free', 'used', 'total']}
        rows={accountSnapshot?.balances ?? []}
        emptyLabel={accountLoading ? '正在同步账户资产' : '暂无真实资产数据'}
        detail={accountErrorDetail}
      />
    )
  }
  if (active === 'positions') {
    const rows: TableRow[] = [
      ...(accountSnapshot?.positions ?? []).map((row) => ({ ...row, source: 'ACCOUNT', strategy: '--' })),
      ...(freqtradeSnapshot?.tables.positions ?? []),
    ]
    return (
      <DataTable
        columns={['source', 'symbol', 'side', 'size', 'entry', 'mark', 'pnl', 'risk', 'strategy']}
        rows={rows}
        emptyLabel={accountLoading || freqtradeLoading ? '正在同步持仓' : '暂无账户或机器人持仓'}
        detail={accountErrorDetail ?? freqtradeErrorDetail}
      />
    )
  }
  if (active === 'orders') {
    return (
      <DataTable
        columns={['id', 'symbol', 'type', 'side', 'price', 'status']}
        rows={accountSnapshot?.orders ?? []}
        emptyLabel={accountLoading ? '正在同步账户订单' : '暂无真实订单数据'}
        detail={accountErrorDetail}
      />
    )
  }
  if (active === 'history') {
    const rows: TableRow[] = [
      ...(accountSnapshot?.history ?? []).map((row) => ({ ...row, source: 'ACCOUNT', pnl: '--', strategy: '--' })),
      ...(freqtradeSnapshot?.tables.history ?? []),
    ]
    return (
      <DataTable
        columns={['source', 'time', 'symbol', 'side', 'amount', 'price', 'pnl', 'fee', 'strategy']}
        rows={rows}
        emptyLabel={accountLoading || freqtradeLoading ? '正在同步历史' : '暂无账户或机器人历史'}
        detail={accountErrorDetail ?? freqtradeErrorDetail}
      />
    )
  }
  if (active === 'automation') {
    return (
      <AutomationPanel
        rows={freqtradeSnapshot?.tables.strategies ?? []}
        loading={freqtradeLoading}
        detail={freqtradeErrorDetail}
        deployStrategy={deployStrategy}
        deployPairs={deployPairs}
        deployMaxOpenTrades={deployMaxOpenTrades}
        deploying={deploying}
        deployError={deployError}
        deployOutput={deployOutput}
        onDeployStrategyChange={onDeployStrategyChange}
        onDeployPairsChange={onDeployPairsChange}
        onDeployMaxOpenTradesChange={onDeployMaxOpenTradesChange}
        onDeploySubmit={onDeploySubmit}
      />
    )
  }
  if (active === 'backtest') {
    return (
      <BacktestPanel
        rows={freqtradeSnapshot?.tables.backtests ?? []}
        loading={freqtradeLoading}
        detail={freqtradeErrorDetail}
        form={backtestForm}
        running={backtestRunning}
        error={backtestError}
        output={backtestOutput}
        strategies={backtestStrategies}
        defaults={backtestDefaults}
        onFormChange={onBacktestFormChange}
        onSubmit={onBacktestSubmit}
      />
    )
  }
  if (active === 'risk') {
    const runtimeRiskRows = (freqtradeSnapshot?.tables.risk ?? [])
      .filter((row) => !['mode', 'strategy'].includes(String(row.rule)))

    return (
      <DataTable
        columns={['rule', 'value', 'state']}
        rows={[
          ...automationReadinessRows(accountSnapshot, freqtradeSnapshot),
          ...runtimeRiskRows,
        ]}
        emptyLabel={freqtradeLoading ? '正在同步风控状态' : '暂无真实风控状态'}
        detail={freqtradeErrorDetail}
      />
    )
  }
  return (
    <DataTable
      columns={['time', 'actor', 'event', 'result']}
      rows={[...localAuditRows, ...(freqtradeSnapshot?.tables.audit ?? [])]}
      emptyLabel="暂无审计事件"
      detail={freqtradeErrorDetail}
    />
  )
}

export function BottomWorkbench() {
  const [active, setActive] = useState<TabId>('balances')
  const [collapsed, setCollapsed] = useState(false)
  const [controlSession, setControlSession] = useState<ControlSession | null>(null)
  const [controlLoading, setControlLoading] = useState(true)
  const [controlOpen, setControlOpen] = useState(false)
  const [controlToken, setControlToken] = useState('')
  const [controlSubmitting, setControlSubmitting] = useState(false)
  const [controlError, setControlError] = useState<string | null>(null)
  const [accountSnapshot, setAccountSnapshot] = useState<AccountSnapshot | null>(null)
  const [accountLoading, setAccountLoading] = useState(true)
  const [accountError, setAccountError] = useState<string | null>(null)
  const [freqtradeSnapshot, setFreqtradeSnapshot] = useState<FreqtradeSnapshot | null>(null)
  const [freqtradeLoading, setFreqtradeLoading] = useState(true)
  const [freqtradeError, setFreqtradeError] = useState<string | null>(null)
  const [credentialsOpen, setCredentialsOpen] = useState(false)
  const [credentialForm, setCredentialForm] = useState<CredentialForm>(() => emptyCredentialForm())
  const [credentialSaving, setCredentialSaving] = useState(false)
  const [credentialError, setCredentialError] = useState<string | null>(null)
  const [deployStrategy, setDeployStrategy] = useState('')
  const [deployPairs, setDeployPairs] = useState('')
  const [deployMaxOpenTrades, setDeployMaxOpenTrades] = useState('')
  const [deploying, setDeploying] = useState(false)
  const [deployError, setDeployError] = useState<string | null>(null)
  const [deployOutput, setDeployOutput] = useState<FreqtradeDryRunDeployResult | null>(null)
  const [localAuditRows, setLocalAuditRows] = useState<FreqtradeTableRow[]>([])
  const [backtestForm, setBacktestForm] = useState<BacktestForm>(() => emptyBacktestForm())
  const [backtestRunning, setBacktestRunning] = useState(false)
  const [backtestError, setBacktestError] = useState<string | null>(null)
  const [backtestOutput, setBacktestOutput] = useState<FreqtradeBacktestResult | null>(null)
  const [backtestDirty, setBacktestDirty] = useState(false)
  const accountControllerRef = useRef<AbortController | null>(null)
  const freqtradeControllerRef = useRef<AbortController | null>(null)

  const appendAudit = useCallback((event: string, result: string, actor = 'Helix') => {
    setLocalAuditRows((rows) => [
      {
        time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        actor,
        event,
        result: result.slice(0, 180),
      },
      ...rows,
    ].slice(0, 24))
  }, [])

  const loadControlSession = useCallback(async () => {
    setControlLoading(true)
    try {
      setControlSession(await requestControlSession('GET'))
      setControlError(null)
    } catch (error) {
      setControlSession(null)
      setControlError(error instanceof Error ? error.message : '控制会话不可用')
    } finally {
      setControlLoading(false)
    }
  }, [])

  const loadAccount = useCallback(async (showLoading = true) => {
    accountControllerRef.current?.abort()
    const controller = new AbortController()
    accountControllerRef.current = controller
    if (showLoading) setAccountLoading(true)

    try {
      const response = await fetch('/api/account/snapshot', {
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`账户接口 HTTP ${response.status}`)

      const snapshot = (await response.json()) as AccountSnapshot
      if (controller.signal.aborted) return
      setAccountSnapshot(snapshot)
      setAccountError(snapshot.source.errors[0] ?? null)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setAccountError(error instanceof Error ? error.message : '账户接口不可用')
    } finally {
      if (!controller.signal.aborted && showLoading) setAccountLoading(false)
    }
  }, [])

  const loadFreqtrade = useCallback(async (showLoading = true, refresh = false) => {
    freqtradeControllerRef.current?.abort()
    const controller = new AbortController()
    freqtradeControllerRef.current = controller
    if (showLoading) setFreqtradeLoading(true)

    try {
      const response = await fetch(`/api/freqtrade/snapshot${refresh ? '?refresh=1' : ''}`, {
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`Freqtrade 接口 HTTP ${response.status}`)

      const snapshot = (await response.json()) as FreqtradeSnapshot
      if (controller.signal.aborted) return
      setFreqtradeSnapshot(snapshot)
      setFreqtradeError(snapshot.source.errors[0] ?? null)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setFreqtradeError(error instanceof Error ? error.message : 'Freqtrade 接口不可用')
    } finally {
      if (!controller.signal.aborted && showLoading) setFreqtradeLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadControlSession()
  }, [loadControlSession])

  useEffect(() => {
    void loadAccount()
    const timer = window.setInterval(() => void loadAccount(false), ACCOUNT_REFRESH_MS)

    return () => {
      accountControllerRef.current?.abort()
      window.clearInterval(timer)
    }
  }, [loadAccount])

  useEffect(() => {
    void loadFreqtrade()
    const timer = window.setInterval(() => void loadFreqtrade(false), FREQTRADE_REFRESH_MS)

    return () => {
      freqtradeControllerRef.current?.abort()
      window.clearInterval(timer)
    }
  }, [loadFreqtrade])

  useEffect(() => {
    if (backtestDirty) return

    const defaults = backtestDefaults(freqtradeSnapshot)
    setBacktestForm((form) => ({
      strategy: form.strategy || defaults.strategy || '',
      timeframe: form.timeframe || defaults.timeframe || '15m',
      timerange: form.timerange,
      pairs: form.pairs || defaults.pairs || '',
    }))
  }, [backtestDirty, freqtradeSnapshot])

  useEffect(() => {
    if (deployStrategy || !freqtradeSnapshot || !validDaemonValue(freqtradeSnapshot.daemon.strategy)) return
    setDeployStrategy(freqtradeSnapshot.daemon.strategy)
  }, [deployStrategy, freqtradeSnapshot])

  useEffect(() => {
    if (deployPairs || !freqtradeSnapshot?.daemon.pairs.length) return
    setDeployPairs(freqtradeSnapshot.daemon.pairs.join(', '))
  }, [deployPairs, freqtradeSnapshot])

  useEffect(() => {
    if (deployMaxOpenTrades || !freqtradeSnapshot) return
    const value = Number(freqtradeSnapshot.daemon.maxOpenTrades)
    if (Number.isInteger(value) && value > 0) setDeployMaxOpenTrades(String(value))
  }, [deployMaxOpenTrades, freqtradeSnapshot])

  const selectTab = (tab: TabId) => {
    if (tab === active) {
      setCollapsed((value) => !value)
      return
    }

    setActive(tab)
    setCollapsed(false)
  }

  const openControlPanel = () => {
    setCredentialsOpen(false)
    setControlError(null)
    setControlOpen(true)
  }

  const requireControl = () => {
    const expired = controlSession?.expiresAt != null && controlSession.expiresAt <= Date.now()
    if (controlSession?.authorized && !expired) return true
    if (expired) {
      setControlSession((session) => session ? { ...session, authorized: false, expiresAt: null } : null)
    }
    openControlPanel()
    return false
  }

  const submitControlToken = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setControlSubmitting(true)
    setControlError(null)
    try {
      const session = await requestControlSession('POST', controlToken)
      setControlSession(session)
      setControlToken('')
      setControlOpen(false)
      appendAudit('control_unlocked', session.mode)
    } catch (error) {
      setControlError(error instanceof Error ? error.message : '控制会话解锁失败')
    } finally {
      setControlSubmitting(false)
    }
  }

  const lockControlSession = async () => {
    setControlSubmitting(true)
    setControlError(null)
    try {
      setControlSession(await requestControlSession('DELETE'))
      appendAudit('control_locked', 'session cleared')
    } catch (error) {
      setControlError(error instanceof Error ? error.message : '控制会话锁定失败')
    } finally {
      setControlSubmitting(false)
    }
  }

  const submitCredentials = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!requireControl()) return
    setCredentialSaving(true)
    setCredentialError(null)

    try {
      await postAccountCredentials(credentialForm)
      setCredentialForm(emptyCredentialForm())
      setCredentialsOpen(false)
      appendAudit('account_key_saved', 'API key saved for read-only account sync')
      await loadAccount(true)
    } catch (error) {
      const message = error instanceof Error ? error.message : '账户配置失败'
      setCredentialError(message)
      appendAudit('account_key_error', message)
    } finally {
      setCredentialSaving(false)
    }
  }

  const submitDeploy = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!requireControl()) return
    setDeploying(true)
    setDeployError(null)
    setDeployOutput(null)

    try {
      const result = await postDryRunDeploy(deployStrategy, deployPairs, deployMaxOpenTrades)
      setDeployOutput(result)
      await loadFreqtrade(true, true)
    } catch (error) {
      const message = error instanceof Error ? error.message : '模拟部署失败'
      setDeployError(message)
      await loadFreqtrade(false, true)
    } finally {
      setDeploying(false)
    }
  }

  const submitBacktest = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!requireControl()) return
    setBacktestRunning(true)
    setBacktestError(null)
    setBacktestOutput(null)

    try {
      const result = await postBacktest(backtestForm)
      setBacktestOutput(result)
      await loadFreqtrade(true, true)
    } catch (error) {
      const message = error instanceof Error ? error.message : '回测失败'
      setBacktestError(message)
      await loadFreqtrade(false, true)
    } finally {
      setBacktestRunning(false)
    }
  }

  return (
    <section className={cn('relative flex shrink-0 flex-col border-t border-border bg-sidebar', collapsed ? 'h-10' : 'h-[238px]')}>
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
            {accountStatusLabel(accountSnapshot, accountLoading, accountError)}
          </div>
          <div className="hidden items-center gap-2 font-mono text-[10px] leading-none text-muted-foreground lg:flex">
            <Bot className="size-3.5 text-muted-foreground" />
            {freqtradeStatusLabel(freqtradeSnapshot, freqtradeLoading, freqtradeError)}
          </div>
          <button
            type="button"
            aria-label={controlStatusLabel(controlSession, controlLoading)}
            title={controlStatusLabel(controlSession, controlLoading)}
            onClick={openControlPanel}
            className={cn(
              'inline-flex size-7 items-center justify-center rounded transition-colors hover:bg-muted',
              controlSession?.authorized ? 'text-up' : 'text-[var(--chart-3)]',
            )}
          >
            {controlLoading
              ? <LoaderCircle className="size-3.5 animate-spin" />
              : controlSession?.authorized
                ? <Unlock className="size-3.5" />
                : <Lock className="size-3.5" />}
          </button>
          <button
            type="button"
            aria-label="配置账户源 API Key"
            title="配置账户源 API Key"
            onClick={() => {
              if (!controlSession?.authorized) {
                openControlPanel()
                return
              }
              setControlOpen(false)
              setCredentialError(null)
              setCredentialsOpen(true)
            }}
            className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <KeyRound className="size-3.5" />
          </button>
        </div>
      </div>
      {!collapsed && (
        <div className="min-h-0 flex-1">
          {renderPanel({
            active,
            accountSnapshot,
            accountLoading,
            accountError,
            freqtradeSnapshot,
            freqtradeLoading,
            freqtradeError,
            deployStrategy,
            deployPairs,
            deployMaxOpenTrades,
            deploying,
            deployError,
            deployOutput,
            localAuditRows,
            backtestForm,
            backtestRunning,
            backtestError,
            backtestOutput,
            onDeployStrategyChange: (strategy) => {
              setDeployError(null)
              setDeployOutput(null)
              setDeployStrategy(strategy)
            },
            onDeployPairsChange: (pairs) => {
              setDeployError(null)
              setDeployOutput(null)
              setDeployPairs(pairs)
            },
            onDeployMaxOpenTradesChange: (value) => {
              setDeployError(null)
              setDeployOutput(null)
              setDeployMaxOpenTrades(value)
            },
            onDeploySubmit: submitDeploy,
            backtestStrategies: backtestStrategies(freqtradeSnapshot),
            backtestDefaults: backtestDefaults(freqtradeSnapshot),
            onBacktestFormChange: (patch) => {
              setBacktestDirty(true)
              setBacktestForm((form) => ({ ...form, ...patch }))
            },
            onBacktestSubmit: submitBacktest,
          })}
        </div>
      )}

      {controlOpen && (
        <div className="absolute bottom-10 right-3 z-50 w-[320px] max-w-[calc(100vw-24px)] overflow-hidden rounded-md border border-border bg-popover shadow-2xl">
          <div className="flex h-10 items-center justify-between border-b border-border px-3">
            <div className="flex items-center gap-2 text-xs font-medium leading-none">
              {controlSession?.authorized
                ? <Unlock className="size-3.5 text-up" />
                : <Lock className="size-3.5 text-[var(--chart-3)]" />}
              控制会话
            </div>
            <button
              type="button"
              aria-label="关闭控制会话"
              title="关闭"
              onClick={() => {
                setControlOpen(false)
                setControlToken('')
                setControlError(null)
              }}
              className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>

          {controlSession?.mode === 'token' && !controlSession.authorized ? (
            <form onSubmit={submitControlToken} className="space-y-3 p-3">
              <label className="block space-y-1.5">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Control Token</span>
                <input
                  value={controlToken}
                  onChange={(event) => setControlToken(event.target.value)}
                  type="password"
                  autoComplete="current-password"
                  autoFocus
                  className="h-8 w-full rounded-md border border-border bg-background/60 px-2 font-mono text-xs text-foreground outline-none focus:border-ring"
                />
              </label>
              {controlError && (
                <div className="rounded border border-[var(--chart-3)]/40 bg-[var(--chart-3)]/10 px-2 py-1.5 text-[11px] text-[var(--chart-3)]">
                  {controlError}
                </div>
              )}
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setControlOpen(false)}
                  className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={controlSubmitting || !controlToken}
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {controlSubmitting && <LoaderCircle className="size-3.5 animate-spin" />}
                  解锁
                </button>
              </div>
            </form>
          ) : (
            <div className="space-y-3 p-3">
              <div className="flex items-center justify-between gap-3 font-mono text-[10px]">
                <span className="text-muted-foreground">{controlStatusLabel(controlSession, controlLoading)}</span>
                {controlSession?.expiresAt && (
                  <span className="text-muted-foreground">
                    {new Date(controlSession.expiresAt).toLocaleTimeString('zh-CN', { hour12: false })}
                  </span>
                )}
              </div>
              {(controlError || controlSession?.mode === 'disabled' || controlSession?.mode === 'misconfigured') && (
                <div className="rounded border border-[var(--chart-3)]/40 bg-[var(--chart-3)]/10 px-2 py-1.5 text-[11px] text-[var(--chart-3)]">
                  {controlError
                    ?? (controlSession?.mode === 'disabled'
                      ? 'REMOTE_CONTROL_DISABLED'
                      : 'CONTROL_TOKEN_CONFIG_ERROR')}
                </div>
              )}
              {controlSession?.mode === 'token' && controlSession.authorized && (
                <div className="flex justify-end">
                  <button
                    type="button"
                    disabled={controlSubmitting}
                    onClick={() => void lockControlSession()}
                    className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border px-3 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
                  >
                    {controlSubmitting ? <LoaderCircle className="size-3.5 animate-spin" /> : <Lock className="size-3.5" />}
                    锁定
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {credentialsOpen && (
        <div className="absolute bottom-10 right-3 z-40 w-[360px] max-w-[calc(100vw-24px)] overflow-hidden rounded-md border border-border bg-popover shadow-2xl">
          <div className="flex h-10 items-center justify-between border-b border-border px-3">
            <div className="flex items-center gap-2 text-xs font-medium leading-none">
              <KeyRound className="size-3.5 text-primary" />
              账户源 API Key
            </div>
            <button
              type="button"
              aria-label="关闭账户源配置"
              title="关闭"
              onClick={() => setCredentialsOpen(false)}
              className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>

          <form onSubmit={submitCredentials} className="space-y-3 p-3">
            <label className="block space-y-1.5">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">API Key</span>
              <input
                value={credentialForm.apiKey}
                onChange={(event) => setCredentialForm((form) => ({ ...form, apiKey: event.target.value }))}
                autoComplete="off"
                className="h-8 w-full rounded-md border border-border bg-background/60 px-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
              />
            </label>

            <label className="block space-y-1.5">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">API Secret</span>
              <input
                value={credentialForm.apiSecret}
                onChange={(event) => setCredentialForm((form) => ({ ...form, apiSecret: event.target.value }))}
                type="password"
                autoComplete="new-password"
                className="h-8 w-full rounded-md border border-border bg-background/60 px-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
              />
            </label>

            <label className="block space-y-1.5">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">API Passphrase</span>
              <input
                value={credentialForm.passphrase}
                onChange={(event) => setCredentialForm((form) => ({ ...form, passphrase: event.target.value }))}
                type="password"
                autoComplete="new-password"
                className="h-8 w-full rounded-md border border-border bg-background/60 px-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
              />
            </label>

            {credentialError && (
              <div className="truncate rounded border border-[var(--chart-3)]/40 bg-[var(--chart-3)]/10 px-2 py-1.5 text-[11px] text-[var(--chart-3)]">
                {credentialError}
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setCredentialsOpen(false)}
                className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={credentialSaving || !credentialForm.apiKey.trim() || !credentialForm.apiSecret.trim()}
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {credentialSaving && <LoaderCircle className="size-3.5 animate-spin" />}
                保存
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  )
}
