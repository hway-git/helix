import assert from 'node:assert/strict'
import test from 'node:test'
import type { StrategyManifestIdentity } from '@helix/contracts/strategy'
import { evaluateStrategyEngineCompatibility, listEngineCapabilities } from './capability-registry'

test('reports Engine capabilities from the exact current Engine registry', () => {
  const manifest: StrategyManifestIdentity = {
    schemaVersion: 'helix.strategy/v1',
    id: 'helix_swing_hunter',
    name: 'Helix Swing Hunter',
    family: 'swing',
    version: '1.0.0',
    lifecycle: 'proposal',
    objectModel: 'TRADE_THESIS',
    timeframes: [{ role: 'execution', timeframe: '15m' }],
    manifestPath: 'strategies/swing/strategy.yaml',
    configHash: `sha256:${'a'.repeat(64)}`,
    requiredEngineCapabilities: [
      'trade_thesis_v1',
      'evidence_accumulation_v1',
      'staged_execution_v1',
    ],
    capabilityConfigurations: {},
    reasonCodes: ['TEST_REASON'],
  }

  const compatibility = evaluateStrategyEngineCompatibility(manifest, 'engine-commit-001')
  assert.equal(compatibility.engineCommit, 'engine-commit-001')
  assert.equal(compatibility.compatible, false)
  assert.deepEqual(compatibility.available, ['trade_thesis_v1', 'evidence_accumulation_v1', 'staged_execution_v1'])
  assert.deepEqual(compatibility.missing, [])
  assert.deepEqual(compatibility.unconfigured, ['staged_execution_v1'])
  assert.deepEqual(compatibility.invalidConfiguration, [])
  assert.ok(listEngineCapabilities().some((capability) => capability.id === 'swing_thesis_lifecycle_v1'))
  assert.ok(listEngineCapabilities().some((capability) => capability.id === 'thesis_invalidation_v1'))
  assert.ok(listEngineCapabilities().some((capability) => capability.id === 'daily_market_context_v1'))
  assert.ok(listEngineCapabilities().some((capability) => capability.id === 'swing_location_v1'))
})

test('rejects misspelled or incomplete capability configuration', () => {
  const base: StrategyManifestIdentity = {
    schemaVersion: 'helix.strategy/v1',
    id: 'helix_scalp_hunter',
    name: 'Helix Scalp Hunter',
    family: 'scalp',
    version: '1.0.0',
    lifecycle: 'proposal',
    objectModel: 'PRICE_EVENT',
    timeframes: [{ role: 'execution', timeframe: '1m' }],
    manifestPath: 'strategies/scalp/strategy.yaml',
    configHash: `sha256:${'b'.repeat(64)}`,
    requiredEngineCapabilities: ['micro_structure_execution_v1'],
    capabilityConfigurations: { micro_structure_execution_v1: { minimum_rr: 1.5 } },
    reasonCodes: ['RR_TOO_LOW'],
  }
  const invalid = evaluateStrategyEngineCompatibility(base, 'engine-commit-001')
  assert.deepEqual(invalid.unconfigured, [])
  assert.deepEqual(invalid.invalidConfiguration, ['micro_structure_execution_v1'])

  const valid = evaluateStrategyEngineCompatibility({
    ...base,
    capabilityConfigurations: { micro_structure_execution_v1: { min_rr: 1.5 } },
  }, 'engine-commit-001')
  assert.equal(valid.compatible, true)
  assert.deepEqual(valid.invalidConfiguration, [])
})

test('requires exact configuration for all four high-level context capabilities', () => {
  const capabilityIds = new Set(listEngineCapabilities().map((capability) => capability.id))
  assert.equal(capabilityIds.has('market_regime_v1'), true)
  assert.equal(capabilityIds.has('hunting_zone_v1'), true)
  assert.equal(capabilityIds.has('daily_market_context_v1'), true)
  assert.equal(capabilityIds.has('swing_location_v1'), true)

  const manifest: StrategyManifestIdentity = {
    schemaVersion: 'helix.strategy/v1',
    id: 'helix_scalp_hunter',
    name: 'Helix Scalp Hunter',
    family: 'scalp',
    version: '1.0.1',
    lifecycle: 'proposal',
    objectModel: 'PRICE_EVENT',
    timeframes: [{ role: 'execution', timeframe: '1m' }],
    manifestPath: 'strategies/scalp/strategy.yaml',
    configHash: `sha256:${'c'.repeat(64)}`,
    requiredEngineCapabilities: ['market_regime_v1', 'hunting_zone_v1'],
    capabilityConfigurations: {
      market_regime_v1: { fast_window_bars: 10 },
      hunting_zone_v1: { lookback_bars: 80 },
    },
    reasonCodes: ['REGIME_TRENDING'],
  }
  const compatibility = evaluateStrategyEngineCompatibility(manifest, 'engine-commit-002')
  assert.deepEqual(compatibility.missing, [])
  assert.deepEqual(compatibility.unconfigured, [])
  assert.deepEqual(compatibility.invalidConfiguration, ['market_regime_v1', 'hunting_zone_v1'])
})
