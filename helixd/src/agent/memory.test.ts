import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentMemoryClient, resolveAgentMemoryConfig } from './memory'

test('Mem0 can use a custom authless endpoint and normalizes configuration', () => {
  const config = resolveAgentMemoryConfig({
    HELIX_MEM0_BASE_URL: 'http://127.0.0.1:8888/',
    HELIX_MEM0_USER_ID: 'local-trader',
  }, {})
  assert.equal(config.configured, true)
  assert.equal(config.baseURL, 'http://127.0.0.1:8888')
  assert.equal(config.userId, 'local-trader')
  assert.equal(config.apiKey, '')
})

test('Mem0 searches relevant memories and writes only through the constrained payload', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const fetcher = async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    requests.push({ url: String(input), init })
    const search = String(input).endsWith('/search/')
    return new Response(JSON.stringify(search
      ? { results: [{ id: 'm1', memory: 'Prefers objective analysis.', score: 0.9 }] }
      : [{ id: 'm2', event: 'ADD' }]), { status: 200 })
  }
  const client = createAgentMemoryClient({
    apiKey: 'mem0-key',
    baseURL: 'https://memory.example.com',
    userId: 'trader-1',
    configured: true,
    customBaseURL: true,
    error: null,
  }, fetcher as typeof fetch)!

  const memories = await client.search('How should this be analyzed?')
  await client.remember('I always wait for a closed-bar trigger.', 'trading-discipline')

  assert.deepEqual(memories.map((item) => item.memory), ['Prefers objective analysis.'])
  assert.equal(requests[0].url, 'https://memory.example.com/v3/memories/search/')
  assert.equal(new Headers(requests[0].init?.headers).get('Authorization'), 'Token mem0-key')
  const searchBody = JSON.parse(String(requests[0].init?.body))
  assert.deepEqual(searchBody.filters, { user_id: 'trader-1' })
  const addBody = JSON.parse(String(requests[1].init?.body))
  assert.equal(addBody.metadata.category, 'trading-discipline')
  assert.match(addBody.custom_instructions, /Never retain live prices/)
})
