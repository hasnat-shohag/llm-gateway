import 'dotenv/config'
import { createServer } from './server.js'
import { createLogger } from './logger.js'
import { HealthTracker } from './health.js'
import type { ProviderConfig } from './types.js'
import { loadEnvConfig, loadProviders, watchProviders } from './config.js'
import { UsageTracker } from './usage-tracker.js'

const config = loadEnvConfig()
const log = createLogger(config.logLevel, config.nodeEnv)

let providers: ProviderConfig[]
try {
  providers = loadProviders(config.providersPath)
} catch (err) {
  log.error({ err, path: config.providersPath }, 'failed to load providers.json')
  process.exit(1)
}
const healthTracker = new HealthTracker(config.healthFailureThreshold, config.healthCooldownMs)
const usageTracker = new UsageTracker()

const { app } = createServer(config, providers, healthTracker, usageTracker)

let closeWatcher: (() => void) | null = null

// Gracefully close the SQLite connection on exit
process.on('exit', () => usageTracker.close())
const shutdown = () => {
  closeWatcher?.()
  usageTracker.close()
  process.exit(0)
}
process.on('SIGINT',  shutdown)
process.on('SIGTERM', shutdown)

// Last-resort safety net: undici can emit HTTPParserError on stream objects
// after the response has already been sent to the client (e.g. "Invalid EOF
// state" when the upstream TLS connection drops unexpectedly).  Individual
// stream error handlers in proxy.ts should catch these first, but if one ever
// escapes we log it as a warning and keep running instead of crashing.
process.on('uncaughtException', (err: Error) => {
  const name = err.constructor?.name ?? ''
  if (name === 'HTTPParserError' || name.includes('ParseError')) {
    log.warn({ err: err.message, code: (err as any).code },
      'HTTPParserError swallowed by process-level handler — upstream connection dropped unexpectedly')
    return   // swallow — server stays up
  }
  // Anything else is a real bug; re-throw so the process exits normally.
  log.error({ err }, 'uncaught exception — shutting down')
  usageTracker.close()
  process.exit(1)
})

const watcher = watchProviders(
  config.providersPath,
  (newProviders) => {
    providers = newProviders
    ;(app as any).updateProviders(newProviders)
    log.info('providers.json hot-reloaded')
  },
  (err) => {
    // Must not be silent: without this a bad edit looks like a no-op while the
    // gateway keeps serving the previous list.
    log.error({ err, path: config.providersPath },
      'providers.json reload failed — keeping previous provider list')
  }
)
closeWatcher = watcher.close

try {
  await app.listen({ port: config.port, host: config.host })
  log.info(`LLM Gateway listening on ${config.host}:${config.port}`)
} catch (err) {
  log.error(err, 'failed to start server')
  process.exit(1)
}
