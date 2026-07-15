import { agentConfigValue, readHelixEnvFile } from './config-env'

const DEFAULT_MEM0_BASE_URL = 'https://api.mem0.ai'
const DEFAULT_MEM0_USER_ID = 'helix-local-user'
const REQUEST_TIMEOUT_MS = 8_000

export const LONG_TERM_MEMORY_CATEGORIES = [
  'trading-preference',
  'analysis-habit',
  'trading-discipline',
  'behavior-pattern',
  'recognized-experience',
  'communication-preference',
] as const

export type LongTermMemoryCategory = typeof LONG_TERM_MEMORY_CATEGORIES[number]

export type AgentUserMemory = {
  id: string
  memory: string
  categories: string[]
  score?: number
}

export type AgentMemoryConfig = {
  apiKey: string
  baseURL: string
  userId: string
  configured: boolean
  customBaseURL: boolean
  error: string | null
}

export type AgentMemoryClient = {
  search(query: string, limit?: number): Promise<AgentUserMemory[]>
  remember(memory: string, category: LongTermMemoryCategory): Promise<void>
}

function validateBaseURL(value: string) {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? null
      : 'HELIX_MEM0_BASE_URL 只支持 http 或 https'
  } catch {
    return 'HELIX_MEM0_BASE_URL 不是有效 URL'
  }
}

export function resolveAgentMemoryConfig(
  environment: NodeJS.ProcessEnv = process.env,
  file: Record<string, string | undefined> = readHelixEnvFile(),
): AgentMemoryConfig {
  const apiKey = agentConfigValue('HELIX_MEM0_API_KEY', environment, file)
  const configuredBaseURL = agentConfigValue('HELIX_MEM0_BASE_URL', environment, file)
  const error = validateBaseURL(configuredBaseURL)
  return {
    apiKey,
    baseURL: (configuredBaseURL || DEFAULT_MEM0_BASE_URL).replace(/\/$/, ''),
    userId: agentConfigValue('HELIX_MEM0_USER_ID', environment, file) || DEFAULT_MEM0_USER_ID,
    configured: Boolean(apiKey || configuredBaseURL) && error == null,
    customBaseURL: Boolean(configuredBaseURL),
    error,
  }
}

function memoryText(value: unknown) {
  if (value == null || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  if (typeof record.memory === 'string') return record.memory
  const data = record.data
  return data != null && typeof data === 'object' && typeof (data as Record<string, unknown>).memory === 'string'
    ? (data as Record<string, unknown>).memory as string
    : ''
}

export function createAgentMemoryClient(
  config: AgentMemoryConfig,
  fetcher: typeof fetch = fetch,
): AgentMemoryClient | null {
  if (!config.configured) return null

  const request = async (path: string, body: Record<string, unknown>) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (config.apiKey) headers.Authorization = `Token ${config.apiKey}`
    const response = await fetcher(`${config.baseURL}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`MEM0_HTTP_${response.status}`)
    return response.json() as Promise<unknown>
  }

  return {
    async search(query, limit = 5) {
      const response = await request('/v3/memories/search/', {
        query,
        output_format: 'v1.1',
        top_k: Math.max(1, Math.min(10, Math.trunc(limit))),
        latest_only: true,
        filters: { user_id: config.userId },
      })
      const results = response != null && typeof response === 'object'
        && Array.isArray((response as Record<string, unknown>).results)
        ? (response as { results: unknown[] }).results
        : []
      return results.flatMap((item): AgentUserMemory[] => {
        if (item == null || typeof item !== 'object') return []
        const record = item as Record<string, unknown>
        const memory = memoryText(record).trim()
        if (!memory) return []
        return [{
          id: typeof record.id === 'string' ? record.id : '',
          memory,
          categories: Array.isArray(record.categories)
            ? record.categories.filter((value): value is string => typeof value === 'string')
            : [],
          score: typeof record.score === 'number' ? record.score : undefined,
        }]
      })
    },

    async remember(memory, category) {
      await request('/v3/memories/add/', {
        messages: [{ role: 'user', content: memory }],
        user_id: config.userId,
        infer: true,
        metadata: {
          source: 'helix-agent',
          category,
        },
        custom_instructions: [
          'Only retain durable information about the user.',
          'Resolve conflicts by treating this current explicit statement as authoritative.',
          'Never retain live prices, indicators, setups, hypotheses, positions, orders, or other transient market facts.',
        ].join(' '),
      })
    },
  }
}
