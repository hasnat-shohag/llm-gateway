import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  EXTERNAL_PRICING,
  EXTERNAL_PRICING_COUNT,
  EXTERNAL_PRICING_GENERATED_AT,
} from './external-pricing-data.js'

// ---------------------------------------------------------------------------
// Non-Anthropic model pricing, sourced from https://llmpricing.dev.
//
// The Anthropic table in usage-tracker.ts only knows Anthropic's models, and
// its fallback is Sonnet-tier — badly wrong for the cheap open models routed
// through OpenAI-compatible providers. This module supplies prices for those:
//
//   1. A generated snapshot (external-pricing-data.ts), refreshed with
//      `npm run gen:pricing` — first-party USD list prices per 1M tokens.
//   2. A lazy per-model fetch: the first time a model misses the snapshot, the
//      sitemap is fetched (once per run) to locate the model's page, that one
//      page is fetched, and the price is cached to disk beside usage.db so
//      later runs need no network at all.
//
// The site lists input/output prices only. Cached prompt tokens bill as
// ordinary input at most non-Anthropic endpoints — the same assumption
// ProviderPricing.cacheRead documents — so cacheRead and cacheWrite both
// default to the input price.
//
// Lookup never blocks: a miss returns null (the caller falls back) and the
// resolution lands in the background, priced from the next call onward.
// ---------------------------------------------------------------------------

export interface ExternalModelPricing {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

const SITE = 'https://llmpricing.dev'
const SITEMAP_URL = `${SITE}/sitemap.xml`
const FETCH_TIMEOUT_MS = 10_000
// Tests disable the network path with this; production never sets it.
const fetchEnabled = process.env.LLMPRICING_FETCH !== '0'

const USER_AGENT =
  'llm-gateway-desktop (+https://github.com/hasnat-shohag/llm-gateway)'

/** Cache file for lazily resolved prices, beside usage.db by default. */
function cachePath(): string {
  if (process.env.EXTERNAL_PRICING_CACHE_PATH) {
    return resolve(process.env.EXTERNAL_PRICING_CACHE_PATH)
  }
  const db = resolve(process.env.USAGE_DB_PATH ?? 'usage.db')
  return join(dirname(db), 'external-pricing.json')
}

interface Entry {
  prefix: string
  pricing: ExternalModelPricing
}

/** Snapshot entries, longest prefix first: 'gpt-5-mini' must outrank 'gpt-5'. */
const snapshot: Entry[] = (EXTERNAL_PRICING as ReadonlyArray<readonly [string, number, number]>)
  .map(([prefix, input, output]) => ({
    prefix,
    pricing: { input, output, cacheRead: input, cacheWrite: input },
  }))
  .sort((a, b) => b.prefix.length - a.prefix.length)

/** Prices resolved at runtime (disk cache + live fetches), checked first. */
const resolved = new Map<string, ExternalModelPricing>()

const pending = new Set<string>()      // resolution in flight
const unresolved = new Set<string>()   // gave up this run; a later run retries
let sitemapSlugs: string[] | null = null   // null until fetched (or failed) this run

/** "openai/gpt-5" → "gpt-5"; unknown providers sit in front of the model id. */
function modelKey(model: string): string {
  const lower = model.toLowerCase()
  const slash = lower.lastIndexOf('/')
  return slash >= 0 ? lower.slice(slash + 1) : lower
}

loadDiskCache()

function loadDiskCache(): void {
  try {
    const raw = readFileSync(cachePath(), 'utf8')
    const data = JSON.parse(raw) as { entries?: Record<string, { input: number; output: number }> }
    for (const [prefix, p] of Object.entries(data.entries ?? {})) {
      if (typeof p?.input !== 'number' || typeof p?.output !== 'number') continue
      resolved.set(prefix.toLowerCase(), {
        input: p.input,
        output: p.output,
        cacheRead: p.input,
        cacheWrite: p.input,
      })
    }
  } catch {
    // Absent or corrupt cache — the snapshot still covers us.
  }
}

function persistResolved(): void {
  const entries: Record<string, { input: number; output: number }> = {}
  for (const [prefix, p] of resolved) entries[prefix] = { input: p.input, output: p.output }
  try {
    const target = cachePath()
    writeFileSync(target, JSON.stringify({ version: 1, entries }, null, 2))
  } catch (err) {
    console.warn(`external-pricing: failed to persist ${cachePath()}: ${err}`)
  }
}

export interface ExternalPricingHit {
  pricing: ExternalModelPricing
  source: 'snapshot' | 'resolved'
}

/** Pure lookup — no side effects, no network. */
export function getExternalPricingInfo(model: string): ExternalPricingHit | null {
  const key = modelKey(model)
  // Resolved entries are exact matches for models the snapshot missed, so they
  // outrank snapshot prefixes even when both could match.
  for (const [prefix, pricing] of resolved) {
    if (key.startsWith(prefix)) return { pricing, source: 'resolved' }
  }
  for (const entry of snapshot) {
    if (key.startsWith(entry.prefix)) return { pricing: entry.pricing, source: 'snapshot' }
  }
  return null
}

/** Lookup that also schedules a background resolution on a miss. */
export function getExternalPricing(model: string): ExternalModelPricing | null {
  const hit = getExternalPricingInfo(model)
  if (hit) return hit.pricing
  scheduleResolution(modelKey(model))
  return null
}

function scheduleResolution(model: string): void {
  if (!fetchEnabled || !model || model === 'unknown' || pending.has(model) || unresolved.has(model)) {
    return
  }
  pending.add(model)
  resolveModel(model)
    .catch((err) => {
      // Offline, or the model simply isn't listed. Only a warning: the caller
      // already recorded the call with fallback pricing.
      console.warn(`external-pricing: no price for '${model}' (${err})`)
      unresolved.add(model)
    })
    .finally(() => pending.delete(model))
}

async function resolveModel(model: string): Promise<void> {
  const slugs = await loadSitemap()
  // Sitemap slugs look like 'm/<provider>/<model>'; the model segment is what
  // matches the requested id. Pick the page in priority order: an exact id, a
  // base-model page for a dated request ('…-20250219' → '…'), then the closest
  // variant for an undated one. A plain length sort is wrong here — 'gpt-4o'
  // would otherwise resolve to 'gpt-4o-mini-transcribe' purely by being longer.
  const parts = slugs
    .map((slug) => slug.slice(slug.lastIndexOf('/') + 1).toLowerCase())
    .filter((part) => part && (part === model || model.startsWith(part) || part.startsWith(model)))
  const best =
    parts.find((part) => part === model) ??
    parts.filter((part) => model.startsWith(part)).sort((a, b) => b.length - a.length)[0] ??
    parts.filter((part) => part.startsWith(model)).sort((a, b) => a.length - b.length)[0]
  if (!best) throw new Error('not in sitemap')

  const slug = slugs.find((s) => s.toLowerCase().endsWith(`/${best}`))
  if (!slug) throw new Error('slug disappeared')

  const res = await fetch(`${SITE}/${slug}/`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': USER_AGENT },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const html = await res.text()

  const rec = parseProduct(html)
  if (!rec) throw new Error('no Product pricing on page')

  // Store the shorter of the two ids: it still matches this request and also
  // covers sibling variants ("gpt-5-turbo-2026" resolving page 'gpt-5-turbo').
  const prefix = model.length <= rec.part.length ? model : rec.part
  resolved.set(prefix, {
    input: rec.input,
    output: rec.output,
    cacheRead: rec.input,
    cacheWrite: rec.input,
  })
  persistResolved()
}

export interface ExternalPricingRefresh {
  refreshed: string[]
  failed: string[]
  /** True when LLMPRICING_FETCH=0 turned the whole refresh into a no-op. */
  skipped: boolean
  status: ReturnType<typeof externalPricingStatus>
}

/**
 * Re-check models against the live site, bypassing every per-run cache.
 *
 * The runtime half of price-update detection: the lazy path only ever fires on
 * a miss, so a price that changed for a model the gateway already knows would
 * stick until the next release ships a new snapshot. A refresh fetches the
 * sitemap anew (pages added since boot must be discoverable), drops the
 * resolved entries that would shadow each model, and re-resolves it. The fresh
 * entry lands in `resolved`, which outranks the snapshot, so the new price
 * applies from the next recorded call. Each model succeeds or fails on its own
 * — one unlisted model must not sink the rest — and a failed refresh restores
 * the price it displaced rather than leaving the model unpriced.
 */
export async function refreshExternalPricing(models: readonly string[]): Promise<ExternalPricingRefresh> {
  if (!fetchEnabled) {
    return { refreshed: [], failed: [...models], skipped: true, status: externalPricingStatus() }
  }
  sitemapSlugs = null
  unresolved.clear()
  const refreshed: string[] = []
  const failed: string[] = []
  const seen = new Set<string>()
  for (const model of models) {
    const key = modelKey(model)
    if (!key || key === 'unknown' || seen.has(key)) continue
    seen.add(key)
    const shadowed = [...resolved.entries()].filter(([prefix]) => key.startsWith(prefix))
    for (const [prefix] of shadowed) resolved.delete(prefix)
    try {
      await resolveModel(key)
      refreshed.push(model)
    } catch (err) {
      console.warn(`external-pricing: refresh failed for '${key}' (${err})`)
      for (const [prefix, pricing] of shadowed) resolved.set(prefix, pricing)
      unresolved.add(key)
      failed.push(model)
    }
  }
  return { refreshed, failed, skipped: false, status: externalPricingStatus() }
}

/** sitemap model slugs, fetched at most once per run. */
async function loadSitemap(): Promise<string[]> {
  if (sitemapSlugs) return sitemapSlugs
  const res = await fetch(SITEMAP_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': USER_AGENT },
  })
  if (!res.ok) throw new Error(`sitemap HTTP ${res.status}`)
  const xml = await res.text()
  const slugs = [...xml.matchAll(/<loc>https:\/\/llmpricing\.dev\/(m\/[^<]+?)\/<\/loc>/g)].map((m) => m[1])
  if (slugs.length === 0) throw new Error('sitemap listed no models')
  sitemapSlugs = slugs
  return slugs
}

function parseProduct(html: string): { part: string; input: number; output: number } | null {
  for (const m of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    let d: {
      '@type'?: string
      sku?: string
      offers?: { offers?: Array<{ name?: string; price?: number }> }
    }
    try {
      d = JSON.parse(m[1])
    } catch {
      continue
    }
    if (d['@type'] !== 'Product') continue
    let input: number | undefined
    let output: number | undefined
    for (const o of d.offers?.offers ?? []) {
      if (o.name === 'Input tokens') input = o.price
      else if (o.name === 'Output tokens') output = o.price
    }
    if (typeof input !== 'number' || typeof output !== 'number') continue
    const sku = d.sku ?? ''
    const part = (sku.includes('/') ? sku.slice(sku.lastIndexOf('/') + 1) : sku).toLowerCase()
    if (!part) continue
    return { part, input, output }
  }
  return null
}

/** Status for GET /pricing — how the table is doing, not the table itself. */
export function externalPricingStatus() {
  return {
    generatedAt: EXTERNAL_PRICING_GENERATED_AT,
    snapshotCount: EXTERNAL_PRICING_COUNT,
    resolvedCount: resolved.size,
    pendingCount: pending.size,
    unresolvedCount: unresolved.size,
    sitemapFetched: sitemapSlugs !== null,
    fetchEnabled,
  }
}
