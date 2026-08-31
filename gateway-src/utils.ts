import crypto from 'crypto'

export function generateRequestId(): string {
  return crypto.randomUUID()
}

export function shouldRetry(statusCode: number): boolean {
  // Standard transient errors + Cloudflare edge errors (520-526, 524).
  // Also retry on provider auth/rate-limiting/model errors (400, 401, 402, 403) so we fail over to other keys.
  return [
    400, 401, 402, 403,     // Client errors (bad key, usage limits, unsupported models)
    429,                    // Too Many Requests
    500, 502, 503, 504,     // Standard server errors
    520, 521, 522, 523,     // Cloudflare: unknown/refused/timed-out/unreachable origin
    524, 525, 526,          // Cloudflare: gateway timeout / SSL handshake / invalid cert
  ].includes(statusCode)
}

/**
 * Whether a failure on a `passthrough` (official-subscription) provider should
 * stop the whole request instead of failing over to another provider.
 *
 * Failing over off these codes is actively harmful:
 *   429 — the *subscription's* quota is exhausted. Failing over spends money on a
 *         paid third-party provider without the user asking.
 *   401/403 — the claude.ai login expired or lacks access. Only `/login` fixes
 *         that; no retry against any provider can succeed, and the client needs
 *         to see the real error to know what to do.
 */
export function isTerminalForPassthrough(statusCode: number): boolean {
  return statusCode === 429 || statusCode === 401 || statusCode === 403
}

/**
 * Whether an upstream status code looks like a *sanitization mismatch* — i.e.
 * the provider rejected the request because it was sanitized when it shouldn't
 * be, or unsanitized when it should be. These are the signatures worth flipping
 * the sanitize mode and retrying the same provider for:
 *   401 — client-fingerprint rejection (AgentRouter: "unauthorized client
 *         detected" when Claude Code markers were stripped)
 *   400 — bad-request from forwarding fields/markers a provider can't accept
 * Other retryable codes (402 quota, 403 tier, 429, 5xx, Cloudflare) are NOT
 * mismatches — flipping sanitize won't fix them, so we let normal failover
 * handle those instead of wasting a same-provider retry.
 */
export function looksLikeSanitizeMismatch(statusCode: number): boolean {
  return statusCode === 400 || statusCode === 401
}

export function removeAuthHeaders(headers: Record<string, string>): Record<string, string> {
  const result = { ...headers }
  delete result['authorization']
  delete result['x-api-key']
  return result
}

export function injectAuthHeaders(
  headers: Record<string, string>,
  apiKey: string,
  originalHeaders: Record<string, string>
): Record<string, string> {
  const result = { ...headers }
  if (originalHeaders['x-api-key']) {
    result['x-api-key'] = apiKey
  } else {
    result['authorization'] = `Bearer ${apiKey}`
  }
  return result
}

export function sanitizeHeaders(headers: Record<string, string>, shouldSanitize: boolean = true): Record<string, string> {
  const result = { ...headers }

  // Standard hop-by-hop / routing headers
  delete result['host']
  delete result['connection']
  delete result['content-length']
  delete result['transfer-encoding']

  if (shouldSanitize) {
    // Strip Stainless and Anthropic client telemetry/metadata headers injected by
    // the Anthropic SDK / Claude Code CLI. These fingerprint the request and can
    // trigger Anthropic's upstream policy filters when proxied.
    for (const key of Object.keys(result)) {
      const lowerKey = key.toLowerCase()
      if (lowerKey.startsWith('x-stainless-') || lowerKey.startsWith('x-anthropic-')) {
        if (lowerKey !== 'x-api-key') {
          delete result[key]
        }
      }
    }

    // Rewrite User-Agent to standard browser format if it contains Claude signature
    if (result['user-agent'] && /claude/i.test(result['user-agent'])) {
      result['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  }

  return result
}

export function sanitizeRequestBody(body: any): any {
  if (!body || typeof body !== 'object') {
    return body
  }

  // Deep clone or shallow copy depending on use. Fastify body is safe to copy shallowly first
  const result = { ...body }

  // Strip metadata as some third-party providers return 400 Bad Request if it's forwarded
  if ('metadata' in result) {
    delete result.metadata
  }

  // Strip anthropic_meta / billing top-level fields injected by newer SDK versions
  delete result.anthropic_meta
  delete result.billing

  // Patterns in the system prompt that trigger Anthropic's "Usage Policy /
  // reverse engineering" content classifier when proxied through third parties.
  // Claude Code injects a large self-referential system prompt that contains
  // its own identity markers ("You are Claude", policy references, etc.).
  // When a third-party provider forwards those to Anthropic's back-end, the
  // classifier sees it as an attempt to duplicate model outputs and blocks it.
  const POLICY_TRIGGER_PATTERNS: RegExp[] = [
    // Billing / internal header (existing)
    /x-anthropic-billing-header:[^\r\n]*\r?\n?/gi,
    // "You are Claude" identity line — the main trigger
    /^You are Claude.*$/gim,
    // Anthropic-brand references in system context
    /Anthropic'?s?\s+(usage\s+)?polic(?:y|ies)[^\r\n]*/gi,
    /Anthropic'?s?\s+terms\s+of\s+service[^\r\n]*/gi,
    /\bhttps?:\/\/(?:www\.)?anthropic\.com\/[^\s)]*/gi,
    // "Claude Code" self-identification lines
    /^Claude Code[^\r\n]*/gim,
    // Lines that look like internal tool-call capability declarations that fingerprint Claude Code
    /^You have access to a set of tools[^\r\n]*/gim,
    /^You are an? (?:AI|advanced|intelligent|helpful) (?:assistant|coding assistant)[^\r\n]*/gim,
  ]

  function scrubSystemText(text: string): string {
    let out = text
    for (const re of POLICY_TRIGGER_PATTERNS) {
      re.lastIndex = 0
      out = out.replace(re, '')
    }
    // Collapse runs of blank lines left after removal
    out = out.replace(/\n{3,}/g, '\n\n').trim()
    return out
  }

  // Strip problematic patterns from the system prompt
  if (result.system) {
    if (typeof result.system === 'string') {
      result.system = scrubSystemText(result.system)
    } else if (Array.isArray(result.system)) {
      result.system = result.system
        .map((block: any) => {
          if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
            const cleaned = { ...block }
            cleaned.text = scrubSystemText(cleaned.text)
            // Remove cache_control — acts as a Claude Code fingerprint on some
            // providers that relay it to Anthropic's caching layer.
            delete cleaned.cache_control
            return cleaned
          }
          return block
        })
        // Filter out empty text blocks
        .filter((block: any) => {
          if (block && typeof block === 'object' && block.type === 'text') {
            return block.text.length > 0
          }
          return true
        })
    }
  }

  return result
}

