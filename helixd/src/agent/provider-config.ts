import { agentConfigValue, readHelixEnvFile } from './config-env'

export const DEFAULT_AGENT_MODEL = 'gpt-5.6-terra'

export type AgentApiMode = 'responses' | 'chat'

export type AgentProviderConfig = {
  apiKey: string
  baseURL?: string
  apiMode: AgentApiMode
  model: string
  configured: boolean
  customBaseURL: boolean
  error: string | null
}

function validateBaseURL(value: string) {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? null
      : 'HELIX_OPENAI_BASE_URL 只支持 http 或 https'
  } catch {
    return 'HELIX_OPENAI_BASE_URL 不是有效 URL'
  }
}

export function resolveAgentProviderConfig(
  environment: NodeJS.ProcessEnv = process.env,
  file: Record<string, string | undefined> = readHelixEnvFile(),
): AgentProviderConfig {
  const apiKey = agentConfigValue('HELIX_OPENAI_API_KEY', environment, file)
    || agentConfigValue('OPENAI_API_KEY', environment, file)
  const baseURL = agentConfigValue('HELIX_OPENAI_BASE_URL', environment, file)
    || agentConfigValue('OPENAI_BASE_URL', environment, file)
  const requestedMode = agentConfigValue('HELIX_OPENAI_API_MODE', environment, file).toLowerCase()
  const modeError = requestedMode && requestedMode !== 'chat' && requestedMode !== 'responses'
    ? 'HELIX_OPENAI_API_MODE 只能是 chat 或 responses'
    : null
  const error = modeError ?? validateBaseURL(baseURL)
  const apiMode: AgentApiMode = requestedMode === 'chat' || requestedMode === 'responses'
    ? requestedMode
    : baseURL
      ? 'chat'
      : 'responses'

  return {
    apiKey,
    baseURL: baseURL || undefined,
    apiMode,
    model: agentConfigValue('HELIX_OPENAI_MODEL', environment, file) || DEFAULT_AGENT_MODEL,
    configured: Boolean(apiKey) && error == null,
    customBaseURL: Boolean(baseURL),
    error,
  }
}
