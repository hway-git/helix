import type { AgentScope } from '@helix/contracts/agent'

function errorDetails(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: 'UnknownError', message: String(error) }
}

export function logAgentError(event: string, error: unknown, scope?: AgentScope) {
  console.error(JSON.stringify({
    level: 'error',
    service: 'helix-agent',
    event,
    scope,
    error: errorDetails(error),
    occurredAt: Date.now(),
  }))
}
