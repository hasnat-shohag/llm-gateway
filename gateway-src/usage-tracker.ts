import Database from 'better-sqlite3'
import { resolve } from 'path'
import type { UsageRecord, DailySummary, ProviderDailyStats } from './types.js'

// ---------------------------------------------------------------------------
// Anthropic pricing table (USD per 1M tokens), per the official pricing model:
// https://platform.claude.com/docs/en/about-claude/pricing
//   - cacheRead  = 0.1x base input price (cache hits & refreshes)
//   - cacheWrite = 1.25x base input price (5-minute TTL cache writes, the API
//     default; 1-hour TTL writes bill at 2x base input and are not
//     distinguishable from the usage payload, so 5m rates are assumed)
// Keys are prefix-matched against the model name returned by the API —
// more specific prefixes MUST come before shorter ones.
// Update this table when Anthropic changes prices.
// ---------------------------------------------------------------------------
interface ModelPricing {
  input: number        // per 1M input tokens
  output: number       // per 1M output tokens
  cacheRead: number    // per 1M cache-read tokens
  cacheWrite: number   // per 1M cache-creation tokens (5m TTL)
}

const PRICING: Array<{ prefix: string; pricing: ModelPricing }> = [
  // Frontier tier
  { prefix: 'claude-fable-5',   pricing: { input: 10.00, output: 50.00,  cacheRead: 1.00,  cacheWrite: 12.50 } },
  { prefix: 'claude-mythos-5',  pricing: { input: 10.00, output: 50.00,  cacheRead: 1.00,  cacheWrite: 12.50 } },
  // Opus 4.5–4.8: $5 / $25
  { prefix: 'claude-opus-4-8',  pricing: { input:  5.00, output: 25.00,  cacheRead: 0.50,  cacheWrite:  6.25 } },
  { prefix: 'claude-opus-4-7',  pricing: { input:  5.00, output: 25.00,  cacheRead: 0.50,  cacheWrite:  6.25 } },
  { prefix: 'claude-opus-4-6',  pricing: { input:  5.00, output: 25.00,  cacheRead: 0.50,  cacheWrite:  6.25 } },
  { prefix: 'claude-opus-4-5',  pricing: { input:  5.00, output: 25.00,  cacheRead: 0.50,  cacheWrite:  6.25 } },
  // Opus 4.0 / 4.1 (legacy): $15 / $75 — fallback prefix must stay below the 4.5+ entries
  { prefix: 'claude-opus-4',    pricing: { input: 15.00, output: 75.00,  cacheRead: 1.50,  cacheWrite: 18.75 } },
  { prefix: 'claude-opus-3',    pricing: { input: 15.00, output: 75.00,  cacheRead: 1.50,  cacheWrite: 18.75 } },
  { prefix: 'claude-3-opus',    pricing: { input: 15.00, output: 75.00,  cacheRead: 1.50,  cacheWrite: 18.75 } },
  // Sonnet 5: introductory $2 / $10 through 2026-08-31; change to $3 / $15
  // (cacheRead 0.30, cacheWrite 3.75) starting 2026-09-01
  { prefix: 'claude-sonnet-5',  pricing: { input:  2.00, output: 10.00,  cacheRead: 0.20,  cacheWrite:  2.50 } },
  { prefix: 'claude-sonnet-4',  pricing: { input:  3.00, output: 15.00,  cacheRead: 0.30,  cacheWrite:  3.75 } },
  { prefix: 'claude-sonnet-3-5',pricing: { input:  3.00, output: 15.00,  cacheRead: 0.30,  cacheWrite:  3.75 } },
  { prefix: 'claude-3-5-sonnet',pricing: { input:  3.00, output: 15.00,  cacheRead: 0.30,  cacheWrite:  3.75 } },
  { prefix: 'claude-haiku-4-5', pricing: { input:  1.00, output:  5.00,  cacheRead: 0.10,  cacheWrite:  1.25 } },
  { prefix: 'claude-haiku-3-5', pricing: { input:  0.80, output:  4.00,  cacheRead: 0.08,  cacheWrite:  1.00 } },
  { prefix: 'claude-3-5-haiku', pricing: { input:  0.80, output:  4.00,  cacheRead: 0.08,  cacheWrite:  1.00 } },
  { prefix: 'claude-haiku-3',   pricing: { input:  0.25, output:  1.25,  cacheRead: 0.03,  cacheWrite:  0.30 } },
  { prefix: 'claude-3-haiku',   pricing: { input:  0.25, output:  1.25,  cacheRead: 0.03,  cacheWrite:  0.30 } },
]

// Unknown models fall back to Sonnet-tier standard pricing
const DEFAULT_PRICING: ModelPricing = { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 }

function getPricing(model: string): ModelPricing {
  const lower = model.toLowerCase()
  for (const entry of PRICING) {
    if (lower.startsWith(entry.prefix)) return entry.pricing
  }
  return DEFAULT_PRICING
}

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number
): number {
  const p = getPricing(model)
  const cost =
    (inputTokens      / 1_000_000) * p.input      +
    (outputTokens     / 1_000_000) * p.output      +
    (cacheReadTokens  / 1_000_000) * p.cacheRead   +
    (cacheWriteTokens / 1_000_000) * p.cacheWrite
  // Round to 8 decimal places to avoid floating-point noise
  return Math.round(cost * 1e8) / 1e8
}

// ---------------------------------------------------------------------------
// UsageTracker — SQLite-backed persistent store
// ---------------------------------------------------------------------------

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS api_calls (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp          TEXT    NOT NULL,
    date               TEXT    NOT NULL,
    provider           TEXT    NOT NULL,
    model              TEXT    NOT NULL,
    input_tokens       INTEGER NOT NULL DEFAULT 0,
    output_tokens      INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd           REAL    NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_api_calls_date ON api_calls(date);
`

export class UsageTracker {
  private db: Database.Database

  constructor(dbPath?: string) {
    const resolvedPath = resolve(dbPath ?? process.env.USAGE_DB_PATH ?? 'usage.db')
    this.db = new Database(resolvedPath)
    // WAL mode: faster writes, allows concurrent reads
    this.db.pragma('journal_mode = WAL')
    this.db.exec(CREATE_TABLE_SQL)
  }

  /** Persist a completed API call. */
  record(entry: Omit<UsageRecord, 'id'>): void {
    const stmt = this.db.prepare(`
      INSERT INTO api_calls
        (timestamp, date, provider, model, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost_usd)
      VALUES
        (@timestamp, @date, @provider, @model, @inputTokens, @outputTokens,
         @cacheReadTokens, @cacheWriteTokens, @costUsd)
    `)
    stmt.run(entry)
  }

  /** Aggregate totals for a single calendar date (default: today). */
  getDailySummary(date?: string): DailySummary {
    const targetDate = date ?? todayUTC()

    const totals = this.db.prepare(`
      SELECT
        COUNT(*)                  AS totalCalls,
        SUM(input_tokens)         AS totalInputTokens,
        SUM(output_tokens)        AS totalOutputTokens,
        SUM(cache_read_tokens)    AS totalCacheReadTokens,
        SUM(cache_write_tokens)   AS totalCacheWriteTokens,
        SUM(cost_usd)             AS totalCostUsd
      FROM api_calls
      WHERE date = ?
    `).get(targetDate) as Record<string, number>

    const byProvider = this.db.prepare(`
      SELECT
        provider,
        COUNT(*)                  AS calls,
        SUM(input_tokens)         AS inputTokens,
        SUM(output_tokens)        AS outputTokens,
        SUM(cache_read_tokens)    AS cacheReadTokens,
        SUM(cache_write_tokens)   AS cacheWriteTokens,
        SUM(cost_usd)             AS costUsd
      FROM api_calls
      WHERE date = ?
      GROUP BY provider
      ORDER BY calls DESC
    `).all(targetDate) as ProviderDailyStats[]

    return {
      date: targetDate,
      totalCalls:            totals.totalCalls            ?? 0,
      totalInputTokens:      totals.totalInputTokens      ?? 0,
      totalOutputTokens:     totals.totalOutputTokens     ?? 0,
      totalCacheReadTokens:  totals.totalCacheReadTokens  ?? 0,
      totalCacheWriteTokens: totals.totalCacheWriteTokens ?? 0,
      totalCostUsd:          round6(totals.totalCostUsd   ?? 0),
      byProvider:            byProvider.map(p => ({ ...p, costUsd: round6(p.costUsd) })),
    }
  }

  /** Most recent N calls (default 50). */
  getRecentCalls(limit = 50): UsageRecord[] {
    return this.db.prepare(`
      SELECT
        id, timestamp, date, provider, model,
        input_tokens       AS inputTokens,
        output_tokens      AS outputTokens,
        cache_read_tokens  AS cacheReadTokens,
        cache_write_tokens AS cacheWriteTokens,
        cost_usd           AS costUsd
      FROM api_calls
      ORDER BY id DESC
      LIMIT ?
    `).all(limit) as UsageRecord[]
  }

  /** Per-day totals across all recorded days (newest first). */
  getAllDays(): DailySummary[] {
    const rows = this.db.prepare(`
      SELECT
        date,
        COUNT(*)                  AS totalCalls,
        SUM(input_tokens)         AS totalInputTokens,
        SUM(output_tokens)        AS totalOutputTokens,
        SUM(cache_read_tokens)    AS totalCacheReadTokens,
        SUM(cache_write_tokens)   AS totalCacheWriteTokens,
        SUM(cost_usd)             AS totalCostUsd
      FROM api_calls
      GROUP BY date
      ORDER BY date DESC
    `).all() as Array<Omit<DailySummary, 'byProvider'>>

    return rows.map(r => ({
      ...r,
      totalCostUsd: round6(r.totalCostUsd),
      byProvider: [],   // omitted in history listing for brevity
    }))
  }

  /** Export all calls for a date as CSV rows. */
  exportCsv(date?: string): string {
    const targetDate = date ?? todayUTC()
    const rows = this.db.prepare(`
      SELECT
        id, timestamp, provider, model,
        input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, cost_usd
      FROM api_calls
      WHERE date = ?
      ORDER BY id ASC
    `).all(targetDate) as Array<Record<string, string | number>>

    const header = 'id,timestamp,provider,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd'
    const lines = rows.map(r =>
      [r.id, r.timestamp, csvEscape(String(r.provider)), csvEscape(String(r.model)),
       r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens, r.cost_usd].join(',')
    )
    return [header, ...lines].join('\n')
  }

  /**
   * Focused cost summary for a single calendar date (default: today).
   * Returns total cost + per-provider and per-model breakdowns.
   */
  getDailyCost(date?: string): {
    date: string
    totalCalls: number
    totalCostUsd: number
    byProvider: Array<{ provider: string; calls: number; costUsd: number }>
    byModel: Array<{ model: string; provider: string; calls: number; costUsd: number }>
  } {
    const targetDate = date ?? todayUTC()

    const totals = this.db.prepare(`
      SELECT
        COUNT(*)      AS totalCalls,
        SUM(cost_usd) AS totalCostUsd
      FROM api_calls
      WHERE date = ?
    `).get(targetDate) as Record<string, number>

    const byProvider = this.db.prepare(`
      SELECT
        provider,
        COUNT(*)      AS calls,
        SUM(cost_usd) AS costUsd
      FROM api_calls
      WHERE date = ?
      GROUP BY provider
      ORDER BY costUsd DESC
    `).all(targetDate) as Array<{ provider: string; calls: number; costUsd: number }>

    const byModel = this.db.prepare(`
      SELECT
        model,
        provider,
        COUNT(*)      AS calls,
        SUM(cost_usd) AS costUsd
      FROM api_calls
      WHERE date = ?
      GROUP BY model, provider
      ORDER BY costUsd DESC
    `).all(targetDate) as Array<{ model: string; provider: string; calls: number; costUsd: number }>

    return {
      date: targetDate,
      totalCalls:    totals.totalCalls    ?? 0,
      totalCostUsd:  round6(totals.totalCostUsd ?? 0),
      byProvider:    byProvider.map(p => ({ ...p, costUsd: round6(p.costUsd) })),
      byModel:       byModel.map(m => ({ ...m, costUsd: round6(m.costUsd) })),
    }
  }

  close(): void {
    this.db.close()
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10)
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

function csvEscape(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}
