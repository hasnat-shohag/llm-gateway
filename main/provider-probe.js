'use strict'
/**
 * One-shot probe of a single provider, bypassing the gateway's selection strategy.
 *
 * The point is to test a provider you have not enabled yet, or one you suspect is
 * broken, without waiting for the strategy to happen to pick it. Two consequences
 * the UI must state plainly:
 *   - it bypasses the gateway, so it does not reflect the learned sanitize mode;
 *   - it costs a real fraction of a cent.
 * It deliberately does not touch health state or record usage — a manual test must
 * not cool a provider down or show up as spend.
 */
const providersStore = require('./providers-store.js')

const TIMEOUT_MS = 15_000
const PREVIEW_CHARS = 300
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'

/** Never let a provider key reach the renderer or a log via the response preview. */
function scrub(text, apiKey) {
  if (!text) return ''
  let out = text
  if (typeof apiKey === 'string' && apiKey.length >= 8) {
    out = out.split(apiKey).join('[redacted]')
  }
  // Generic key-ish shapes, in case the upstream echoes a different credential.
  out = out.replace(/\b(sk|pk)-[A-Za-z0-9._-]{8,}/g, '[redacted]')
  return out.slice(0, PREVIEW_CHARS)
}

async function run(name, { model = DEFAULT_MODEL } = {}) {
  const provider = providersStore.rawProvider(name)
  if (!provider) return { ok: false, error: `unknown provider "${name}" — reload and try again` }

  const authStyle = provider.authStyle ?? 'x-api-key'
  if (authStyle === 'passthrough') {
    // There is no credential to test with: the whole design is that Claude Code
    // supplies its own, and this process never sees it.
    return {
      ok: false,
      error: 'A passthrough provider carries no key of its own — it relays your Claude Code login. Test it by running a real prompt through the gateway with only this provider enabled.',
    }
  }

  // Mirror proxy.ts's header construction so the probe reflects real behavior.
  const headers = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'accept-encoding': 'identity',
  }
  if (authStyle === 'bearer') headers['authorization'] = `Bearer ${provider.apiKey}`
  else headers['x-api-key'] = provider.apiKey

  const body = JSON.stringify({
    model,
    max_tokens: 1,
    stream: false,
    messages: [{ role: 'user', content: 'ping' }],
  })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const startedAt = Date.now()

  try {
    const res = await fetch(`${provider.baseUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    })
    const latencyMs = Date.now() - startedAt
    const contentType = res.headers.get('content-type') ?? ''
    const text = await res.text()
    const preview = scrub(text, provider.apiKey)

    return {
      ok: res.ok,
      statusCode: res.status,
      latencyMs,
      contentType,
      // An HTML body at any status is the Cloudflare-error-page signature the
      // gateway's own guards look for.
      looksLikeHtml: contentType.includes('text/html') || preview.trimStart().startsWith('<'),
      bodyPreview: preview,
      model,
      authStyle,
    }
  } catch (err) {
    return {
      ok: false,
      statusCode: 0,
      latencyMs: Date.now() - startedAt,
      error: err.name === 'AbortError' ? `no response within ${TIMEOUT_MS / 1000}s` : err.message,
      model,
      authStyle,
    }
  } finally {
    clearTimeout(timer)
  }
}

module.exports = { run, DEFAULT_MODEL }
