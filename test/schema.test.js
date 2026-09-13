'use strict'
/**
 * schema.js — the app's validation layer, which is the gateway's own zod schema
 * loaded out of build/gateway. Requires `npm run build:gateway` to have run.
 */
require('./helpers/electron-stub.js').install()

const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  validateProviders,
  serializeProviders,
  normalizeBaseUrl,
  PROVIDER_KEY_ORDER,
  AUTH_STYLES,
  PROVIDER_COMPATIBILITIES,
} = require('../main/schema.js')

const base = { name: 'p1', baseUrl: 'https://api.example.com', apiKey: 'k'.repeat(20), enabled: true, weight: 1 }

test('normalizeBaseUrl strips trailing slashes and surrounding space', () => {
  assert.equal(normalizeBaseUrl('  https://api.example.com///  '), 'https://api.example.com')
  assert.equal(normalizeBaseUrl('https://api.example.com'), 'https://api.example.com')
  // Non-strings pass through so zod produces the type error, not this helper.
  assert.equal(normalizeBaseUrl(undefined), undefined)
})

test('validateProviders applies the gateway defaults', async () => {
  const result = await validateProviders([base])
  assert.equal(result.ok, true)
  assert.equal(result.providers[0].authStyle, 'x-api-key')
  assert.equal(result.providers[0].compatibility, 'claude')
  assert.equal(result.providers[0].sanitize, undefined)
})

test('validateProviders keeps a pinned sanitize value', async () => {
  for (const pinned of [true, false]) {
    const result = await validateProviders([{ ...base, sanitize: pinned }])
    assert.equal(result.ok, true)
    assert.equal(result.providers[0].sanitize, pinned)
  }
})

test('validateProviders requires apiKey unless authStyle is passthrough', async () => {
  const missing = await validateProviders([{ ...base, apiKey: undefined }])
  assert.equal(missing.ok, false)
  assert.match(missing.error, /apiKey is required/)

  const passthrough = await validateProviders([
    { name: 'official', baseUrl: 'https://api.anthropic.com', enabled: true, weight: 1, authStyle: 'passthrough' },
  ])
  assert.equal(passthrough.ok, true)
})

test('validateProviders accepts each compatibility and constrains passthrough', async () => {
  for (const compatibility of PROVIDER_COMPATIBILITIES) {
    // A translated provider needs an OpenAI-shaped credential: `x-api-key` is an
    // Anthropic header, and the schema rejects the pair rather than letting every
    // request 401 with nothing in the config to point at.
    const authStyle = compatibility === 'openai' ? 'bearer' : base.authStyle
    const result = await validateProviders([{ ...base, compatibility, authStyle }])
    assert.equal(result.ok, true)
    assert.equal(result.providers[0].compatibility, compatibility)
  }

  const passthrough = await validateProviders([
    {
      name: 'official',
      baseUrl: 'https://api.anthropic.com',
      enabled: true,
      weight: 1,
      authStyle: 'passthrough',
      compatibility: 'openai',
    },
  ])
  assert.equal(passthrough.ok, false)
  assert.match(passthrough.error, /passthrough must use compatibility "claude"/)
})

test('validateProviders rejects an Anthropic credential on a translated provider', async () => {
  const result = await validateProviders([{ ...base, compatibility: 'openai' }])
  assert.equal(result.ok, false)
  assert.match(result.error, /compatibility "openai" needs authStyle "bearer"/)
})

test('validateProviders accepts the Azure api-key credential and the openai dialect block', async () => {
  const result = await validateProviders([
    {
      ...base,
      baseUrl: 'https://r.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21',
      compatibility: 'openai',
      authStyle: 'api-key',
      openai: { maxTokensField: 'max_tokens', reasoningEffort: 'high' },
    },
  ])
  assert.equal(result.ok, true)
  assert.equal(result.providers[0].openai.maxTokensField, 'max_tokens')
  assert.equal(result.providers[0].openai.reasoningEffort, 'high')
})

test('validateProviders applies the openai dialect defaults', async () => {
  const result = await validateProviders([{ ...base, compatibility: 'openai', authStyle: 'bearer', openai: {} }])
  assert.equal(result.ok, true)
  assert.equal(result.providers[0].openai.maxTokensField, 'max_completion_tokens')
  assert.equal(result.providers[0].openai.reasoningEffort, undefined)
})

test('validateProviders accepts partial, empty and absent pricing', async () => {
  const cases = [
    [undefined, undefined],
    [{}, undefined],
    // Every price is optional on purpose: an unknown number is better left blank
    // than guessed, and the gateway treats a missing field as no cost at all.
    [{ input: 1.5 }, undefined],
    [{ output: 2 }, undefined],
    [{ input: 1.5, output: 2, cacheRead: 0.15, cacheWrite: 1.9 }, undefined],
  ]
  for (const [pricing, expected] of cases) {
    const result = await validateProviders([{ ...base, pricing }])
    assert.equal(result.ok, true)
    assert.deepEqual(result.providers[0].pricing, expected ?? pricing)
  }

  const negative = await validateProviders([{ ...base, pricing: { input: -1 } }])
  assert.equal(negative.ok, false)
})

test('validateProviders rejects duplicate names with a row-addressed issue', async () => {
  const result = await validateProviders([base, { ...base, apiKey: 'other-key-value-here' }])
  assert.equal(result.ok, false)
  assert.match(result.error, /duplicate provider name "p1"/)
  // The renderer points at a row using this path, so its shape is load-bearing.
  assert.deepEqual(result.issues.map((i) => i.path), ['1.name'])
})

test('validateProviders rejects a non-URL baseUrl and a zero weight', async () => {
  const badUrl = await validateProviders([{ ...base, baseUrl: 'api.example.com' }])
  assert.equal(badUrl.ok, false)
  assert.deepEqual(badUrl.issues.map((i) => i.path), ['0.baseUrl'])

  const badWeight = await validateProviders([{ ...base, weight: 0 }])
  assert.equal(badWeight.ok, false)
  assert.deepEqual(badWeight.issues.map((i) => i.path), ['0.weight'])
})

test('validateProviders strips keys the gateway does not know', async () => {
  const result = await validateProviders([{ ...base, originalName: 'p0', nonsense: 1 }])
  assert.equal(result.ok, true)
  assert.equal('originalName' in result.providers[0], false)
  assert.equal('nonsense' in result.providers[0], false)
})

test('serializeProviders writes canonical key order, no nulls, trailing newline', () => {
  const text = serializeProviders([
    {
      weight: 2,
      enabled: false,
      name: 'p1',
      authStyle: 'bearer',
      compatibility: 'both',
      baseUrl: 'https://x',
      apiKey: 'k',
      sanitize: null,
    },
  ])
  assert.ok(text.endsWith('}\n]\n'))

  const parsed = JSON.parse(text)
  assert.deepEqual(Object.keys(parsed[0]), ['name', 'baseUrl', 'apiKey', 'enabled', 'weight', 'authStyle', 'compatibility'])
  assert.equal(PROVIDER_KEY_ORDER.includes('sanitize'), true)
  // A field missing from this list never reaches providers.json, silently.
  assert.equal(PROVIDER_KEY_ORDER.includes('openai'), true)
  assert.equal(PROVIDER_KEY_ORDER.includes('pricing'), true)
  assert.equal('sanitize' in parsed[0], false)
})

test('serialized output round-trips back through validation', async () => {
  const text = serializeProviders([base])
  const result = await validateProviders(JSON.parse(text))
  assert.equal(result.ok, true)
})

test('AUTH_STYLES matches what the gateway accepts', async () => {
  for (const authStyle of AUTH_STYLES) {
    const provider = authStyle === 'passthrough' ? { ...base, apiKey: undefined, authStyle } : { ...base, authStyle }
    const result = await validateProviders([provider])
    assert.equal(result.ok, true, `${authStyle} should validate`)
  }
})
