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
    { weight: 2, enabled: false, name: 'p1', authStyle: 'bearer', baseUrl: 'https://x', apiKey: 'k', sanitize: null },
  ])
  assert.ok(text.endsWith('}\n]\n'))

  const parsed = JSON.parse(text)
  assert.deepEqual(Object.keys(parsed[0]), ['name', 'baseUrl', 'apiKey', 'enabled', 'weight', 'authStyle'])
  assert.equal(PROVIDER_KEY_ORDER.includes('sanitize'), true)
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
