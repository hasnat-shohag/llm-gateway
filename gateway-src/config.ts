import { readFileSync, watch, type FSWatcher } from 'fs'
import { resolve } from 'path'
import { z } from 'zod'
import type { GatewayConfig, ProviderConfig } from './types.js'

export const providerSchema = z
  .object({
    name: z.string().min(1),
    baseUrl: z.string().url(),
    /** Optional only for authStyle 'passthrough', which injects no key. */
    apiKey: z.string().min(1).optional(),
    enabled: z.boolean(),
    weight: z.number().int().positive(),
    authStyle: z.enum(['x-api-key', 'bearer', 'passthrough']).default('x-api-key'),
    /**
     * Pin the sanitize mode instead of auto-learning it. Absent = auto-learn.
     * NOTE: this field must be declared here — zod strips unknown keys, so
     * omitting it silently discarded the value and made pinning dead code.
     */
    sanitize: z.boolean().optional(),
  })
  .superRefine((p, ctx) => {
    if (p.authStyle !== 'passthrough' && !p.apiKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['apiKey'],
        message: `provider "${p.name}": apiKey is required unless authStyle is "passthrough"`,
      })
    }
  })

export const providersArraySchema = z.array(providerSchema).superRefine((providers, ctx) => {
  // Provider name is the de-facto primary key: HealthTracker, SanitizeLearner,
  // stats.perProvider and the api_calls.provider column all index by it. A
  // duplicate silently merges two providers' health and cost.
  const seen = new Map<string, number>()
  providers.forEach((p, i) => {
    const first = seen.get(p.name)
    if (first !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i, 'name'],
        message: `duplicate provider name "${p.name}" (also at index ${first})`,
      })
    } else {
      seen.set(p.name, i)
    }
  })
})

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  /** Bind loopback by default; containers override with HOST=0.0.0.0. */
  HOST: z.string().min(1).default('127.0.0.1'),
  PROVIDERS_PATH: z.string().min(1).default('providers.json'),
  STRATEGY: z.enum(['random', 'round-robin', 'weighted']).default('random'),
  /** Connect + headers timeout. Raise if providers are slow to respond. */
  REQUEST_TIMEOUT: z.coerce.number().int().positive().default(60000),
  /** Body/stream timeout. Must be long enough for large completions. */
  STREAM_TIMEOUT: z.coerce.number().int().positive().default(300000),
  HEALTH_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(3),
  HEALTH_COOLDOWN_MS: z.coerce.number().int().positive().default(60000),
  LOG_LEVEL: z.string().default('info'),
  NODE_ENV: z.enum(['development', 'production']).default('development'),
})

export function loadEnvConfig(): GatewayConfig {
  const parsed = envSchema.parse({
    PORT: process.env.PORT,
    HOST: process.env.HOST,
    PROVIDERS_PATH: process.env.PROVIDERS_PATH,
    STRATEGY: process.env.STRATEGY,
    REQUEST_TIMEOUT: process.env.REQUEST_TIMEOUT,
    STREAM_TIMEOUT: process.env.STREAM_TIMEOUT,
    HEALTH_FAILURE_THRESHOLD: process.env.HEALTH_FAILURE_THRESHOLD,
    HEALTH_COOLDOWN_MS: process.env.HEALTH_COOLDOWN_MS,
    LOG_LEVEL: process.env.LOG_LEVEL,
    NODE_ENV: process.env.NODE_ENV,
  })

  return {
    port: parsed.PORT,
    host: parsed.HOST,
    providersPath: parsed.PROVIDERS_PATH,
    strategy: parsed.STRATEGY,
    requestTimeout: parsed.REQUEST_TIMEOUT,
    streamTimeout: parsed.STREAM_TIMEOUT,
    healthFailureThreshold: parsed.HEALTH_FAILURE_THRESHOLD,
    healthCooldownMs: parsed.HEALTH_COOLDOWN_MS,
    logLevel: parsed.LOG_LEVEL,
    nodeEnv: parsed.NODE_ENV,
  }
}

export function loadProviders(filePath?: string): ProviderConfig[] {
  const path = resolve(filePath ?? 'providers.json')
  const raw = readFileSync(path, 'utf-8')
  const parsed = JSON.parse(raw)
  return providersArraySchema.parse(parsed)
}

/**
 * Watch providers.json and re-load it on change.
 *
 * Two things worth knowing, both learned the hard way:
 *  - `fs.watch` binds to the file's *inode*. An editor (or any writer) that saves
 *    atomically — temp file then rename — unlinks the watched inode, Node emits a
 *    single 'rename', and the watcher then goes permanently deaf. So 'rename' has
 *    to re-arm the watcher rather than be ignored.
 *  - A failed reload must be reported. Silently swallowing it makes a bad edit
 *    look like a no-op while the gateway keeps serving the previous list.
 */
export function watchProviders(
  filePath: string,
  onChange: (providers: ProviderConfig[]) => void,
  onError?: (err: unknown) => void
): { close: () => void } {
  const path = resolve(filePath)
  let watcher: FSWatcher | null = null
  let debounce: NodeJS.Timeout | null = null
  let rearmTimer: NodeJS.Timeout | null = null
  let closed = false

  // Editors commonly fire several events per save; coalesce them.
  const scheduleReload = () => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = null
      try {
        onChange(loadProviders(path))
      } catch (err) {
        onError?.(err)
      }
    }, 150)
  }

  const rearm = (attempt = 0) => {
    if (closed) return
    watcher?.close()
    watcher = null
    try {
      arm()
      scheduleReload()
    } catch (err) {
      // The file may not exist yet mid-rename; retry briefly before giving up.
      if (attempt < 25) {
        rearmTimer = setTimeout(() => rearm(attempt + 1), 200)
      } else {
        onError?.(err)
      }
    }
  }

  const arm = () => {
    watcher = watch(path, (eventType) => {
      if (eventType === 'rename') {
        rearm()
        return
      }
      scheduleReload()
    })
    watcher.on('error', (err) => {
      onError?.(err)
      rearm()
    })
  }

  arm()

  return {
    close: () => {
      closed = true
      if (debounce) clearTimeout(debounce)
      if (rearmTimer) clearTimeout(rearmTimer)
      watcher?.close()
      watcher = null
    },
  }
}
