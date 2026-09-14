#!/usr/bin/env node
'use strict'
/**
 * Regenerate gateway-src/external-pricing-data.ts from https://llmpricing.dev.
 *
 * The site has no bulk API: each model page (linked from the sitemap) carries a
 * schema.org Product block with first-party USD prices per 1M input/output
 * tokens. This script fetches the sitemap, crawls every model page, and emits
 * the snapshot the gateway falls back to when it has never seen a model.
 *
 *   node scripts/update-external-pricing.js              # live crawl (~560 requests)
 *   node scripts/update-external-pricing.js --from f.jsonl  # re-emit a saved crawl
 *
 * Run it when cutting a release, or whenever prices drift — the snapshot is the
 * only pricing most models will ever hit, since the runtime fetch only covers
 * models the snapshot misses.
 */
const { writeFileSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

const SITE = 'https://llmpricing.dev'
const SITEMAP = `${SITE}/sitemap.xml`
const OUT_PATH = join(__dirname, '..', 'gateway-src', 'external-pricing-data.ts')
const CONCURRENCY = 10
const TIMEOUT_MS = 30_000
// Refuse to overwrite a good snapshot with a broken crawl.
const MIN_RECORDS = 100

// When two providers list the same model id, keep the brand owner's price
// (mistral/mistral-small-2503 over misc/mistral-small-2503, etc.).
const FIRST_PARTY = new Set([
  'ai21', 'alibaba', 'amazon', 'anthropic', 'cohere', 'deepseek', 'google',
  'meta', 'microsoft', 'minimax', 'mistral', 'moonshotai', 'nvidia', 'openai',
  'xai', 'zhipuai',
])

const UA = 'llm-gateway-desktop pricing-snapshot-generator (+https://github.com/hasnat-shohag/llm-gateway)'

async function get(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': UA },
  })
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return res.text()
}

/** Product ld+json on a model page → { sku, input, output } or null. */
function parseProduct(html) {
  for (const m of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    let d
    try {
      d = JSON.parse(m[1])
    } catch {
      continue
    }
    if (d['@type'] !== 'Product') continue
    const offers = (d.offers || {}).offers || []
    let input, output
    for (const o of offers) {
      if (o.name === 'Input tokens') input = o.price
      else if (o.name === 'Output tokens') output = o.price
    }
    if (typeof input !== 'number' || typeof output !== 'number') continue
    return { sku: d.sku, input, output }
  }
  return null
}

async function modelUrls() {
  const xml = await get(SITEMAP)
  return [...xml.matchAll(/<loc>https:\/\/llmpricing\.dev\/(m\/[^<]+?)\/<\/loc>/g)].map((m) => m[1])
}

async function crawl() {
  const urls = await modelUrls()
  process.stderr.write(`crawling ${urls.length} model pages…\n`)
  const records = []
  let done = 0
  const queue = [...urls]
  async function worker() {
    for (;;) {
      const slug = queue.shift()
      if (!slug) return
      try {
        const rec = parseProduct(await get(`${SITE}/${slug}/`))
        if (rec) records.push(rec)
      } catch (err) {
        process.stderr.write(`  skip ${slug}: ${err.message}\n`)
      }
      if (++done % 50 === 0) process.stderr.write(`  ${done}/${urls.length}\n`)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  return records
}

function fromJsonl(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map((r) => ({ sku: r.sku, input: r.input, output: r.output }))
}

/** sku "zhipuai/glm-5.2" → prefix key "glm-5.2" (the gateway matches on the model id). */
function modelPart(sku) {
  return (sku.includes('/') ? sku.slice(sku.lastIndexOf('/') + 1) : sku).toLowerCase()
}

function dedupe(records) {
  const byPart = new Map()
  for (const r of records) {
    const part = modelPart(r.sku || '')
    if (!part) continue
    const prev = byPart.get(part)
    if (!prev) {
      byPart.set(part, r)
      continue
    }
    const rank = (x) => (FIRST_PARTY.has((x.sku || '').split('/')[0]) ? 0 : 1)
    if (rank(r) < rank(prev)) byPart.set(part, r)
  }
  return [...byPart.entries()].sort((a, b) => b[0].length - a[0].length)
}

function emit(entries, fetchedOn) {
  const lines = entries
    .map(([prefix, r]) => `  ['${prefix}', ${r.input}, ${r.output}],`)
    .join('\n')
  return `// GENERATED FILE — do not edit by hand.
// Regenerate with \`npm run gen:pricing\` (see scripts/update-external-pricing.js).
//
// First-party USD list prices per 1M tokens, crawled from https://llmpricing.dev
// model pages on ${fetchedOn} (${entries.length} models). Keys are model-id
// prefixes — the model segment of the site's "provider/model" sku — and are
// consumed longest-prefix-first, so 'gpt-5-mini' wins over 'gpt-5'. Cached
// tokens bill as ordinary input at most non-Anthropic endpoints; the gateway
// applies that assumption when reading this table (external-pricing.ts).
export const EXTERNAL_PRICING_GENERATED_AT = '${fetchedOn}'
export const EXTERNAL_PRICING_COUNT = ${entries.length}

// [model prefix, input $/1M, output $/1M]
export const EXTERNAL_PRICING: ReadonlyArray<readonly [prefix: string, input: number, output: number]> = [
${lines}
]
`
}

async function main() {
  const fromIdx = process.argv.indexOf('--from')
  const records =
    fromIdx >= 0 && process.argv[fromIdx + 1]
      ? fromJsonl(process.argv[fromIdx + 1])
      : await crawl()
  const entries = dedupe(records)
  if (entries.length < MIN_RECORDS) {
    process.stderr.write(`only ${entries.length} records (< ${MIN_RECORDS}) — refusing to overwrite ${OUT_PATH}\n`)
    process.exit(1)
  }
  writeFileSync(OUT_PATH, emit(entries, new Date().toISOString().slice(0, 10)))
  process.stderr.write(`wrote ${OUT_PATH} (${entries.length} models)\n`)
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`)
  process.exit(1)
})
