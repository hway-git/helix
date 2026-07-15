import { z } from 'zod'

export const agentScopeSchema = z.object({
  symbol: z.string().trim().min(1).max(32),
  timeframe: z.string().trim().min(1).max(16),
})

export const marketStoryStateSchema = z.enum([
  'watching',
  'armed',
  'confirmed',
  'rejected',
  'expired',
])

export const marketScenarioSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(['primary', 'alternative']),
  thesis: z.string(),
  expectation: z.string(),
  state: marketStoryStateSchema,
  waitingFor: z.string(),
  invalidation: z.string(),
  evidenceRefs: z.array(z.string()),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})

const scenarioUpdateSchema = z.object({
  id: z.string().uuid().optional(),
  role: z.enum(['primary', 'alternative']),
  thesis: z.string().trim().min(1).max(600),
  expectation: z.string().trim().min(1).max(400),
  state: marketStoryStateSchema,
  waitingFor: z.string().trim().min(1).max(400),
  invalidation: z.string().trim().min(1).max(400),
  evidenceRefs: z.array(z.string().trim().min(1).max(120)).min(1).max(16),
})

function hasOnePrimary(value: { scenarios: Array<{ role: 'primary' | 'alternative' }> }) {
  return value.scenarios.filter((scenario) => scenario.role === 'primary').length === 1
}

function hasUniqueScenarioIds(value: { scenarios: Array<{ id?: string }> }) {
  const ids = value.scenarios.flatMap((scenario) => scenario.id ? [scenario.id] : [])
  return new Set(ids).size === ids.length
}

export const marketStoryToolUpdateSchema = z.object({
  summary: z.string().trim().min(1).max(1000),
  changeSummary: z.string().trim().min(1).max(600),
  scenarios: z.array(scenarioUpdateSchema).min(1).max(3),
}).refine(hasOnePrimary, {
  message: 'Market Story 必须且只能包含一个 primary scenario',
  path: ['scenarios'],
})

export const marketStoryUpdateSchema = z.object({
  summary: z.string().trim().min(1).max(1000),
  changeSummary: z.string().trim().min(1).max(600),
  analysisSource: z.string().trim().min(1).max(80),
  strategyVersion: z.string().trim().min(1).max(80),
  scenarios: z.array(scenarioUpdateSchema).min(1).max(3),
}).refine(hasOnePrimary, {
  message: 'Market Story 必须且只能包含一个 primary scenario',
  path: ['scenarios'],
}).refine(hasUniqueScenarioIds, {
  message: 'Market Story scenario id 不得重复',
  path: ['scenarios'],
})

export const agentStoryHistoryQuerySchema = agentScopeSchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

export const marketStorySchema = z.object({
  id: z.string().uuid(),
  symbol: z.string(),
  timeframe: z.string(),
  revision: z.number().int().positive(),
  summary: z.string(),
  changeSummary: z.string(),
  analysisSource: z.string(),
  strategyVersion: z.string(),
  scenarios: z.array(marketScenarioSchema),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})

export const agentChatRequestSchema = z.object({
  messages: z.array(z.unknown()).max(100),
  symbol: z.string().trim().min(1).max(32),
  timeframe: z.string().trim().min(1).max(16),
})

export type MarketStoryUpdate = z.infer<typeof marketStoryUpdateSchema>

export function normalizeAgentSymbol(value: string) {
  const normalized = value.trim().toUpperCase()
    .replace(/-SWAP$/, '')
    .replace('-', '/')
  return /^[A-Z0-9]+$/.test(normalized) ? `${normalized}/USDT` : normalized
}

export function normalizeAgentScope(input: z.infer<typeof agentScopeSchema>) {
  return {
    symbol: normalizeAgentSymbol(input.symbol),
    timeframe: input.timeframe.trim().toLowerCase(),
  }
}

export function agentScopeKey(input: z.infer<typeof agentScopeSchema>) {
  const scope = normalizeAgentScope(input)
  return `${scope.symbol}:${scope.timeframe}`
}
