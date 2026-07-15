import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'

export function readHelixEnvFile() {
  try {
    return parseEnv(readFileSync(resolve(homedir(), '.helix', '.env'), 'utf8'))
  } catch {
    return {}
  }
}

export function agentConfigValue(
  name: string,
  environment: NodeJS.ProcessEnv,
  file: Record<string, string | undefined>,
) {
  return (environment[name] || file[name] || '').trim()
}
