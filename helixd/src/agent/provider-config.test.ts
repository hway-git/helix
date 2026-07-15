import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveAgentProviderConfig } from './provider-config'

test('custom base URL defaults to chat completions and accepts a dedicated key', () => {
  const config = resolveAgentProviderConfig({
    HELIX_OPENAI_API_KEY: 'proxy-key',
    HELIX_OPENAI_BASE_URL: 'https://llm.example.com/v1/',
    HELIX_OPENAI_MODEL: 'compatible-model',
  }, {})

  assert.equal(config.apiKey, 'proxy-key')
  assert.equal(config.baseURL, 'https://llm.example.com/v1/')
  assert.equal(config.apiMode, 'chat')
  assert.equal(config.model, 'compatible-model')
  assert.equal(config.configured, true)
  assert.equal(config.customBaseURL, true)
})

test('responses mode can be selected explicitly and process env wins over the env file', () => {
  const config = resolveAgentProviderConfig({
    OPENAI_API_KEY: 'process-key',
    HELIX_OPENAI_API_MODE: 'responses',
  }, {
    OPENAI_API_KEY: 'file-key',
    HELIX_OPENAI_BASE_URL: 'https://gateway.example.com/v1',
  })

  assert.equal(config.apiKey, 'process-key')
  assert.equal(config.apiMode, 'responses')
  assert.equal(config.baseURL, 'https://gateway.example.com/v1')
})

test('invalid provider configuration is rejected before a model call', () => {
  const config = resolveAgentProviderConfig({
    HELIX_OPENAI_API_KEY: 'proxy-key',
    HELIX_OPENAI_BASE_URL: 'file:///tmp/model',
    HELIX_OPENAI_API_MODE: 'unknown',
  }, {})

  assert.equal(config.configured, false)
  assert.match(config.error ?? '', /API_MODE/)
})
