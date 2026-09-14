import Fastify from 'fastify'
import type { GatewayConfig, ProviderConfig, RequestStats } from './types.js'
import { ProviderManager } from './provider-manager.js'
import { HealthTracker } from './health.js'
import { createProxyHandler } from './proxy.js'
import { createLogger } from './logger.js'
import { UsageTracker, getPricing } from './usage-tracker.js'
import { externalPricingStatus, getExternalPricingInfo, refreshExternalPricing } from './external-pricing.js'
import { SanitizeLearner } from './sanitize-learner.js'
import { RollingLatency } from './metrics.js'

export function createServer(
  config: GatewayConfig,
  providers: ProviderConfig[],
  healthTracker: HealthTracker,
  usageTracker: UsageTracker
) {
  const log = createLogger(config.logLevel, config.nodeEnv)
  const providerManager = new ProviderManager(providers, healthTracker, config.strategy)
  const sanitizeLearner = new SanitizeLearner()

  const stats: RequestStats = {
    total: 0,
    perProvider: {},
    retries: 0,
    latencies: new RollingLatency(1024),
  }

  const app = Fastify({
    logger: false,
  })

  // Single path for adopting a new provider list, used at boot and by the
  // providers.json watcher. Pins have to be re-synced on every reload: pinning
  // only at construction meant a hot reload never re-pinned, and removing
  // `sanitize` from the file left a stale pin in place forever.
  const applyProviders = (next: ProviderConfig[]) => {
    providerManager.updateProviders(next)
    sanitizeLearner.syncPins(next)
  }
  applyProviders(providers)

  ;(app.decorate as unknown as (name: string, value: unknown) => void)(
    'updateProviders',
    applyProviders
  )

  // Claude Code probes `HEAD /` at startup to test connectivity. Answer it
  // locally (Fastify auto-exposes HEAD for GET routes) — proxying the probe to
  // providers returns their Cloudflare error pages (305/403), which the client
  // can't parse and surfaces as "API Error: Failed to parse JSON".
  app.get('/', async () => {
    return { status: 'ok' }
  })

  app.get('/health', async () => {
    return { status: 'ok' }
  })

  app.get('/stats', async () => {
    const allNames = providerManager.getAllProviders().map((p) => p.name)

    return {
      totalRequests: stats.total,
      providerUsage: stats.perProvider,
      retries: stats.retries,
      // Mean over the most recent 1024 requests, not the process lifetime.
      averageLatency: Math.round(stats.latencies.mean()),
      latency: {
        count: stats.latencies.count,
        mean: Math.round(stats.latencies.mean()),
        p50: Math.round(stats.latencies.percentile(50)),
        p95: Math.round(stats.latencies.percentile(95)),
      },
      unhealthyProviders: healthTracker.getUnhealthy(),
      health: healthTracker.snapshot(allNames),
      sanitizeModes: sanitizeLearner.snapshot(),
      sanitize: sanitizeLearner.detail(),
      strategy: providerManager.getStrategy(),
      providerCount: allNames.length,
      enabledCount: providerManager.providerCount(),
    }
  })

  app.get('/providers', async () => {
    return providerManager.getProviderNames()
  })

  // -------------------------------------------------------------------------
  // Usage / token tracking endpoints
  // -------------------------------------------------------------------------

  app.get('/usage', async (req) => {
    const date = (req.query as Record<string, string | undefined>).date
    const limit = Number((req.query as Record<string, string | undefined>).limit ?? 50)
    return {
      today:       usageTracker.getDailySummary(date),
      recentCalls: usageTracker.getRecentCalls(limit),
      history:     usageTracker.getAllDays(),
    }
  })

  app.get('/usage/export', async (req, reply) => {
    const date = (req.query as Record<string, string | undefined>).date
    const targetDate = date ?? new Date().toISOString().slice(0, 10)
    const csv = usageTracker.exportCsv(targetDate)
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="usage-${targetDate}.csv"`)
    return reply.send(csv)
  })

  /**
   * GET /usage/cost            → cost for today
   * GET /usage/cost?date=YYYY-MM-DD → cost for a specific date
   * GET /usage/cost/YYYY-MM-DD → cost for a specific date (path-param style)
   */
  app.get('/usage/cost', async (req) => {
    const date = (req.query as Record<string, string | undefined>).date
    return usageTracker.getDailyCost(date)
  })

  app.get<{ Params: { date: string } }>('/usage/cost/:date', async (req) => {
    return usageTracker.getDailyCost(req.params.date)
  })

  // -------------------------------------------------------------------------
  // Pricing — read-only visibility into the tables behind cost calculations.
  // ?model= reports the effective price a call with that model would record.
  // -------------------------------------------------------------------------

  app.get('/pricing', async (req) => {
    const model = (req.query as Record<string, string | undefined>).model
    if (model) {
      return {
        model,
        effective: getPricing(model),
        external: getExternalPricingInfo(model),
        status: externalPricingStatus(),
      }
    }
    return { status: externalPricingStatus() }
  })

  /**
   * POST /pricing/refresh  { models: string[] }
   *
   * Re-checks the given models against llmpricing.dev, bypassing every cache.
   * The desktop app sends the distinct models seen in usage; a fresh result
   * outranks the bundled snapshot, so a changed price applies from the next
   * recorded call without a gateway restart. Capped because each model is a
   * live page fetch, sequentially.
   */
  app.post('/pricing/refresh', async (req) => {
    const body = (req.body ?? {}) as { models?: unknown }
    const models = Array.isArray(body.models)
      ? body.models.filter((m): m is string => typeof m === 'string' && m.length > 0).slice(0, 100)
      : []
    return refreshExternalPricing(models)
  })

  app.all('/*', createProxyHandler(providerManager, healthTracker, config, stats, usageTracker, sanitizeLearner))

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: 'not found' })
  })

  return { app, stats, log }
}
