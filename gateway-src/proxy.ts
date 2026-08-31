import type { FastifyRequest, FastifyReply } from 'fastify'
import { request as undiciRequest, Agent } from 'undici'
import { Transform, Readable } from 'stream'
import { ProviderManager } from './provider-manager.js'
import { HealthTracker } from './health.js'
import type { GatewayConfig, RequestStats } from './types.js'
import { generateRequestId, shouldRetry, removeAuthHeaders, sanitizeHeaders, sanitizeRequestBody, looksLikeSanitizeMismatch, isTerminalForPassthrough } from './utils.js'
import { createLogger } from './logger.js'
import { UsageTracker, calculateCost } from './usage-tracker.js'
import { SanitizeLearner } from './sanitize-learner.js'

// ---------------------------------------------------------------------------
// Shared undici connection pool
// ---------------------------------------------------------------------------
// The default global undici dispatcher caps concurrent connections per origin
// low, so several Claude Code sessions hitting the gateway at once queue behind
// one another and can trip body timeouts.  A dedicated Agent with a higher
// per-origin connection count keeps concurrent requests from starving.
const dispatcher = new Agent({
  connections: 64,
  pipelining: 0,
})

/**
 * Read the first chunk of an undici body stream, then return a fresh Readable
 * that replays that chunk followed by the rest of the stream.  Lets us inspect
 * whether a 200 response actually carries a body before committing status +
 * headers to the client (so we can still fail over on an empty/aborted stream).
 *
 * Returns `{ empty: true }` when the stream ends with no bytes.
 */
async function peekBody(
  body: Readable
): Promise<{ empty: true } | { empty: false; firstChunk: Buffer; stream: Readable }> {
  const iterator = body[Symbol.asyncIterator]()
  let first: IteratorResult<Buffer>
  try {
    first = await iterator.next()
  } catch {
    // Stream errored before yielding anything — treat as empty so we fail over.
    body.destroy()
    return { empty: true }
  }

  if (first.done || !first.value || first.value.length === 0) {
    return { empty: true }
  }

  const firstChunk = first.value
  const replay = Readable.from(
    (async function* () {
      yield firstChunk
      while (true) {
        const next = await iterator.next()
        if (next.done) return
        yield next.value
      }
    })()
  )
  // Propagate downstream errors so callers/pipe consumers see the abort.
  body.on('error', (err) => replay.destroy(err))
  // Prevent uncaught 'error' events on replay if no consumer has attached yet.
  replay.on('error', () => {})

  return { empty: false, firstChunk, stream: replay }
}

/**
 * Forward upstream response headers to the Fastify reply.
 *
 * Rules:
 *  - Skip hop-by-hop headers (transfer-encoding, connection, keep-alive).
 *  - Skip content-length — we stream the body so the length may differ.
 *  - DO NOT strip content-encoding — undici does not decompress the body stream
 *    for us (it's forwarded raw/untouched), so we MUST preserve the encoding
 *    header so the client (e.g., Claude CLI) knows how to decompress it.
 */
function forwardHeaders(
  reply: FastifyReply,
  headers: Record<string, string | string[] | undefined>
) {
  const HOP_BY_HOP = new Set([
    'transfer-encoding',
    'connection',
    'keep-alive',
    'server',
    'x-powered-by',
    'content-length',
  ])

  for (const [key, value] of Object.entries(headers)) {
    if (!value) continue
    if (HOP_BY_HOP.has(key.toLowerCase())) continue
    reply.header(key, value)
  }
}

// ---------------------------------------------------------------------------
// SSE stream interceptor
// ---------------------------------------------------------------------------
// Creates a Transform stream that passes every byte through to the client
// unchanged while scanning for the two SSE events that carry token usage:
//   - message_start  → input_tokens, model
//   - message_delta  → output_tokens (in the top-level usage object)
// After the stream ends (or errors) the collected data is persisted via
// UsageTracker.record().
// ---------------------------------------------------------------------------
function createUsageInterceptor(
  provider: string,
  usageTracker: UsageTracker,
  log: ReturnType<typeof createLogger>,
  requestedModel?: string
): Transform {
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  // Prefer the model the CLIENT requested for pricing/recording. Some upstream
  // proxies (e.g. freemodel) substitute their own model name in the SSE
  // message_start (claude-fable-5), which mis-prices the call — the provider
  // still bills the requested model. Fall back to the SSE model only when the
  // request body carried none.
  let model = requestedModel || 'unknown'
  // Buffer incomplete SSE lines across chunk boundaries
  let lineBuffer = ''

  // Guard: a stream must be recorded at most once, and only on clean
  // completion. A truncated/aborted stream (error) is a FAILED delivery — the
  // client got a malformed response and health tracking penalizes the
  // provider — so it must NOT contribute cost to the DB.
  let recorded = false
  const flush = () => {
    if (recorded) return
    recorded = true
    if (inputTokens === 0 && outputTokens === 0) return   // nothing to record
    try {
      const now = new Date()
      const costUsd = calculateCost(model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens)
      usageTracker.record({
        timestamp:        now.toISOString(),
        date:             now.toISOString().slice(0, 10),
        provider,
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        costUsd,
      })
      log.info({ provider, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd },
        'usage recorded')
    } catch (err) {
      log.warn({ err }, 'failed to record usage')
    }
  }

  const parseLine = (line: string) => {
    // SSE data lines start with 'data: '
    if (!line.startsWith('data: ')) return
    const raw = line.slice(6).trim()
    if (raw === '[DONE]') return
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>
      if (obj.type === 'message_start') {
        const msg = obj.message as Record<string, unknown> | undefined
        // Only trust the SSE model when the client didn't specify one — some
        // upstream proxies substitute their own model name here (see above).
        if (msg?.model && !requestedModel) model = String(msg.model)
        const usage = msg?.usage as Record<string, number> | undefined
        if (usage) {
          inputTokens       += usage.input_tokens                ?? 0
          cacheReadTokens   += usage.cache_read_input_tokens     ?? 0
          cacheWriteTokens  += usage.cache_creation_input_tokens ?? 0
        }
      } else if (obj.type === 'message_delta') {
        const usage = obj.usage as Record<string, number> | undefined
        if (usage) {
          outputTokens += usage.output_tokens ?? 0
        }
      }
    } catch {
      // Non-JSON data line — skip
    }
  }

  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      // Pass chunk through to client immediately
      this.push(chunk)
      // Parse lines from the chunk (handle partial lines across chunks)
      const text = lineBuffer + chunk.toString('utf8')
      const lines = text.split('\n')
      // The last element may be an incomplete line — keep it in the buffer
      lineBuffer = lines.pop() ?? ''
      for (const line of lines) {
        parseLine(line.replace(/\r$/, ''))
      }
      callback()
    },
    flush(callback) {
      // Process any remaining buffered content
      if (lineBuffer) parseLine(lineBuffer.replace(/\r$/, ''))
      flush()
      callback()
    },
  })

  // NOTE: intentionally NO 'error' handler that records usage. The Transform's
  // flush() callback fires only on clean completion; a stream destroyed by an
  // upstream error skips it, so a failed/truncated call records zero cost.
  // (An empty error listener is attached at the call site to keep the process
  // from crashing on the unhandled 'error' event.)

  return transform
}

export function createProxyHandler(
  providerManager: ProviderManager,
  healthTracker: HealthTracker,
  config: GatewayConfig,
  stats?: RequestStats,
  usageTracker?: UsageTracker,
  sanitizeLearner?: SanitizeLearner
) {
  const log = createLogger(config.logLevel, config.nodeEnv)

  return async (req: FastifyRequest, reply: FastifyReply) => {
    const requestId = generateRequestId()
    const startTime = Date.now()
    let retryCount = 0
    const attempted = new Set<string>()
    const originalHeaders = req.headers as Record<string, string>
    const method = req.method
    const url = req.url

    let lastError: Error | null = null
    let lastStatusCode = 500

    // Outcome of a single upstream attempt (one provider, one sanitize mode):
    //   done      — response already sent to the client; stop the whole handler
    //   mismatch  — failed with a sanitize-mismatch signature (400/401); the
    //               caller may flip the sanitize mode and retry the SAME provider
    //   failover  — failed in a way that warrants trying the NEXT provider
    //   error     — network/transport error; try the next provider
    type AttemptResult =
      | { outcome: 'done' }
      | { outcome: 'mismatch'; statusCode: number }
      | { outcome: 'failover'; statusCode: number }
      | { outcome: 'error'; error: Error }

    // Perform one upstream request to `provider` using the given sanitize mode.
    // Terminal outcomes ('done') send the response and do their own stats/health
    // bookkeeping; non-terminal outcomes drain the body and let the caller decide
    // (flip vs. failover), so failure bookkeeping for those lives in the loop.
    const attemptOnce = async (
      provider: ReturnType<typeof providerManager.selectExcluding>,
      shouldSanitize: boolean
    ): Promise<AttemptResult> => {
      if (!provider) return { outcome: 'failover', statusCode: lastStatusCode }
      const authStyle = provider.authStyle ?? 'x-api-key'
      const isPassthrough = authStyle === 'passthrough'
      try {
        const targetUrl = `${provider.baseUrl}${url}`

        // Build headers. For a passthrough provider we must NOT touch the
        // client's credential: Claude Code is sending its own subscription
        // bearer token and we relay it to api.anthropic.com verbatim.
        let headers = isPassthrough
          ? sanitizeHeaders(originalHeaders, false)
          : removeAuthHeaders(sanitizeHeaders(originalHeaders, shouldSanitize))
        headers['host'] = new URL(provider.baseUrl).host

        // Inject auth header according to the provider's declared style:
        //   'x-api-key' (default) — standard Anthropic SDK header
        //   'bearer'              — Authorization: Bearer <key> (AgentRouter)
        //   'passthrough'         — inject nothing, the client's header stands
        if (authStyle === 'bearer') {
          headers['authorization'] = `Bearer ${provider.apiKey}`
        } else if (authStyle === 'x-api-key') {
          headers['x-api-key'] = provider.apiKey as string
        }

        // Drop beta-feature flags that third-party providers don't support.
        // Forwarding unknown beta flags (e.g., interleaved-thinking-2025-05-14)
        // can cause free/proxy endpoints to return malformed responses or trigger
        // Anthropic's upstream policy filters.
        //
        // NEVER for passthrough: when Claude Code authenticates with a claude.ai
        // login, `anthropic-beta` also carries the OAuth capability the upstream
        // requires, and stripping it fails the request with 401. Forward the
        // header verbatim rather than allowlisting values — the set changes with
        // Claude Code releases.
        if (shouldSanitize && !isPassthrough) {
          delete headers['anthropic-beta']
        }

        // Inject anthropic-version if the client didn't send it.
        // Some providers require this header; without it they may return a
        // silent 200 with an empty or invalid body.
        if (!headers['anthropic-version']) {
          headers['anthropic-version'] = '2023-06-01'
        }

        // Tell the upstream we accept uncompressed so we never have to deal
        // with decompression ourselves.
        headers['accept-encoding'] = 'identity'

        const sanitizedBody = req.body
          ? (shouldSanitize ? sanitizeRequestBody(req.body) : req.body)
          : undefined
        const body = sanitizedBody ? JSON.stringify(sanitizedBody) : undefined
        if (body) {
          headers['content-length'] = String(Buffer.byteLength(body))
          // Ensure correct content-type for JSON payloads
          headers['content-type'] = 'application/json'
        }

        const response = await undiciRequest(targetUrl, {
          method,
          headers,
          body,
          dispatcher,
          // headersTimeout: time to establish the connection and receive the
          // first byte of response headers.  Short — if the provider doesn't
          // respond quickly it's probably down.
          headersTimeout: config.requestTimeout,
          // bodyTimeout: time allowed for the streaming body after headers.
          // Must be long enough to cover large completions.  0 = no timeout.
          bodyTimeout: config.streamTimeout,
        })

        if (response.statusCode >= 200 && response.statusCode < 300) {
          // Guard 1: content-type check.
          // Some providers (via Cloudflare) return HTML error pages with a 200
          // status.  Claude Code cannot parse HTML as an SSE stream and reports
          // "empty or malformed response".  Detect and retry.
          const ct = (response.headers['content-type'] as string | undefined) ?? ''
          if (ct.includes('text/html')) {
            log.warn({ requestId, provider: provider.name, contentType: ct },
              'provider returned HTML at 200 — retrying next provider')
            await response.body.dump()
            return { outcome: 'failover', statusCode: response.statusCode }
          }

          // Guard 2: peek the body before committing status + headers.
          // Some providers quietly exhaust their quota and reply 200 with an
          // empty body, or drop the connection before the first byte.  A
          // content-length check alone misses chunked SSE streams (no
          // content-length header), so read the first chunk and only commit
          // the response to the client once we know real bytes exist.
          const peeked = await peekBody(response.body as unknown as Readable)
          if (peeked.empty) {
            log.warn({ requestId, provider: provider.name },
              'provider returned 200 with empty/aborted body — retrying next provider')
            return { outcome: 'failover', statusCode: response.statusCode }
          }

          // Guard 3: first-bytes sniff.
          // Cloudflare error pages sometimes arrive with a JSON/SSE
          // content-type, so also check the leading bytes.  A valid Anthropic
          // response starts with '{' (JSON mode) or an SSE field name
          // ("event:"/"data:").  '<' means HTML regardless of the header.
          const head = peeked.firstChunk.toString('utf8', 0, Math.min(64, peeked.firstChunk.length)).trimStart()
          if (head.startsWith('<')) {
            log.warn({ requestId, provider: provider.name, head: head.slice(0, 40) },
              'provider returned HTML body at 200 — retrying next provider')
            peeked.stream.destroy()
            ;(response.body as unknown as Readable).destroy()
            return { outcome: 'failover', statusCode: response.statusCode }
          }

          // Real success — remember the sanitize mode that worked so future
          // requests to this provider skip the probe/flip entirely.
          sanitizeLearner?.recordSuccess(provider.name, shouldSanitize)

          // NOTE: health success is recorded on clean stream *completion*, not
          // here at commit time. A provider can commit a 200 and then truncate
          // the SSE body mid-flight; recording success eagerly would reset the
          // failure counter every request and mask a chronically-truncating
          // provider so it never trips the health threshold. See the stream
          // 'end'/'error' handlers below.
          const latency = Date.now() - startTime
          if (stats) {
            stats.total++
            stats.perProvider[provider.name] ??= { requests: 0, errors: 0 }
            stats.perProvider[provider.name].requests++
            stats.latencies.push(latency)
            stats.retries += retryCount
          }

          log.info({
            requestId,
            provider: provider.name,
            method,
            url,
            status: response.statusCode,
            latency,
            retryCount,
            sanitize: shouldSanitize,
          }, 'request completed')

          reply.code(response.statusCode)
          forwardHeaders(reply, response.headers)

          // Wrap the body in a usage-intercepting Transform if the response
          // looks like an SSE stream (text/event-stream).  For all other
          // content types (e.g. plain JSON) pipe through unchanged — we can
          // add JSON-mode parsing later if needed.
          // Swallow upstream EOF / parse errors so they don't bubble up as
          // unhandled 'error' events and crash the process after the response
          // has already been committed to the client.
          // Settle provider health exactly once, based on how the stream ends:
          //   clean 'end'  → recordSuccess (resets failure counter)
          //   'error'      → recordFailure (truncated/aborted mid-stream)
          // Guarded so the two signals can't both fire (or fire twice).
          let settled = false
          const settleSuccess = () => {
            if (settled) return
            settled = true
            healthTracker.recordSuccess(provider.name)
          }
          const swallowStreamError = (err: Error) => {
            // Penalize the provider: a stream that dies after we committed 200
            // leaves the client with a truncated (malformed) response. Enough
            // consecutive truncations cool the provider down so retries route
            // around it. A later clean completion resets the counter.
            if (!settled) {
              settled = true
              healthTracker.recordFailure(provider.name)
            }
            log.warn({ requestId, provider: provider.name, err: err.message },
              'upstream stream error after response committed (ignored, provider penalized)')
          }
          ;(response.body as unknown as Readable).on('error', swallowStreamError)
          peeked.stream.on('error', swallowStreamError)
          // 'end' fires when the client-facing source stream is fully consumed
          // without error — the response reached the client intact.
          peeked.stream.on('end', settleSuccess)

          if (usageTracker && ct.includes('text/event-stream')) {
            const requestedModel = (req.body as { model?: string } | undefined)?.model
            const interceptor = createUsageInterceptor(provider.name, usageTracker, log, requestedModel)
            interceptor.on('error', swallowStreamError)
            await reply.send(peeked.stream.pipe(interceptor))
            return { outcome: 'done' }
          }

          await reply.send(peeked.stream)
          return { outcome: 'done' }
        }

        // A passthrough (official-subscription) provider must not fail over on
        // quota/auth errors: a 429 means the user's own plan is exhausted, and
        // failing over would silently spend money on a paid provider; a 401/403
        // needs `/login` and can never succeed on retry. Forward the upstream
        // response unchanged so the client sees the real error.
        const passthroughTerminal = isPassthrough && isTerminalForPassthrough(response.statusCode)
        if (passthroughTerminal) {
          log.warn({ requestId, provider: provider.name, status: response.statusCode },
            'passthrough provider returned a terminal status — forwarding to client instead of failing over')
        }

        // Sanitize-mismatch signature (400/401): the provider likely rejected
        // the request because of the sanitize mode (stripped fingerprint vs.
        // forwarded markers). Signal the caller so it can flip and retry the
        // same provider. Body is drained to release the pooled connection.
        if (!passthroughTerminal && looksLikeSanitizeMismatch(response.statusCode)) {
          await response.body.dump()
          return { outcome: 'mismatch', statusCode: response.statusCode }
        }

        if (!passthroughTerminal && shouldRetry(response.statusCode)) {
          log.warn({
            requestId,
            provider: provider.name,
            status: response.statusCode,
            retryCount,
          }, 'provider returned retryable status code — retrying next')
          // Drain the body so the connection is released back to the pool
          await response.body.dump()
          return { outcome: 'failover', statusCode: response.statusCode }
        }

        // Non-retryable error — forward as-is
        healthTracker.recordFailure(provider.name)
        const latency = Date.now() - startTime
        if (stats) {
          stats.total++
          stats.perProvider[provider.name] ??= { requests: 0, errors: 0 }
          stats.perProvider[provider.name].errors++
          stats.latencies.push(latency)
          stats.retries += retryCount
        }

        log.warn({
          requestId,
          provider: provider.name,
          method,
          url,
          status: response.statusCode,
          latency,
          retryCount,
        }, 'non-retryable error')

        reply.code(response.statusCode)
        forwardHeaders(reply, response.headers)
        // Swallow errors on the body stream for non-retryable forwards too.
        ;(response.body as unknown as Readable).on('error', (err: Error) => {
          log.warn({ requestId, provider: provider.name, err: err.message },
            'upstream body stream error on non-retryable forward (ignored)')
        })
        await reply.send(response.body)
        return { outcome: 'done' }
      } catch (err) {
        return { outcome: 'error', error: err as Error }
      }
    }

    // Decide the sanitize mode(s) to try for a provider, in order:
    //   - passthrough      → always [false], never flipped. Sanitizing would
    //     strip `anthropic-beta` (breaking the OAuth capability) and rewrite the
    //     system blocks, and the resulting 401 would be misread as a sanitize
    //     mismatch — so the learner would converge on the wrong mode.
    //   - already learned  → the learned value only
    //   - unlearned        → [default guess, flipped] so a mismatch can flip
    //     once to discover the right mode
    // Otherwise the sanitize mode is auto-learned; `sanitize` in providers.json
    // pins it (see SanitizeLearner.pin).
    const modesFor = (provider: NonNullable<ReturnType<typeof providerManager.selectExcluding>>): boolean[] => {
      if ((provider.authStyle ?? 'x-api-key') === 'passthrough') return [false]
      if (!sanitizeLearner) return [SanitizeLearner.DEFAULT_MODE]
      const guess = sanitizeLearner.modeFor(provider.name)
      if (sanitizeLearner.isLearned(provider.name)) return [guess]
      return [guess, !guess]
    }

    // Keep trying providers until all have been attempted once.
    // We ask the manager to exclude already-tried providers so the
    // selection strategy doesn't keep handing back the same one.
    while (attempted.size < providerManager.providerCount()) {
      const provider = providerManager.selectExcluding(attempted)
      if (!provider) break
      attempted.add(provider.name)

      const modes = modesFor(provider)
      let result: AttemptResult = { outcome: 'failover', statusCode: lastStatusCode }

      for (let mi = 0; mi < modes.length; mi++) {
        result = await attemptOnce(provider, modes[mi])

        // A sanitize mismatch with another mode left → flip and retry the SAME
        // provider (the whole point of auto-learning). No health penalty for the
        // probe; the flipped attempt decides the provider's fate.
        if (result.outcome === 'mismatch' && mi < modes.length - 1) {
          log.warn({
            requestId,
            provider: provider.name,
            status: result.statusCode,
            from: modes[mi],
            to: modes[mi + 1],
          }, 'sanitize mismatch — flipping mode and retrying same provider')
          continue
        }
        break
      }

      if (result.outcome === 'done') return

      // Non-terminal: record the failure for failover bookkeeping and move on.
      healthTracker.recordFailure(provider.name)
      retryCount++
      if (result.outcome === 'error') {
        lastError = result.error
        log.warn({
          requestId,
          provider: provider.name,
          error: lastError.message,
          retryCount,
        }, 'provider request failed — retrying next')
      } else {
        lastStatusCode = result.statusCode
      }
    }

    if (stats) {
      stats.total++
      stats.retries += retryCount
    }

    log.error({
      requestId,
      method,
      url,
      retryCount,
      lastError: lastError?.message,
      lastStatusCode,
    }, 'all providers exhausted')

    reply.code(503)
    reply.send({
      error: 'all providers failed',
      requestId,
      retries: retryCount,
      details: lastError?.message ?? `HTTP ${lastStatusCode}`,
    })
  }
}
