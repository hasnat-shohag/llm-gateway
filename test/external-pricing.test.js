'use strict'
/**
 * external-pricing.js — the llmpricing.dev pricing layer: snapshot lookup
 * precedence, the provider-prefix handling, and its integration with
 * calculateCost. LLMPRICING_FETCH=0 keeps the lazy network resolution out of
 * the test run; it must be set before the compiled module loads.
 */
const { test } = require('node:test')
const assert = require('node:assert')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

process.env.LLMPRICING_FETCH = '0'
process.env.EXTERNAL_PRICING_CACHE_PATH = join(mkdtempSync(join(tmpdir(), 'lp-')), 'cache.json')

async function loadGatewayModule(name) {
  return import(pathToFileURL(join(__dirname, '..', 'build', 'gateway', name)).href)
}

test('external pricing prices popular non-Anthropic models at list rates', async () => {
  const { getExternalPricingInfo } = await loadGatewayModule('external-pricing.js')

  const gpt4o = getExternalPricingInfo('gpt-4o')
  assert.ok(gpt4o, 'gpt-4o is in the snapshot')
  assert.equal(gpt4o.source, 'snapshot')
  assert.equal(gpt4o.pricing.input, 2.5)
  assert.equal(gpt4o.pricing.output, 10)
  // Cached tokens bill as ordinary input at most non-Anthropic endpoints.
  assert.equal(gpt4o.pricing.cacheRead, 2.5)
  assert.equal(gpt4o.pricing.cacheWrite, 2.5)
})

test('longest prefix wins so cheaper variants are not priced at their sibling rate', async () => {
  const { getExternalPricingInfo } = await loadGatewayModule('external-pricing.js')

  // gpt-5 ($1.25/$10) would otherwise swallow gpt-5-mini ($0.25/$2).
  const mini = getExternalPricingInfo('gpt-5-mini')
  assert.ok(mini)
  assert.equal(mini.pricing.input, 0.25)
  assert.equal(mini.pricing.output, 2)

  // Dated requests resolve to the dated variant's own price.
  const dated = getExternalPricingInfo('gpt-4o-2024-05-13')
  assert.ok(dated)
  assert.equal(dated.pricing.input, 5)
  assert.equal(dated.pricing.output, 15)
})

test('provider-prefixed ids resolve against the model segment', async () => {
  const { getExternalPricingInfo } = await loadGatewayModule('external-pricing.js')

  const prefixed = getExternalPricingInfo('openai/gpt-4o')
  const bare = getExternalPricingInfo('gpt-4o')
  assert.ok(prefixed && bare)
  assert.deepEqual(prefixed.pricing, bare.pricing)

  // A dated, prefixed, differently-cased id still lands on the right entry.
  const mixed = getExternalPricingInfo('OpenAI/GPT-4O-2024-08-06')
  assert.ok(mixed)
  assert.equal(mixed.pricing.input, 2.5)
})

test('unknown models miss without side effects', async () => {
  const { getExternalPricingInfo, externalPricingStatus } = await loadGatewayModule('external-pricing.js')

  assert.equal(getExternalPricingInfo('totally-unknown-model'), null)
  // Nothing was scheduled: fetch is disabled and no pending work exists.
  const status = externalPricingStatus()
  assert.equal(status.fetchEnabled, false)
  assert.equal(status.pendingCount, 0)
})

test('calculateCost uses the tables in precedence order', async () => {
  const { calculateCost } = await loadGatewayModule('usage-tracker.js')

  const M = 1_000_000
  // Non-Anthropic model, no provider override: the external snapshot prices it.
  assert.equal(calculateCost('gpt-4o', M, M, 0, 0), 12.5)
  assert.equal(calculateCost('deepseek-chat', M, 0, 0, 0), 0.2574)

  // Provider override still wins outright.
  assert.equal(
    calculateCost('gpt-4o', M, M, 0, 0, { input: 1, output: 2 }),
    3
  )

  // Anthropic's own table wins for claude-* models — it carries cache rates
  // the external table does not, and the site may lag price changes.
  assert.equal(calculateCost('claude-sonnet-4-5', M, 0, 0, 0), 3)
  assert.equal(calculateCost('anthropic/claude-sonnet-4-5', M, 0, 0, 0), 3)
  assert.equal(calculateCost('claude-sonnet-4-5', 0, 0, M, 0), 0.3)   // cache read

  // Truly unknown models keep the Sonnet-tier fallback.
  assert.equal(calculateCost('totally-unknown-model', M, M, 0, 0), 18)
})

test('hasKnownPricing gates the zero-cost path for OpenAI-shaped streams', async () => {
  const { hasKnownPricing } = await loadGatewayModule('usage-tracker.js')

  assert.equal(hasKnownPricing('gpt-4o'), true)
  assert.equal(hasKnownPricing('openai/deepseek-chat'), true)
  assert.equal(hasKnownPricing('claude-sonnet-4-5'), true)
  assert.equal(hasKnownPricing('totally-unknown-model'), false)
  // No requested model at all — proxy.ts passes '' — must not claim knowledge.
  assert.equal(hasKnownPricing(''), false)
})

test('a refresh with network lookups disabled is an explicit no-op', async () => {
  const { refreshExternalPricing, getExternalPricingInfo } = await loadGatewayModule('external-pricing.js')

  const res = await refreshExternalPricing(['gpt-4o', 'mystery-vendor-model-x'])
  assert.equal(res.skipped, true)
  assert.deepEqual(res.refreshed, [])
  assert.deepEqual(res.failed, ['gpt-4o', 'mystery-vendor-model-x'])
  assert.equal(res.status.fetchEnabled, false)
  // A skipped refresh must not have disturbed anything the tables already knew.
  assert.equal(getExternalPricingInfo('gpt-4o').source, 'snapshot')
})

test('the generated snapshot is internally consistent', async () => {
  const data = await loadGatewayModule('external-pricing-data.js')
  const { EXTERNAL_PRICING, EXTERNAL_PRICING_COUNT, EXTERNAL_PRICING_GENERATED_AT } = data

  assert.ok(EXTERNAL_PRICING_COUNT >= 500, `snapshot shrank to ${EXTERNAL_PRICING_COUNT}`)
  assert.match(EXTERNAL_PRICING_GENERATED_AT, /^\d{4}-\d{2}-\d{2}$/)

  const seen = new Set()
  for (const [prefix, input, output] of EXTERNAL_PRICING) {
    assert.match(prefix, /^[a-z0-9][a-z0-9._-]*$/, `prefix not a lowercase model id: ${prefix}`)
    assert.ok(!prefix.includes('/'), `prefix must be the bare model segment: ${prefix}`)
    assert.ok(!seen.has(prefix), `duplicate prefix: ${prefix}`)
    seen.add(prefix)
    assert.ok(Number.isFinite(input) && input >= 0, `bad input price for ${prefix}`)
    assert.ok(Number.isFinite(output) && output >= 0, `bad output price for ${prefix}`)
  }
  assert.equal(seen.size, EXTERNAL_PRICING_COUNT)
})
