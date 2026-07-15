import {
  createAgentUIStreamResponse,
  safeValidateUIMessages,
  type InferAgentUIMessage,
} from 'ai'
import { randomUUID } from 'node:crypto'
import {
  AGENT_RECENT_MESSAGE_LIMIT,
  DEFAULT_AGENT_CONVERSATION_ID,
  type AgentAnalysisHistoryResponse,
  type AgentConversationResponse,
  type AgentStatusResponse,
  type AgentStoryHistoryResponse,
  type AgentStoryResponse,
} from '@helix/contracts/agent'
import { Hono } from 'hono'
import {
  contextualizeAgentMessages,
  filterArchivedAgentMessages,
  mergeAgentConversation,
  messagesWithAgentSceneContext,
  readAgentConversation,
  readAgentConversationArchive,
  readVisibleAgentConversation,
  writeAgentConversation,
} from '../agent/conversation-store'
import { compactAgentConversationIfNeeded } from '../agent/conversation-compaction'
import { resolveAgentProviderConfig } from '../agent/provider-config'
import { createHelixAnalyst } from '../agent/runtime'
import { readAgentAnalysisRuns } from '../agent/analysis-store'
import { logAgentError } from '../agent/logging'
import {
  createAgentMemoryClient,
  resolveAgentMemoryConfig,
  type AgentUserMemory,
} from '../agent/memory'
import {
  agentChatRequestSchema,
  agentScopeSchema,
  agentStoryHistoryQuerySchema,
  normalizeAgentScope,
} from '../agent/schemas'
import { readMarketStory, readMarketStoryEvents } from '../agent/story-store'
import { readJson } from '../http'

export const agentRoutes = new Hono()

function latestUserText(messages: unknown[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message == null || typeof message !== 'object') continue
    const record = message as Record<string, unknown>
    if (record.role !== 'user' || !Array.isArray(record.parts)) continue
    return record.parts.flatMap((part) => (
      part != null && typeof part === 'object'
      && (part as Record<string, unknown>).type === 'text'
      && typeof (part as Record<string, unknown>).text === 'string'
        ? [(part as Record<string, unknown>).text as string]
        : []
    )).join('\n').trim()
  }
  return ''
}

async function relevantMemories(
  memoryClient: ReturnType<typeof createAgentMemoryClient>,
  query: string,
  scope: { symbol: string; timeframe: string },
): Promise<AgentUserMemory[]> {
  if (!memoryClient || !query) return []
  try {
    return await memoryClient.search(query, 5)
  } catch (error) {
    logAgentError('memory_search_failed', error, scope)
    return []
  }
}

agentRoutes.get('/status', (c) => {
  const config = resolveAgentProviderConfig()
  const memoryConfig = resolveAgentMemoryConfig()
  return c.json({
    ok: true,
    service: 'helix-agent',
    model: config.model,
    modelConfigured: config.configured,
    apiMode: config.apiMode,
    customBaseURL: config.customBaseURL,
    configurationError: config.error,
    memoryConfigured: memoryConfig.configured,
    memoryCustomBaseURL: memoryConfig.customBaseURL,
    memoryConfigurationError: memoryConfig.error,
  } satisfies AgentStatusResponse)
})

agentRoutes.get('/story', (c) => {
  const parsed = agentScopeSchema.safeParse({
    symbol: c.req.query('symbol'),
    timeframe: c.req.query('timeframe'),
  })
  if (!parsed.success) return c.json({ ok: false, error: '需要有效的 symbol 和 timeframe' }, 400)

  const scope = normalizeAgentScope(parsed.data)
  return c.json({
    ok: true,
    scope,
    story: readMarketStory(scope),
  } satisfies AgentStoryResponse)
})

agentRoutes.get('/story/history', (c) => {
  const parsed = agentStoryHistoryQuerySchema.safeParse({
    symbol: c.req.query('symbol'),
    timeframe: c.req.query('timeframe'),
    limit: c.req.query('limit'),
  })
  if (!parsed.success) return c.json({ ok: false, error: '需要有效的 symbol、timeframe 和 limit' }, 400)

  const scope = normalizeAgentScope(parsed.data)
  return c.json({
    ok: true,
    scope,
    events: readMarketStoryEvents(scope, parsed.data.limit),
  } satisfies AgentStoryHistoryResponse)
})

agentRoutes.get('/analyses', (c) => {
  const parsed = agentStoryHistoryQuerySchema.safeParse({
    symbol: c.req.query('symbol'),
    timeframe: c.req.query('timeframe'),
    limit: c.req.query('limit'),
  })
  if (!parsed.success) return c.json({ ok: false, error: '需要有效的 symbol、timeframe 和 limit' }, 400)

  const scope = normalizeAgentScope(parsed.data)
  return c.json({
    ok: true,
    scope,
    runs: readAgentAnalysisRuns(scope, parsed.data.limit),
  } satisfies AgentAnalysisHistoryResponse)
})

agentRoutes.get('/conversation', (c) => {
  return c.json({
    ok: true,
    conversationId: DEFAULT_AGENT_CONVERSATION_ID,
    messages: readVisibleAgentConversation(DEFAULT_AGENT_CONVERSATION_ID),
  } satisfies AgentConversationResponse)
})

agentRoutes.post('/chat', async (c) => {
  const providerConfig = resolveAgentProviderConfig()
  if (providerConfig.error) {
    return c.json({ ok: false, error: providerConfig.error }, 503)
  }
  if (!providerConfig.configured) {
    return c.json({ ok: false, error: '未配置 HELIX_OPENAI_API_KEY 或 OPENAI_API_KEY' }, 503)
  }

  const parsed = agentChatRequestSchema.safeParse(await readJson(c))
  if (!parsed.success) return c.json({ ok: false, error: 'Agent 请求格式无效' }, 400)

  const scope = normalizeAgentScope(parsed.data)
  const memoryClient = createAgentMemoryClient(resolveAgentMemoryConfig())
  const [userMemories, conversationArchive] = await Promise.all([
    relevantMemories(memoryClient, latestUserText(parsed.data.messages), scope),
    Promise.resolve(readAgentConversationArchive(DEFAULT_AGENT_CONVERSATION_ID)),
  ])
  const agent = createHelixAnalyst({
    scene: scope,
    providerConfig,
    memoryClient,
    userMemories,
    conversationArchive,
  })
  const validated = await safeValidateUIMessages<InferAgentUIMessage<typeof agent>>({
    messages: parsed.data.messages,
    tools: agent.tools,
  })
  if (!validated.success) return c.json({ ok: false, error: 'Agent 消息格式无效' }, 400)

  const history = readAgentConversation<InferAgentUIMessage<typeof agent>>(
    DEFAULT_AGENT_CONVERSATION_ID,
  )
  const unarchived = filterArchivedAgentMessages(DEFAULT_AGENT_CONVERSATION_ID, validated.data)
  const incoming = contextualizeAgentMessages(history, unarchived, scope)
  const conversation = mergeAgentConversation(history, incoming)
  const recentMessages = conversation.slice(-AGENT_RECENT_MESSAGE_LIMIT)
  writeAgentConversation(DEFAULT_AGENT_CONVERSATION_ID, scope, incoming)

  return createAgentUIStreamResponse({
    agent,
    uiMessages: messagesWithAgentSceneContext(recentMessages),
    originalMessages: recentMessages,
    generateMessageId: randomUUID,
    messageMetadata: () => ({ helix: { scene: scope } }),
    abortSignal: c.req.raw.signal,
    headers: { 'Cache-Control': 'no-store' },
    onError: (error) => {
      logAgentError('agent_stream_failed', error, scope)
      return 'Helix Agent 暂时无法完成本次分析。'
    },
    onEnd: ({ messages }) => {
      writeAgentConversation(DEFAULT_AGENT_CONVERSATION_ID, scope, messages)
      void compactAgentConversationIfNeeded(providerConfig)
    },
  })
})
