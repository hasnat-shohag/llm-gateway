'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

async function loadGatewayModule(name) {
  return import(pathToFileURL(join(__dirname, '..', 'build', 'gateway', name)).href)
}

test('provider selection is partitioned by request compatibility', async () => {
  const { ProviderManager } = await loadGatewayModule('provider-manager.js')
  const { HealthTracker } = await loadGatewayModule('health.js')

  const providers = [
    { name: 'openai-only', baseUrl: 'https://openai.example.com', apiKey: 'k', enabled: true, weight: 1, compatibility: 'openai' },
    { name: 'claude-only', baseUrl: 'https://claude.example.com', apiKey: 'k', enabled: true, weight: 1, compatibility: 'claude' },
    { name: 'dual', baseUrl: 'https://dual.example.com', apiKey: 'k', enabled: true, weight: 1, compatibility: 'both' },
  ]
  const manager = new ProviderManager(providers, new HealthTracker(3, 1000), 'round-robin')

  assert.equal(manager.providerCount(), 3)
  assert.equal(manager.providerCount('openai'), 2)
  assert.equal(manager.providerCount('claude'), 2)

  for (let index = 0; index < 10; index++) {
    const openai = manager.selectExcluding(new Set(), 'openai')
    const claude = manager.selectExcluding(new Set(), 'claude')
    assert.ok(['openai-only', 'dual'].includes(openai.name))
    assert.ok(['claude-only', 'dual'].includes(claude.name))
  }
})

test('request compatibility uses path first and model as fallback', async () => {
  const { resolveRequestCompatibility } = await loadGatewayModule('proxy.js')

  assert.equal(resolveRequestCompatibility({
    url: '/v1/chat/completions?stream=true',
    headers: {},
    body: { model: 'claude-sonnet-4-5' },
  }), 'openai')

  assert.equal(resolveRequestCompatibility({
    url: '/v1/messages',
    headers: {},
    body: { model: 'gpt-4o' },
  }), 'claude')

  assert.equal(resolveRequestCompatibility({
    url: '/custom/endpoint',
    headers: {},
    body: { model: 'claude-sonnet-4-5' },
  }), 'claude')

  assert.equal(resolveRequestCompatibility({
    url: '/custom/endpoint',
    headers: {},
    body: { model: 'gpt-4o' },
  }), 'openai')

  assert.equal(resolveRequestCompatibility({
    url: '/custom/endpoint',
    headers: {},
    body: {},
  }), null)
})

test('target URL avoids duplicating a version path', async () => {
  const { buildTargetUrl } = await loadGatewayModule('proxy.js')

  assert.equal(
    buildTargetUrl('https://provider.example.com/v1', '/v1/chat/completions?stream=true'),
    'https://provider.example.com/v1/chat/completions?stream=true'
  )
  assert.equal(
    buildTargetUrl('https://provider.example.com', '/v1/messages'),
    'https://provider.example.com/v1/messages'
  )
})

test('the preferred pool follows the model family, not the client path', async () => {
  const { resolvePreferredPool } = await loadGatewayModule('proxy.js')

  assert.equal(resolvePreferredPool('gpt-5.6'), 'openai')
  assert.equal(resolvePreferredPool('gpt-4o-mini'), 'openai')
  assert.equal(resolvePreferredPool('glm-4.6'), 'openai')
  assert.equal(resolvePreferredPool('deepseek-chat'), 'openai')
  assert.equal(resolvePreferredPool('claude-sonnet-4-5'), 'claude')
  // OpenRouter namespaces its Anthropic entries, so a prefixed id is still Claude.
  assert.equal(resolvePreferredPool('anthropic/claude-sonnet-4.5'), 'claude')
  // No model at all keeps the historical path decision.
  assert.equal(resolvePreferredPool(undefined), 'claude')
  assert.equal(resolvePreferredPool(''), 'claude')
})

test('attempt phases put a relay before a translation, and the Claude pool last', async () => {
  const { resolveAttemptPhases } = await loadGatewayModule('proxy.js')

  const labels = (compatibility, model) =>
    resolveAttemptPhases(compatibility, model).map((phase) => phase.label)

  // Claude Code asking for an OpenAI model: both (relay) → openai (translated) →
  // claude (the fallback that keeps an Anthropic-shaped GLM/Kimi proxy working).
  assert.deepEqual(labels('claude', 'gpt-5.6'), [
    'both (relay)',
    'openai (translated)',
    'claude (fallback relay)',
  ])

  // A Claude model on a Claude path is unchanged from before this existed.
  assert.deepEqual(labels('claude', 'claude-sonnet-4-5'), ['claude'])

  // An OpenAI-shaped client keeps today's single pool.
  assert.deepEqual(labels('openai', 'claude-sonnet-4-5'), ['openai'])
  assert.deepEqual(labels('openai', 'gpt-5.6'), ['openai'])
})

test('phase predicates partition providers by declared compatibility', async () => {
  const { resolveAttemptPhases } = await loadGatewayModule('proxy.js')

  const providers = [
    { name: 'openai-only', compatibility: 'openai' },
    { name: 'claude-only', compatibility: 'claude' },
    { name: 'dual', compatibility: 'both' },
    { name: 'legacy' },
  ]
  const names = (phase) => providers.filter(phase.match).map((p) => p.name)

  const [relay, translated, fallback] = resolveAttemptPhases('claude', 'gpt-5.6')
  // `both` relays verbatim; only an `openai` provider pays for translation; the
  // fallback matches the Claude pool including a legacy provider with no field.
  assert.deepEqual(names(relay), ['dual'])
  assert.deepEqual(names(translated), ['openai-only'])
  assert.deepEqual(names(fallback), ['claude-only', 'legacy'])

  const [openaiPool] = resolveAttemptPhases('openai', 'gpt-5.6')
  assert.deepEqual(names(openaiPool), ['openai-only', 'dual'])

  const [claudePool] = resolveAttemptPhases('claude', 'claude-sonnet-4-5')
  assert.deepEqual(names(claudePool), ['claude-only', 'dual', 'legacy'])
})

test('phase order is what the failover loop walks, and a pool can be skipped', async () => {
  const { resolveAttemptPhases } = await loadGatewayModule('proxy.js')
  const { ProviderManager } = await loadGatewayModule('provider-manager.js')
  const { HealthTracker } = await loadGatewayModule('health.js')

  const providers = [
    { name: 'dual', baseUrl: 'https://dual.example.com', apiKey: 'k', enabled: true, weight: 1, compatibility: 'both' },
    { name: 'translated', baseUrl: 'https://oa.example.com', apiKey: 'k', enabled: true, weight: 1, compatibility: 'openai' },
    { name: 'claude-only', baseUrl: 'https://claude.example.com', apiKey: 'k', enabled: true, weight: 1, compatibility: 'claude' },
  ]
  const manager = new ProviderManager(providers, new HealthTracker(3, 1000), 'round-robin')

  const attempted = new Set()
  const walked = []
  for (const phase of resolveAttemptPhases('claude', 'gpt-5.6')) {
    while (true) {
      const provider = manager.selectMatching(attempted, phase.match)
      if (!provider) break
      attempted.add(provider.name)
      walked.push(provider.name)
    }
  }
  assert.deepEqual(walked, ['dual', 'translated', 'claude-only'])

  // A pool with no enabled provider contributes nothing and the next phase is
  // reached without an upstream attempt.
  const onlyClaude = new ProviderManager([providers[2]], new HealthTracker(3, 1000), 'round-robin')
  assert.equal(onlyClaude.countMatching(resolveAttemptPhases('claude', 'gpt-5.6')[0].match), 0)
  assert.equal(onlyClaude.countMatching(resolveAttemptPhases('claude', 'gpt-5.6')[2].match), 1)
})
