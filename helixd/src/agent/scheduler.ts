import { createHash } from 'node:crypto'
import type { AgentAnalysisTrigger, AgentScope } from '@helix/contracts/agent'
import {
  readAgentSchedulerState,
  recoverInterruptedAgentAnalysisRuns,
  writeAgentSchedulerState,
} from './analysis-store'
import { runScheduledAgentAnalysisWithRetry } from './analysis-runner'
import { agentConfigValue, readHelixEnvFile } from './config-env'
import { listRecentAgentConversationScopes } from './conversation-store'
import { getAgentMarketContext, type AgentMarketContext } from './market-context'
import { logAgentError } from './logging'
import { resolveAgentProviderConfig } from './provider-config'
import { listMarketStoryScopes } from './story-store'

const DEFAULT_TIME_ZONE = 'Asia/Shanghai'

export type AgentSchedulerConfig = {
  enabled: boolean
  pollIntervalMs: number
  dailyHour: number
  timeZone: string
  maxAttempts: number
}

type SchedulerDependencies = {
  listScopes: () => Promise<AgentScope[]>
  getMarketContext: (scope: AgentScope) => Promise<AgentMarketContext>
  readState: (key: string) => string | null
  writeState: (key: string, value: string) => void
  runAnalysis: (scope: AgentScope, trigger: AgentAnalysisTrigger, maxAttempts: number) => Promise<unknown>
}

function integer(value: string, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback
}

function validTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0)
    return value
  } catch {
    return DEFAULT_TIME_ZONE
  }
}

export function resolveAgentSchedulerConfig(
  environment: NodeJS.ProcessEnv = process.env,
  file: Record<string, string | undefined> = readHelixEnvFile(),
): AgentSchedulerConfig {
  const provider = resolveAgentProviderConfig(environment, file)
  const requested = agentConfigValue('HELIX_AGENT_SCHEDULER_ENABLED', environment, file).toLowerCase()
  return {
    enabled: requested !== 'false' && provider.configured,
    pollIntervalMs: integer(
      agentConfigValue('HELIX_AGENT_SCHEDULER_POLL_MS', environment, file),
      60_000,
      30_000,
      60 * 60_000,
    ),
    dailyHour: integer(agentConfigValue('HELIX_AGENT_DAILY_HOUR', environment, file), 8, 0, 23),
    timeZone: validTimeZone(agentConfigValue('HELIX_AGENT_TIME_ZONE', environment, file) || DEFAULT_TIME_ZONE),
    maxAttempts: integer(agentConfigValue('HELIX_AGENT_MAX_ATTEMPTS', environment, file), 3, 1, 5),
  }
}

async function trackedScopes() {
  const scopes = [...listMarketStoryScopes(20), ...listRecentAgentConversationScopes(20)]
    .map(({ symbol, timeframe }) => ({ symbol, timeframe }))
  return [...new Map(scopes.map((scope) => [`${scope.symbol}:${scope.timeframe}`, scope])).values()]
}

const defaultDependencies: SchedulerDependencies = {
  listScopes: trackedScopes,
  getMarketContext: getAgentMarketContext,
  readState: readAgentSchedulerState,
  writeState: writeAgentSchedulerState,
  runAnalysis: runScheduledAgentAnalysisWithRetry,
}

export function marketContextFingerprint(context: AgentMarketContext) {
  const evidence = context.evidence.filter((item) => (
    item.ref.startsWith('strategy.')
    || item.ref === 'signal.status'
    || item.ref === 'signal.side'
    || item.ref === 'signal.bias'
  ))
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex')
}

function localDateParts(timestamp: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(timestamp)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    hour: Number(value('hour')),
  }
}

export function createAgentScheduler(
  config: AgentSchedulerConfig,
  dependencies: SchedulerDependencies = defaultDependencies,
) {
  const inFlight = new Set<string>()
  let timer: NodeJS.Timeout | undefined

  const tick = async (now = Date.now()) => {
    if (!config.enabled) return
    const { date, hour } = localDateParts(now, config.timeZone)
    const scopes = await dependencies.listScopes()
    for (const scope of scopes) {
      const scopeKey = `${scope.symbol}:${scope.timeframe}`
      if (inFlight.has(scopeKey)) continue
      inFlight.add(scopeKey)
      try {
        const context = await dependencies.getMarketContext(scope)
        const fingerprint = marketContextFingerprint(context)
        const fingerprintKey = `market-fingerprint:${scopeKey}`
        const previousFingerprint = dependencies.readState(fingerprintKey)
        const dailyKey = `daily:${date}:${scopeKey}`
        const dailyDue = hour >= config.dailyHour && dependencies.readState(dailyKey) !== 'succeeded'

        if (dailyDue) {
          await dependencies.runAnalysis(scope, 'daily', config.maxAttempts)
          dependencies.writeState(dailyKey, 'succeeded')
          dependencies.writeState(fingerprintKey, fingerprint)
        } else if (previousFingerprint == null) {
          dependencies.writeState(fingerprintKey, fingerprint)
        } else if (context.canPersistStory && previousFingerprint !== fingerprint) {
          await dependencies.runAnalysis(scope, 'market-change', config.maxAttempts)
          dependencies.writeState(fingerprintKey, fingerprint)
        }
      } catch (error) {
        logAgentError('scheduler_scope_failed', error, scope)
      } finally {
        inFlight.delete(scopeKey)
      }
    }
  }

  return {
    tick,
    start() {
      if (!config.enabled || timer) return
      const recovered = recoverInterruptedAgentAnalysisRuns()
      if (recovered > 0) console.warn(`helix-agent recovered ${recovered} interrupted analysis run(s)`)
      void tick()
      timer = setInterval(() => void tick(), config.pollIntervalMs)
      timer.unref()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
    },
  }
}

export function startAgentScheduler() {
  const scheduler = createAgentScheduler(resolveAgentSchedulerConfig())
  scheduler.start()
  return scheduler
}
