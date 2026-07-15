import type { Context } from 'hono'

export async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    const value = await c.req.json<unknown>()
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

export function stringField(value: unknown) {
  return typeof value === 'string' ? value : undefined
}

export function stringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined
}

export function numberField(value: unknown) {
  return typeof value === 'number' ? value : undefined
}
