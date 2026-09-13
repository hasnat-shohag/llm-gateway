import type { RollingLatency } from './metrics.js'

/** How the gateway injects the API key into upstream requests.
 * - `x-api-key`   (default) — standard Anthropic SDK header
 * - `bearer`      — Authorization: Bearer <key>  (required by AgentRouter)
 * - `api-key`     — `api-key: <key>`, which is how Azure OpenAI authenticates
 * - `passthrough` — inject nothing; forward the CLIENT's own Authorization
 *   header untouched. This is how the user's official Claude subscription is
 *   used as a provider: Claude Code attaches its own subscription credential
 *   (and the OAuth capability in `anthropic-beta`), and the gateway relays both
 *   to api.anthropic.com unchanged. The gateway never reads, stores, or
 *   refreshes that credential — Claude Code owns its whole lifecycle.
 */
export type AuthStyle = 'x-api-key' | 'bearer' | 'api-key' | 'passthrough'

/** API request shapes a provider accepts. `both` makes the provider eligible
 * for either request pool, and means it is served by a byte relay — never by the
 * translator, because the client's own shape is one it already speaks.
 * Existing configs default to `claude`. */
export type ProviderCompatibility = 'openai' | 'claude' | 'both'
/** Compatibility of an incoming request. Unlike a provider, a request is one shape. */
export type RequestCompatibility = Exclude<ProviderCompatibility, 'both'>

/**
 * Dialect quirks for an `openai` (translated) provider. Both defaults suit OpenAI
 * and Azure.
 */
export interface OpenAIOptions {
  /**
   * Which field carries the token cap. OpenAI and Azure reasoning models reject
   * `max_tokens` and require `max_completion_tokens` (accepted by every current
   * model, hence the default); older local servers only know `max_tokens`.
   */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  /**
   * What to send as `reasoning_effort` when Claude Code asks for extended
   * thinking. Absent = send nothing, because most models reject the field.
   */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'
}

/**
 * Per-provider token prices in USD per 1M tokens.
 *
 * Every field is optional, including input and output: a price the user does not
 * know is better left blank than guessed, and a blank field simply contributes
 * nothing to the cost of the call. Without this block at all, cost for a
 * translated (OpenAI-compatible) call is recorded as zero.
 */
export interface ProviderPricing {
  input?: number
  output?: number
  /** Defaults to `input` when that is set: most non-Anthropic endpoints bill
   *  cached prompt tokens as ordinary input rather than at a separate rate. */
  cacheRead?: number
  cacheWrite?: number
}

export interface ProviderConfig {
  name: string
  baseUrl: string
  /** Not required when authStyle is 'passthrough' — no key is injected. */
  apiKey?: string
  enabled: boolean
  weight: number
  /** Defaults to 'x-api-key' if omitted */
  authStyle?: AuthStyle
  /** Defaults to 'claude' if omitted. */
  compatibility?: ProviderCompatibility
  /** Only meaningful when compatibility is 'openai' (the translated shape). */
  openai?: OpenAIOptions
  /** Token prices for this provider's models. Absent = no provider override. */
  pricing?: ProviderPricing
  /**
   * Explicitly pin the sanitize mode for this provider.
   * When set, the gateway uses this value without any auto-flip probing:
   *   true  — strip Claude Code fingerprint headers/body markers (safe default for most proxies)
   *   false — forward everything unchanged (required by providers that fingerprint the client, e.g. AgentRouter)
   * Omit the field to let the gateway auto-learn the correct mode.
   */
  sanitize?: boolean
}

export interface ProviderHealth {
  consecutiveFailures: number
  unhealthy: boolean
  cooldownUntil: number | null
}

/** Effective (non-mutating) health view for a single provider, for reporting. */
export interface ProviderHealthSnapshot extends ProviderHealth {
  cooldownRemainingMs: number
}

/** Which sanitize mode a provider is on, and whether it was pinned or learned. */
export interface SanitizeDetail {
  mode: boolean
  source: 'pinned' | 'learned'
}

export interface RequestStats {
  total: number
  perProvider: Record<string, { requests: number; errors: number }>
  retries: number
  latencies: RollingLatency
}

/** A single completed API call record stored in SQLite */
export interface UsageRecord {
  id?: number
  timestamp: string        // ISO-8601
  date: string             // YYYY-MM-DD
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
}

export interface ProviderDailyStats {
  provider: string
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
}

export interface DailySummary {
  date: string
  totalCalls: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  totalCostUsd: number
  byProvider: ProviderDailyStats[]
}

export interface StrategyType {
  name: string
  select(providers: ProviderConfig[]): ProviderConfig | null
}

export type StrategyName = 'random' | 'round-robin' | 'weighted'

export interface GatewayConfig {
  port: number
  /**
   * Interface to bind. Defaults to 127.0.0.1 — the gateway holds plaintext
   * provider API keys and will forward any request that reaches it, so it must
   * not be LAN-reachable by default. Containers set HOST=0.0.0.0 explicitly.
   */
  host: string
  /** Path to providers.json. Absolute in the desktop app; cwd-relative otherwise. */
  providersPath: string
  strategy: StrategyName
  /** Timeout (ms) for establishing a connection + receiving response headers. */
  requestTimeout: number
  /** Timeout (ms) for the full streaming body after headers are received. */
  streamTimeout: number
  healthFailureThreshold: number
  healthCooldownMs: number
  logLevel: string
  nodeEnv: string
}

export interface ProxyContext {
  requestId: string
  provider: ProviderConfig
  url: string
  method: string
  startTime: number
  retryCount: number
}
