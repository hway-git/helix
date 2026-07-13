import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import type {
  FreqtradeBacktestRequest,
  FreqtradeBacktestResult,
  FreqtradeDryRunDeployRequest,
  FreqtradeDryRunDeployResult,
  FreqtradeSnapshot,
  FreqtradeStrategyCreateRequest,
  FreqtradeStrategyCreateResult,
  FreqtradeTableRow,
} from '@/lib/freqtrade-data'
import { getFreqtradeAuditRows } from './snapshot-cache'

const execFileAsync = promisify(execFile)
const DEFAULT_TIMEOUT_MS = 18_000
const BACKTEST_TIMEOUT_MS = 10 * 60_000
const DEPLOY_TIMEOUT_MS = 10 * 60_000
const REPO_ROOT = process.env.HELIX_REPO_ROOT
  ? resolve(process.env.HELIX_REPO_ROOT)
  : resolve(process.cwd(), '..', '..')
const FREQTRADE_SKILL_DIR = resolve(REPO_ROOT, 'skills', 'helix-freqtrade')

type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string }

type DaemonInfo = {
  online?: boolean
  version?: string
  strategy?: string
  timeframe?: string
  trading_mode?: string
  dry_run?: boolean
  max_open_trades?: number | string
  stake_currency?: string
  pair_whitelist?: string[]
  open_trades_count?: number
}

type ProfitInfo = {
  profit_closed_coin?: number | string
  profit_all_coin?: number | string
  closed_trade_count?: number | string
  stake_currency?: string
}

type TradeInfo = Record<string, unknown>

type TradeHistory = {
  trades?: TradeInfo[]
}

type StrategyList = {
  strategies?: string[]
}

type BacktestResults = {
  results?: Array<{
    file?: string
    strategy?: string
    timeframe?: string
    start?: string
    end?: string
    trades?: number | string | null
    profitPct?: number | string | null
    profitAbs?: number | string | null
    winRate?: number | string | null
    drawdown?: number | string | null
  }>
  evidence?: Array<{
    id?: string
    strategy?: string
    timeframe?: string
    timerange?: string
    pairs?: string[]
    resultFile?: string | null
    createdAt?: string
    current?: boolean
    fingerprint?: string
  }>
}

type BacktestOutput = {
  strategy?: string
  timeframe?: string
  timerange?: string
  output?: string
}

type LogsInfo = {
  logs?: string
}

type StrategyCreateOutput = {
  strategy?: string
  timeframe?: string
  direction?: string
  indicators?: string[]
  note?: string
  next?: string
}

type DeployOutput = {
  strategy?: string
  mode?: string
  dry_run?: boolean
  pairs?: string[]
  max_open_trades?: number | string
  note?: string
  warning?: string | null
}

function parseJson(stdout: string) {
  try {
    return JSON.parse(stdout) as unknown
  } catch {
    return { error: stdout.trim() || 'freqtrade script returned non-json output' }
  }
}

function firstLine(value: string) {
  return value.split('\n').map((line) => line.trim()).find(Boolean) ?? value.trim()
}

function sanitizeFreqtradeError(error: string) {
  return firstLine(error)
    .replace(/\b127\.0\.0\.1:\d+\b/g, '[local]')
    .replace(/https?:\/\/[^\s"']+/g, '[url]')
    .replace(/Basic\s+[A-Za-z0-9+/=]+/g, 'Basic [redacted]')
}

function sanitizeLogLine(line: string) {
  return line
    .replace(/\b127\.0\.0\.1:\d+\b/g, '[local]')
    .replace(/https?:\/\/[^\s"']+/g, '[url]')
    .replace(/Basic\s+[A-Za-z0-9+/=]+/g, 'Basic [redacted]')
    .slice(0, 240)
}

async function runFreqtradeAction<T>(
  script: 'ft.mjs' | 'ft-deploy.mjs',
  action: string,
  params?: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ActionResult<T>> {
  const args = [`scripts/${script}`, action]
  if (params && Object.keys(params).length > 0) args.push(JSON.stringify(params))

  try {
    const { stdout } = await execFileAsync(process.execPath, args, {
      cwd: FREQTRADE_SKILL_DIR,
      timeout: timeoutMs,
      env: {
        ...process.env,
        HELIX_INTERNAL_CALL: '1',
      },
      maxBuffer: 1024 * 1024,
    })
    const parsed = parseJson(stdout) as T & { error?: string }
    if (parsed && typeof parsed === 'object' && parsed.error) return { ok: false, error: sanitizeFreqtradeError(parsed.error) }
    return { ok: true, data: parsed as T }
  } catch (error) {
    const maybe = error as { stdout?: string; stderr?: string; message?: string }
    const parsed = maybe.stdout ? (parseJson(maybe.stdout) as { error?: string }) : null
    return {
      ok: false,
      error: sanitizeFreqtradeError(parsed?.error || maybe.stderr || maybe.message || `${action} failed`),
    }
  }
}

function stringParam(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeBacktestPairs(value: unknown) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : []

  return raw
    .map((item) => (typeof item === 'string' ? item.trim().toUpperCase() : ''))
    .filter(Boolean)
    .filter((item) => /^[A-Z0-9]+\/[A-Z0-9]+(?::[A-Z0-9]+)?$/.test(item))
    .slice(0, 20)
}

function normalizeBacktestRequest(input: Partial<FreqtradeBacktestRequest>): FreqtradeBacktestRequest {
  const strategy = stringParam(input.strategy)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(strategy)) {
    throw new Error('strategy 必须是有效的策略类名')
  }

  const timeframe = stringParam(input.timeframe) || '15m'
  if (!/^\d+[mhdwM]$/.test(timeframe)) {
    throw new Error('timeframe 格式不正确，例如 15m / 1h / 1d')
  }

  const timerange = stringParam(input.timerange)
  if (timerange && !/^\d{8}-\d{8}$/.test(timerange)) {
    throw new Error('timerange 格式不正确，例如 20250101-20251231')
  }

  const pairs = normalizeBacktestPairs(input.pairs)

  return {
    strategy,
    timeframe,
    timerange: timerange || undefined,
    pairs: pairs.length > 0 ? pairs : undefined,
  }
}

function normalizeStrategyCreateRequest(input: Partial<FreqtradeStrategyCreateRequest>): FreqtradeStrategyCreateRequest {
  const name = stringParam(input.name)
  if (!/^[A-Z][A-Za-z0-9_]+$/.test(name)) {
    throw new Error('策略名称必须是大写开头的 Python class 名，例如 MyStrategy')
  }

  const timeframe = stringParam(input.timeframe) || '15m'
  if (!/^\d+[mhdwM]$/.test(timeframe)) {
    throw new Error('timeframe 格式不正确，例如 15m / 1h / 1d')
  }

  const direction = input.direction === 'short' || input.direction === 'both' ? input.direction : 'long'
  const allowedIndicators = new Set([
    'rsi',
    'bb',
    'bollinger',
    'ema',
    'sma',
    'macd',
    'stochastic',
    'kdj',
    'atr',
    'adx',
    'cci',
    'williams_r',
    'willr',
    'vwap',
    'ichimoku',
    'volume_sma',
    'volume',
    'obv',
  ])
  const indicators = Array.isArray(input.indicators)
    ? input.indicators
      .map((item) => (typeof item === 'string' ? item.trim().toLowerCase() : ''))
      .filter((item) => allowedIndicators.has(item))
    : []

  return {
    name,
    timeframe,
    direction,
    indicators: Array.from(new Set(indicators.length > 0 ? indicators : ['rsi', 'macd', 'ema', 'volume_sma'])),
  }
}

function normalizeDryRunDeployRequest(input: Partial<FreqtradeDryRunDeployRequest>): FreqtradeDryRunDeployRequest {
  const strategy = stringParam(input.strategy)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(strategy)) {
    throw new Error('strategy 必须是有效的策略类名')
  }
  const maxOpenTrades = numberFrom(input.maxOpenTrades)
  if (maxOpenTrades != null && (!Number.isInteger(maxOpenTrades) || maxOpenTrades < 1 || maxOpenTrades > 20)) {
    throw new Error('max_open_trades 必须是 1-20 的整数')
  }
  const pairs = normalizeBacktestPairs(input.pairs)

  return {
    strategy,
    pairs: pairs.length > 0 ? pairs : undefined,
    maxOpenTrades,
  }
}

function numberFrom(value: unknown) {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? n : undefined
}

function formatAmount(value: unknown) {
  const n = numberFrom(value)
  if (n == null) return '--'
  const sign = n > 0 ? '+' : ''
  if (Math.abs(n) >= 1000) return `${sign}${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
  return `${sign}${n.toFixed(4).replace(/\.?0+$/, '')}`
}

function formatNumber(value: unknown) {
  const n = numberFrom(value)
  if (n == null) return '--'
  if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (Math.abs(n) >= 1) return n.toFixed(4).replace(/\.?0+$/, '')
  return n.toFixed(8).replace(/\.?0+$/, '')
}

function formatTradeTime(value: unknown) {
  if (typeof value === 'string' && value) {
    const timestamp = Date.parse(value)
    return Number.isNaN(timestamp) ? value : new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
  }
  const timestamp = numberFrom(value)
  if (timestamp == null) return '--'
  const millis = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp
  return new Date(millis).toLocaleString('zh-CN', { hour12: false })
}

function tradeSide(trade: TradeInfo) {
  if (typeof trade.is_short === 'boolean') return trade.is_short ? 'SHORT' : 'LONG'
  const direction = String(trade.trade_direction ?? trade.entry_side ?? trade.side ?? '').toUpperCase()
  return direction || '--'
}

function normalizeOpenTrades(payload: unknown): FreqtradeTableRow[] {
  if (!Array.isArray(payload)) return []
  return payload.map((item) => {
    const trade = item && typeof item === 'object' ? item as TradeInfo : {}
    return {
      source: 'BOT',
      symbol: String(trade.pair ?? trade.symbol ?? '--'),
      side: tradeSide(trade),
      size: formatNumber(trade.amount ?? trade.amount_requested),
      entry: formatNumber(trade.open_rate),
      mark: formatNumber(trade.current_rate),
      pnl: formatAmount(trade.profit_abs ?? trade.close_profit_abs),
      risk: formatNumber(trade.liquidation_price ?? trade.stop_loss_abs),
      strategy: String(trade.strategy ?? '--'),
    }
  })
}

function normalizeTradeHistory(payload: unknown): FreqtradeTableRow[] {
  const trades = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as TradeHistory).trades)
      ? (payload as TradeHistory).trades ?? []
      : []

  return trades.slice(0, 50).map((item) => {
    const trade = item && typeof item === 'object' ? item as TradeInfo : {}
    const fee = numberFrom(trade.fee_close_cost ?? trade.fee_open_cost)
    const feeCurrency = String(trade.quote_currency ?? trade.stake_currency ?? '')
    return {
      source: 'BOT',
      time: formatTradeTime(trade.close_date ?? trade.close_timestamp ?? trade.open_date ?? trade.open_timestamp),
      symbol: String(trade.pair ?? trade.symbol ?? '--'),
      side: tradeSide(trade),
      amount: formatNumber(trade.amount ?? trade.amount_requested),
      price: formatNumber(trade.close_rate ?? trade.open_rate),
      pnl: formatAmount(trade.close_profit_abs ?? trade.profit_abs),
      fee: fee == null ? '--' : `${formatNumber(fee)} ${feeCurrency}`.trim(),
      strategy: String(trade.strategy ?? '--'),
    }
  })
}

function formatPercent(value: unknown, signed = false) {
  const n = numberFrom(value)
  if (n == null) return '--'
  const percent = Math.abs(n) <= 1 ? n * 100 : n
  const sign = signed && percent > 0 ? '+' : ''
  return `${sign}${percent.toFixed(2)}%`
}

function formatBacktestProfit(item: NonNullable<BacktestResults['results']>[number]) {
  const pct = formatPercent(item.profitPct, true)
  const abs = formatAmount(item.profitAbs)
  if (pct === '--') return abs
  if (abs === '--') return pct
  return `${pct} / ${abs}`
}

function formatMode(dryRun: boolean | null) {
  if (dryRun == null) return '--'
  return dryRun ? 'DRY_RUN' : 'LIVE'
}

function normalizePairs(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function strategyRows(
  strategies: string[],
  current: string,
  timeframe: string,
  dryRun: boolean | null,
  backtests: BacktestResults | null,
): FreqtradeTableRow[] {
  const backtestedStrategies = new Set(
    (backtests?.evidence ?? [])
      .filter((evidence) => evidence.current === true)
      .map((evidence) => evidence.strategy)
      .filter((strategy): strategy is string => Boolean(strategy)),
  )

  return strategies.map((strategy) => ({
    strategy,
    status: strategy === current ? '当前' : '可用',
    timeframe: strategy === current ? timeframe || '--' : '--',
    mode: strategy === current ? formatMode(dryRun) : '--',
    verification: backtestedStrategies.has(strategy) ? '已回测' : '待回测',
  }))
}

function backtestRows(results: BacktestResults | null): FreqtradeTableRow[] {
  const evidenceByResult = new Map(
    (results?.evidence ?? [])
      .filter((evidence) => evidence.resultFile)
      .map((evidence) => [evidence.resultFile, evidence]),
  )

  return (results?.results ?? []).map((item) => ({
    strategy: item.strategy || '--',
    range: item.start || item.end ? `${item.start || '--'} ~ ${item.end || '--'}` : '--',
    timeframe: item.timeframe || '--',
    trades: item.trades ?? '--',
    profit: formatBacktestProfit(item),
    win: formatPercent(item.winRate),
    drawdown: formatPercent(item.drawdown),
    verification: evidenceByResult.get(item.file)?.current ? '当前代码' : '需重跑',
    file: item.file || '--',
  }))
}

function riskRows({
  daemon,
  profit,
  sourceStatus,
}: {
  daemon: FreqtradeSnapshot['daemon']
  profit: FreqtradeSnapshot['profit']
  sourceStatus: FreqtradeSnapshot['source']['status']
}): FreqtradeTableRow[] {
  return [
    { rule: 'daemon', value: daemon.online ? 'ONLINE' : 'OFFLINE', state: daemon.online ? '正常' : '离线' },
    { rule: 'mode', value: formatMode(daemon.dryRun), state: daemon.dryRun === false ? '实盘' : '只读' },
    { rule: 'strategy', value: daemon.strategy || '--', state: sourceStatus === 'offline' ? '离线' : '已连接' },
    { rule: 'open_trades', value: `${daemon.openTrades} / ${daemon.maxOpenTrades || '--'}`, state: '监测' },
    { rule: 'closed_pnl', value: profit.closed, state: '已平仓' },
    { rule: 'total_pnl', value: profit.total, state: '含浮动' },
  ]
}

function auditRows({
  daemon,
  sourceStatus,
  errors,
  logs,
}: {
  daemon: FreqtradeSnapshot['daemon']
  sourceStatus: FreqtradeSnapshot['source']['status']
  errors: string[]
  logs: LogsInfo | null
}): FreqtradeTableRow[] {
  const rows: FreqtradeTableRow[] = [
    { time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), actor: 'Freqtrade', event: 'snapshot', result: sourceStatus },
  ]

  if (daemon.pairs.length > 0) {
    rows.push({
      time: '--',
      actor: 'Freqtrade',
      event: 'pairs',
      result: daemon.pairs.slice(0, 6).join(', '),
    })
  }

  for (const error of errors.slice(0, 3)) {
    rows.push({ time: '--', actor: 'Freqtrade', event: 'error', result: error })
  }

  rows.push(...getFreqtradeAuditRows().slice(0, 12))

  const logLines = (logs?.logs ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8)

  for (const line of logLines) {
    const match = line.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})[.,]\d+\s+-\s+([^-]+)\s+-\s+([A-Z]+)\s+-\s+(.*)$/)
    rows.push({
      time: match?.[1]?.slice(11) ?? '--',
      actor: match?.[2]?.trim() || 'Freqtrade',
      event: match?.[3]?.toLowerCase() || 'log',
      result: sanitizeLogLine(match?.[4] ?? line),
    })
  }

  return rows
}

export async function getReadOnlyFreqtradeSnapshot(): Promise<FreqtradeSnapshot> {
  const fetchedAt = Date.now()
  const [daemonInfo, profitInfo, openTrades, tradeHistory, strategyList, backtests, logs] = await Promise.all([
    runFreqtradeAction<DaemonInfo>('ft.mjs', 'daemon_info'),
    runFreqtradeAction<ProfitInfo>('ft.mjs', 'profit'),
    runFreqtradeAction<unknown[]>('ft.mjs', 'trades_open'),
    runFreqtradeAction<TradeHistory>('ft.mjs', 'trades_history', { limit: 50 }),
    runFreqtradeAction<StrategyList>('ft-deploy.mjs', 'strategy_list'),
    runFreqtradeAction<BacktestResults>('ft-deploy.mjs', 'backtest_results'),
    runFreqtradeAction<LogsInfo>('ft-deploy.mjs', 'logs', { lines: 12 }),
  ])

  const errors = Array.from(new Set(
    [daemonInfo, profitInfo, openTrades, tradeHistory, strategyList, backtests, logs]
      .filter((result): result is { ok: false; error: string } => !result.ok)
      .map((result) => result.error),
  ))

  const daemonData = daemonInfo.ok ? daemonInfo.data : {}
  const profitData = profitInfo.ok ? profitInfo.data : {}
  const openTradesCount = openTrades.ok && Array.isArray(openTrades.data)
    ? openTrades.data.length
    : numberFrom(daemonData.open_trades_count) ?? 0
  const closed = numberFrom(profitData.profit_closed_coin)
  const total = numberFrom(profitData.profit_all_coin)
  const floating = closed == null || total == null ? undefined : total - closed
  const strategies = strategyList.ok ? strategyList.data.strategies ?? [] : []

  const daemon: FreqtradeSnapshot['daemon'] = {
    online: daemonInfo.ok && daemonData.online === true,
    strategy: daemonData.strategy || '--',
    timeframe: daemonData.timeframe || '--',
    dryRun: typeof daemonData.dry_run === 'boolean' ? daemonData.dry_run : null,
    tradingMode: daemonData.trading_mode || '--',
    openTrades: openTradesCount,
    maxOpenTrades: daemonData.max_open_trades ?? '--',
    stakeCurrency: daemonData.stake_currency || profitData.stake_currency || 'USDT',
    pairs: normalizePairs(daemonData.pair_whitelist),
    version: daemonData.version || '--',
  }
  const profit: FreqtradeSnapshot['profit'] = {
    closed: formatAmount(closed),
    total: formatAmount(total),
    floating: formatAmount(floating),
    closedTrades: profitData.closed_trade_count ?? '--',
  }
  const sourceStatus: FreqtradeSnapshot['source']['status'] = daemonInfo.ok
    ? errors.length > 0
      ? 'partial'
      : 'live'
    : (strategyList.ok || backtests.ok)
      ? 'partial'
      : 'offline'

  return {
    ok: daemonInfo.ok && errors.length === 0,
    mode: 'read_only',
    daemon,
    profit,
    tables: {
      positions: normalizeOpenTrades(openTrades.ok ? openTrades.data : null),
      history: normalizeTradeHistory(tradeHistory.ok ? tradeHistory.data : null),
      strategies: strategyRows(
        strategies,
        daemon.strategy,
        daemon.timeframe,
        daemon.dryRun,
        backtests.ok ? backtests.data : null,
      ),
      backtests: backtestRows(backtests.ok ? backtests.data : null),
      risk: riskRows({ daemon, profit, sourceStatus }),
      audit: auditRows({ daemon, sourceStatus, errors, logs: logs.ok ? logs.data : null }),
    },
    source: {
      name: 'Freqtrade',
      status: sourceStatus,
      fetchedAt,
      errors,
      permissions: {
        read: sourceStatus !== 'offline',
        trade: false,
      },
    },
  }
}

export async function runReadOnlyFreqtradeBacktest(input: Partial<FreqtradeBacktestRequest>): Promise<ActionResult<FreqtradeBacktestResult>> {
  let params: FreqtradeBacktestRequest
  try {
    params = normalizeBacktestRequest(input)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '回测参数不正确' }
  }

  const result = await runFreqtradeAction<BacktestOutput>(
    'ft-deploy.mjs',
    'backtest',
    {
      strategy: params.strategy,
      timeframe: params.timeframe,
      timerange: params.timerange,
      pairs: params.pairs,
    },
    BACKTEST_TIMEOUT_MS,
  )

  if (!result.ok) return result

  return {
    ok: true,
    data: {
      strategy: result.data.strategy || params.strategy,
      timeframe: result.data.timeframe || params.timeframe,
      timerange: result.data.timerange || params.timerange || 'all available',
      output: result.data.output || '',
    },
  }
}

export async function createFreqtradeStrategy(input: Partial<FreqtradeStrategyCreateRequest>): Promise<ActionResult<FreqtradeStrategyCreateResult>> {
  let params: FreqtradeStrategyCreateRequest
  try {
    params = normalizeStrategyCreateRequest(input)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '策略参数不正确' }
  }

  const result = await runFreqtradeAction<StrategyCreateOutput>(
    'ft-deploy.mjs',
    'create_strategy',
    {
      name: params.name,
      timeframe: params.timeframe,
      direction: params.direction,
      indicators: params.indicators,
    },
  )

  if (!result.ok) return result

  return {
    ok: true,
    data: {
      strategy: result.data.strategy || params.name,
      timeframe: result.data.timeframe || params.timeframe,
      direction: result.data.direction || params.direction,
      indicators: result.data.indicators || params.indicators,
      note: result.data.note || '',
      next: result.data.next || '',
    },
  }
}

export async function deployFreqtradeDryRun(input: Partial<FreqtradeDryRunDeployRequest>): Promise<ActionResult<FreqtradeDryRunDeployResult>> {
  let params: FreqtradeDryRunDeployRequest
  try {
    params = normalizeDryRunDeployRequest(input)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '部署参数不正确' }
  }

  const backtests = await runFreqtradeAction<BacktestResults>('ft-deploy.mjs', 'backtest_results')
  if (!backtests.ok) return { ok: false, error: `无法确认回测结果: ${backtests.error}` }

  const hasCurrentBacktest = (backtests.data.evidence ?? [])
    .some((item) => item.strategy === params.strategy && item.current === true)
  if (!hasCurrentBacktest) {
    return { ok: false, error: '当前策略代码尚无有效回测，请重新回测后再进行模拟部署' }
  }

  const result = await runFreqtradeAction<DeployOutput>(
    'ft-deploy.mjs',
    'deploy',
    {
      strategy: params.strategy,
      dry_run: true,
      pairs: params.pairs,
      max_open_trades: params.maxOpenTrades,
    },
    DEPLOY_TIMEOUT_MS,
  )

  if (!result.ok) return result
  if (result.data.warning) return { ok: false, error: '拒绝实盘部署: deploy 返回了实盘警告' }

  return {
    ok: true,
    data: {
      strategy: result.data.strategy || params.strategy,
      mode: result.data.mode || '--',
      dryRun: true,
      pairs: result.data.pairs || params.pairs || [],
      maxOpenTrades: numberFrom(result.data.max_open_trades) ?? params.maxOpenTrades,
      note: result.data.note || 'DRY_RUN strategy deployed',
    },
  }
}
