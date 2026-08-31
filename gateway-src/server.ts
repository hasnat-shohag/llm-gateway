import Fastify from 'fastify'
import type { GatewayConfig, ProviderConfig, RequestStats } from './types.js'
import { ProviderManager } from './provider-manager.js'
import { HealthTracker } from './health.js'
import { createProxyHandler } from './proxy.js'
import { createLogger } from './logger.js'
import { UsageTracker } from './usage-tracker.js'
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

  app.all('/*', createProxyHandler(providerManager, healthTracker, config, stats, usageTracker, sanitizeLearner))

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: 'not found' })
  })

  return { app, stats, log }
}
