'use strict'
/**
 * proxy.js routing — the end-to-end path through a real gateway process and a
 * purpose-built Chat Completions upstream.
 *
 * The unit tests pin the pieces (adapter, phases); this pins the wiring: which
 * provider a model family reaches, what headers survive the trip, and whether a
 * translated call is metered. It runs against a local mock rather than a paid
 * endpoint, so it proves the gateway is self-consistent, not that OpenAI accepts
 * the request.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createServer: createHttpServer } = require('node:http')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

// The pricing refresh route would otherwise crawl llmpricing.dev for every model
// in its body; the suite runs offline.
process.env.LLMPRICING_FETCH = '0'

async function loadGatewayModule(name) {
  return import(pathToFileURL(join(__dirname, '..', 'build', 'gateway', name)).href)
}

/** An HTTP upstream that records every request and answers with `respond`. */
function mockUpstream(respond) {
  const requests = []
  const server = createHttpServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({ url: req.url, method: req.method, headers: req.headers, body })
      respond(req, res, body)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        requests,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const chunk of chunks) res.write(chunk)
  res.end()
}

const OPENAI_STREAM = [
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\n',
  'data: [DONE]\n\n',
]

/**
 * Start the gateway's own server with a stub usage store.
 *
 * The real UsageTracker is skipped on purpose: better-sqlite3 is built for
 * Electron's ABI by the app's postinstall, so opening a database under plain
 * `node --test` throws NODE_MODULE_VERSION. The proxy only ever calls `record()`,
 * and what matters here is which numbers it hands over.
 */
async function startGateway(providers) {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-routing-'))
  const { createServer } = await loadGatewayModule('server.js')
  const { HealthTracker } = await loadGatewayModule('health.js')

  const recorded = []
  const usageTracker = { record: (entry) => recorded.push(entry), close: () => {} }
  const health = new HealthTracker(3, 1000)
  const config = {
    port: 0,
    host: '127.0.0.1',
    providersPath: join(dir, 'providers.json'),
    strategy: 'round-robin',
    requestTimeout: 5000,
    streamTimeout: 15000,
    healthFailureThreshold: 3,
    healthCooldownMs: 1000,
    logLevel: 'silent',
    nodeEnv: 'development',
  }
  const { app } = createServer(config, providers, health, usageTracker)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address()

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    recorded,
    close: async () => {
      await app.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('a non-Claude model on /v1/messages is translated to a Chat Completions call', async () => {
  const upstream = await mockUpstream((_req, res) => sse(res, OPENAI_STREAM))
  const apiKey = 'sk-translated-000000000001'
  const gateway = await startGateway([
    {
      name: 'translated',
      baseUrl: `${upstream.url}/v1`,
      apiKey,
      enabled: true,
      weight: 1,
      authStyle: 'bearer',
      compatibility: 'openai',
      pricing: { input: 1, output: 2 },
    },
  ])

  try {
    const res = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Both of these are Claude Code's, and neither may reach a third party.
        'x-api-key': 'client-key-must-not-travel',
        'anthropic-version': '2023-06-01',
        'x-stainless-lang': 'js',
      },
      body: JSON.stringify({
        model: 'gpt-5.6',
        max_tokens: 32,
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    const text = await res.text()
    assert.equal(res.status, 200)

    assert.equal(upstream.requests.length, 1)
    const sent = upstream.requests[0]
    assert.equal(sent.url, '/v1/chat/completions')
    assert.equal(sent.headers.authorization, `Bearer ${apiKey}`)
    assert.equal(sent.headers['x-api-key'], undefined, 'the client credential must not travel')
    assert.equal(sent.headers['anthropic-version'], undefined)
    assert.equal(sent.headers['x-stainless-lang'], undefined)

    const body = JSON.parse(sent.body)
    assert.equal(body.model, 'gpt-5.6', 'the client asked for this model, so it is sent verbatim')
    assert.equal(body.max_completion_tokens, 32)
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hello' }])
    assert.equal(body.stream, true)
    assert.deepEqual(body.stream_options, { include_usage: true })

    // What reaches Claude Code is Anthropic SSE, not the upstream's own format.
    assert.match(text, /event: message_start/)
    assert.match(text, /"text":"hi"/)
    assert.match(text, /event: message_stop/)

    // Priced from the provider's own numbers: 9 in @ $1/1M + 2 out @ $2/1M.
    const calls = gateway.recorded
    assert.equal(calls.length, 1)
    assert.equal(calls[0].provider, 'translated')
    assert.equal(calls[0].model, 'gpt-5.6')
    assert.equal(calls[0].inputTokens, 9)
    assert.equal(calls[0].outputTokens, 2)
    assert.equal(calls[0].costUsd, 0.000013)
  } finally {
    await gateway.close()
    await upstream.close()
  }
})

test('count_tokens for a translated provider is answered locally', async () => {
  const upstream = await mockUpstream((_req, res) => sse(res, OPENAI_STREAM))
  const gateway = await startGateway([
    {
      name: 'translated',
      baseUrl: `${upstream.url}/v1`,
      apiKey: 'sk-translated-000000000002',
      enabled: true,
      weight: 1,
      authStyle: 'bearer',
      compatibility: 'openai',
    },
  ])

  try {
    const res = await fetch(`${gateway.baseUrl}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6', messages: [{ role: 'user', content: 'hello there' }] }),
    })
    assert.equal(res.status, 200)
    assert.ok((await res.json()).input_tokens >= 1)
    // The upstream has no such route, so a proxy attempt would be a guaranteed 404
    // and would burn the failover loop on it.
    assert.equal(upstream.requests.length, 0)
  } finally {
    await gateway.close()
    await upstream.close()
  }
})

test('a both-compatible provider relays rather than translating', async () => {
  const relay = await mockUpstream((_req, res) => sse(res, ['event: message_stop\n\n']))
  const translated = await mockUpstream((_req, res) => sse(res, OPENAI_STREAM))
  const gateway = await startGateway([
    {
      name: 'dual',
      baseUrl: relay.url,
      apiKey: 'sk-dual-00000000000000003',
      enabled: true,
      weight: 1,
      authStyle: 'x-api-key',
      compatibility: 'both',
    },
    {
      name: 'translated',
      baseUrl: `${translated.url}/v1`,
      apiKey: 'sk-translated-000000000003',
      enabled: true,
      weight: 1,
      authStyle: 'bearer',
      compatibility: 'openai',
    },
  ])

  try {
    const res = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    await res.text()

    assert.equal(relay.requests.length, 1, 'a relay cannot lose fields, so it is tried first')
    assert.equal(relay.requests[0].url, '/v1/messages')
    assert.equal(translated.requests.length, 0)
  } finally {
    await gateway.close()
    await relay.close()
    await translated.close()
  }
})

test('a non-Claude model falls back to the Claude pool when that is all there is', async () => {
  // The GLM/Kimi/DeepSeek-over-Anthropic-proxy case: the model name is not
  // Claude-family, but the only provider speaks Anthropic and serves it anyway.
  const upstream = await mockUpstream((_req, res) => sse(res, ['event: message_stop\n\n']))
  const gateway = await startGateway([
    {
      name: 'anthropic-shaped',
      baseUrl: upstream.url,
      apiKey: 'k'.repeat(20),
      enabled: true,
      weight: 1,
      authStyle: 'x-api-key',
      compatibility: 'claude',
    },
  ])

  try {
    const res = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-4.6', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    await res.text()

    assert.equal(upstream.requests.length, 1)
    assert.equal(upstream.requests[0].url, '/v1/messages')
    assert.equal(JSON.parse(upstream.requests[0].body).model, 'glm-4.6')
  } finally {
    await gateway.close()
    await upstream.close()
  }
})

test('POST /pricing/refresh re-checks models without disturbing the proxy routes', async () => {
  const gateway = await startGateway([])

  try {
    const res = await fetch(`${gateway.baseUrl}/pricing/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ models: ['gpt-4o', 'not-a-real-model'] }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    // LLMPRICING_FETCH=0 above turns the live crawl into an explicit no-op.
    assert.equal(body.skipped, true)
    assert.deepEqual(body.refreshed, [])
    assert.equal(body.failed.length, 2)
    assert.ok(body.status.snapshotCount >= 500)
    // The catch-all proxy must not have swallowed the route…
    assert.equal(gateway.recorded.length, 0)
    // …and neither did a bogus body break it.
    const empty = await fetch(`${gateway.baseUrl}/pricing/refresh`, { method: 'POST' })
    assert.equal(empty.status, 200)
    assert.deepEqual((await empty.json()).failed, [])
  } finally {
    await gateway.close()
  }
})

test('an OpenAI-shaped request is still relayed raw and metered as OpenAI usage', async () => {
  // Codex and opencode speak Chat Completions. Their stream is not translated, so
  // the interceptor has to read OpenAI chunks. Pricing: a model the tables know
  // (claude-sonnet-4-5 over an OpenRouter-style host) records its real list cost;
  // a model nobody knows records zero rather than a guessed price.
  const upstream = await mockUpstream((_req, res) => sse(res, OPENAI_STREAM))
  const gateway = await startGateway([
    {
      name: 'dual',
      baseUrl: `${upstream.url}/v1`,
      apiKey: 'k'.repeat(20),
      enabled: true,
      weight: 1,
      authStyle: 'bearer',
      compatibility: 'both',
    },
  ])

  try {
    const ask = (model) =>
      fetch(`${gateway.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      })

    const res = await ask('claude-sonnet-4-5')
    const text = await res.text()

    assert.equal(upstream.requests.length, 1)
    // A `both` provider accepts this shape, so the request is not rewritten and the
    // client's own model name travels. This is how OpenRouter serves Anthropic
    // models over its Chat Completions endpoint.
    assert.equal(upstream.requests[0].url, '/v1/chat/completions')
    assert.equal(JSON.parse(upstream.requests[0].body).model, 'claude-sonnet-4-5')
    assert.match(text, /chatcmpl-1/, 'the upstream body is relayed untouched')

    assert.equal(gateway.recorded.length, 1)
    assert.equal(gateway.recorded[0].inputTokens, 9)
    assert.equal(gateway.recorded[0].outputTokens, 2)
    // 9 in @ $3/1M + 2 out @ $15/1M — the Anthropic table prices its own model
    // even on an OpenAI-shaped endpoint.
    assert.equal(gateway.recorded[0].costUsd, 0.000057)

    // A model no table knows: tokens are recorded, cost is not guessed.
    await ask('mystery-vendor-model-x')
    assert.equal(gateway.recorded.length, 2)
    assert.equal(gateway.recorded[1].model, 'mystery-vendor-model-x')
    assert.equal(gateway.recorded[1].inputTokens, 9)
    assert.equal(gateway.recorded[1].outputTokens, 2)
    assert.equal(gateway.recorded[1].costUsd, 0)
  } finally {
    await gateway.close()
    await upstream.close()
  }
})
