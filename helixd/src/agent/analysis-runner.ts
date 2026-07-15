import type { AgentAnalysisTrigger, AgentScope } from '@helix/contracts/agent'
import {
  completeAgentAnalysisRun,
  failAgentAnalysisRun,
  startAgentAnalysisRun,
} from './analysis-store'
import { logAgentError } from './logging'
import { createAgentMemoryClient, resolveAgentMemoryConfig } from './memory'
import { resolveAgentProviderConfig } from './provider-config'
import { createHelixAnalyst } from './runtime'
import { readMarketStory } from './story-store'

const ANALYSIS_TIMEOUT_MS = 120_000

function analysisPrompt(trigger: AgentAnalysisTrigger) {
  if (trigger === 'daily') {
    return `执行每日市场分析。必须先读取市场状态并与恢复的 Market Story 比较，然后回答：
1. 昨天或上次预期什么？
2. 市场实际发生了什么？
3. 哪些判断仍成立？
4. 哪些判断发生变化？
5. 当前正在观察什么？
6. 下一步等待什么？
只有证据支持且故事有意义变化时才更新 Market Story。不要写入长期用户记忆。`
  }
  return `检测到结构化市场状态发生变化。先读取市场状态，检查原 Market Story 和 Active Hypothesis，说明 retained、changed、invalidated、new，并在证据支持时更新 Market Story。不要写入长期用户记忆。`
}

function toolFailure(result: { steps: Array<{ content: unknown[] }> }) {
  for (const part of result.steps.flatMap((step) => step.content)) {
    if (part != null && typeof part === 'object' && (part as Record<string, unknown>).type === 'tool-error') {
      const error = (part as Record<string, unknown>).error
      return error instanceof Error ? error.message : String(error ?? 'unknown')
    }
  }
  return null
}

export async function runScheduledAgentAnalysis(
  input: AgentScope,
  trigger: AgentAnalysisTrigger,
  attempt: number,
) {
  const run = startAgentAnalysisRun(input, trigger, attempt)
  try {
    const providerConfig = resolveAgentProviderConfig()
    if (providerConfig.error) throw new Error(providerConfig.error)
    if (!providerConfig.configured) throw new Error('AGENT_MODEL_NOT_CONFIGURED')

    const memoryClient = createAgentMemoryClient(resolveAgentMemoryConfig())
    const userMemories = await (memoryClient
      ? memoryClient.search('长期交易偏好、分析习惯、交易纪律与常见行为模式', 5).catch((error) => {
        logAgentError('scheduled_memory_search_failed', error, input)
        return []
      })
      : Promise.resolve([]))
    const agent = createHelixAnalyst({
      scene: input,
      providerConfig,
      memoryClient,
      userMemories,
    })
    const result = await agent.generate({
      prompt: analysisPrompt(trigger),
      timeout: { totalMs: ANALYSIS_TIMEOUT_MS },
    })
    const failedTool = toolFailure(result)
    if (failedTool) throw new Error(`AGENT_TOOL_FAILED:${failedTool}`)
    const output = result.text.trim()
    if (!output) throw new Error('EMPTY_AGENT_ANALYSIS')
    const currentStory = readMarketStory(input)
    completeAgentAnalysisRun(run.id, output, currentStory?.revision ?? null)
    return { output, storyRevision: currentStory?.revision ?? null }
  } catch (error) {
    failAgentAnalysisRun(run.id, error)
    logAgentError('scheduled_analysis_failed', error, input)
    throw error
  }
}

function wait(delayMs: number) {
  return delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, delayMs)) : Promise.resolve()
}

export async function retryAgentAnalysis<T>(
  operation: (attempt: number) => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 1_000,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation(attempt)
    } catch (error) {
      lastError = error
      if (attempt < maxAttempts) await wait(baseDelayMs * 2 ** (attempt - 1))
    }
  }
  throw lastError
}

export function runScheduledAgentAnalysisWithRetry(
  scope: AgentScope,
  trigger: AgentAnalysisTrigger,
  maxAttempts = 3,
) {
  return retryAgentAnalysis(
    (attempt) => runScheduledAgentAnalysis(scope, trigger, attempt),
    maxAttempts,
  )
}
