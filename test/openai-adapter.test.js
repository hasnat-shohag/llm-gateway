'use strict'
/**
 * openai-adapter.js — the Anthropic Messages ⇄ OpenAI Chat Completions
 * translation, exercised without a socket: every function is pure, so the part
 * most likely to be wrong is also the part that is cheap to check.
 *
 * Ported from the upstream gateway's `src/openai-adapter.test.ts`, adapted to the
 * `compatibility` vocabulary and to this repo's compiled-output harness.
 */
const { test } = require('node:test')
const assert = require('node:assert')
const { once } = require('node:events')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

async function loadGatewayModule(name) {
  return import(pathToFileURL(join(__dirname, '..', 'build', 'gateway', name)).href)
}

test('openai-adapter translates Anthropic Messages and Chat Completions both ways', async () => {
  const {
    createOpenAIToAnthropicStream,
    estimateInputTokens,
    fromOpenAIResponse,
    openAIChatUrl,
    toAnthropicError,
    toOpenAIRequest,
  } = await loadGatewayModule('openai-adapter.js')

  // Function declarations rather than arrow factories so the blocks below can call
  // them before their textual definition.
function provider(extra = {}) {
  return {
    name: 'P',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'k',
    enabled: true,
    weight: 1,
    compatibility: 'openai',
    ...extra,
  }
}

function messages(body) {
  return toOpenAIRequest(body, provider(), 'gpt-4o').messages 
}

// --- baseUrl join ----------------------------------------------------------
// One rule has to serve four conventions, and getting it wrong is a 404 per
// request rather than a config error.
{
  assert.equal(openAIChatUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions')
  assert.equal(openAIChatUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1/chat/completions')
  assert.equal(openAIChatUrl('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1/chat/completions')
  // A bare host still wants the /v1 prefix — this is how a local server is written.
  assert.equal(openAIChatUrl('http://127.0.0.1:11434'), 'http://127.0.0.1:11434/v1/chat/completions')
  assert.equal(openAIChatUrl('http://127.0.0.1:11434/'), 'http://127.0.0.1:11434/v1/chat/completions')
  // Azure names the endpoint itself and the api-version query is required, so the
  // URL must survive verbatim.
  assert.equal(
    openAIChatUrl('https://r.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21'),
    'https://r.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21',
  )
}

// --- system ----------------------------------------------------------------
{
  assert.deepEqual(messages({ system: 'be brief', messages: [] })[0], { role: 'system', content: 'be brief' })
  // Claude Code sends an array of text blocks with cache_control markers on them.
  const blocks = messages({
    system: [
      { type: 'text', text: 'one', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'two' },
    ],
    messages: [],
  })
  assert.deepEqual(blocks[0], { role: 'system', content: 'one\n\ntwo' })
  // No system at all means no leading message, not an empty one.
  assert.equal(messages({ messages: [{ role: 'user', content: 'hi' }] }).length, 1)
}

// --- text and images -------------------------------------------------------
{
  assert.deepEqual(messages({ messages: [{ role: 'user', content: 'hi' }] }), [{ role: 'user', content: 'hi' }])

  const withImage = messages({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ],
    }],
  })
  assert.deepEqual(withImage, [{
    role: 'user',
    content: [
      { type: 'text', text: 'what is this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ],
  }])
}

// --- tool round trip -------------------------------------------------------
// The whole conversation shape, because this is the part that breaks: Anthropic
// returns tool results inside the *user* turn and OpenAI wants them as their own
// messages, positioned directly after the assistant turn that called them.
{
  const converted = messages({
    messages: [
      { role: 'user', content: 'read the file' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'I should read it', signature: 'sig' },
          { type: 'text', text: 'Reading it now.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: '/tmp/x' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file contents' },
          { type: 'text', text: 'now summarise it' },
        ],
      },
    ],
  })

  assert.deepEqual(converted, [
    { role: 'user', content: 'read the file' },
    {
      role: 'assistant',
      content: 'Reading it now.',
      tool_calls: [{
        id: 'toolu_1',
        type: 'function',
        function: { name: 'Read', arguments: '{"path":"/tmp/x"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'toolu_1', content: 'file contents' },
    { role: 'user', content: [{ type: 'text', text: 'now summarise it' }] },
  ])
}

// A turn that is nothing but tool results contributes no user message, and an
// is_error result has to carry that fact in its text — OpenAI has no flag for it.
{
  const converted = messages({
    messages: [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_9',
        is_error: true,
        content: [{ type: 'text', text: 'ENOENT' }],
      }],
    }],
  })
  assert.deepEqual(converted, [{ role: 'tool', tool_call_id: 'toolu_9', content: 'Error: ENOENT' }])
}

// tool_calls with no text is `content: null`, which is the shape OpenAI documents.
{
  const converted = messages({
    messages: [{
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: {} }],
    }],
  })
  assert.equal(converted[0].content, null)
}

// --- tools, tool_choice, sampling -----------------------------------------
{
  const out = toOpenAIRequest({
    messages: [],
    tools: [
      {
        name: 'Read',
        description: 'read a file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
        cache_control: { type: 'ephemeral' },
        strict: true,
        defer_loading: false,
      },
      // A server-side tool: no input_schema, so the upstream cannot run it for us.
      { type: 'web_search_20250305', name: 'web_search' },
    ],
    tool_choice: { type: 'any', disable_parallel_tool_use: true },
  }, provider(), 'gpt-4o')

  assert.deepEqual(out.tools, [{
    type: 'function',
    function: {
      name: 'Read',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      description: 'read a file',
    },
  }])
  assert.equal(out.tool_choice, 'required')
  assert.equal(out.parallel_tool_calls, false)
}

{
  for (const [anthropic, openai] of [
    [{ type: 'auto' }, 'auto'],
    [{ type: 'none' }, 'none'],
    [{ type: 'any' }, 'required'],
  ]) {
    assert.deepEqual(toOpenAIRequest({ messages: [], tool_choice: anthropic }, provider(), 'm').tool_choice, openai)
  }
  assert.deepEqual(
    toOpenAIRequest({ messages: [], tool_choice: { type: 'tool', name: 'Read' } }, provider(), 'm').tool_choice,
    { type: 'function', function: { name: 'Read' } },
  )
}

// max_tokens lands in the field the provider declares, and nothing Anthropic-only
// survives the rebuild.
{
  const dflt = toOpenAIRequest({ messages: [], max_tokens: 4096 }, provider(), 'gpt-4o')
  assert.equal(dflt.max_completion_tokens, 4096)
  assert.equal('max_tokens' in dflt, false)

  const legacy = toOpenAIRequest({ messages: [], max_tokens: 4096 },
    provider({ openai: { maxTokensField: 'max_tokens' } }), 'gpt-4o')
  assert.equal(legacy.max_tokens, 4096)
  assert.equal('max_completion_tokens' in legacy, false)

  const kitchenSink = toOpenAIRequest({
    messages: [],
    // Claude Code sends every one of these, and no OpenAI-compatible endpoint
    // accepts any of them.
    metadata: { user_id: 'u' },
    context_management: { edits: [] },
    output_config: {},
    thinking: { type: 'adaptive' },
    top_k: 40,
    temperature: 1,
    anthropic_beta: ['x'],
  }, provider(), 'gpt-4o')
  for (const key of ['metadata', 'context_management', 'output_config', 'thinking', 'top_k',
    'anthropic_beta', 'temperature', 'reasoning_effort']) {
    assert.equal(key in kitchenSink, false, `${key} must not reach the upstream`)
  }

  // A temperature the user actually chose is forwarded; 1 is Claude Code's default
  // and the only value Azure's reasoning models accept, so it is dropped.
  assert.equal(toOpenAIRequest({ messages: [], temperature: 0.2 }, provider(), 'm').temperature, 0.2)

  // reasoning_effort is opt-in per provider, because most models reject the field.
  assert.equal(
    toOpenAIRequest({ messages: [], thinking: { type: 'adaptive' } },
      provider({ openai: { reasoningEffort: 'high' } }), 'm').reasoning_effort,
    'high',
  )
}

// Streaming has to ask for usage explicitly or the call reports zero tokens.
{
  const streamed = toOpenAIRequest({ messages: [], stream: true, stop_sequences: ['STOP'] }, provider(), 'm')
  assert.equal(streamed.stream, true)
  assert.deepEqual(streamed.stream_options, { include_usage: true })
  assert.deepEqual(streamed.stop, ['STOP'])

  const unary = toOpenAIRequest({ messages: [] }, provider(), 'm')
  assert.equal('stream' in unary, false)
  assert.equal('stream_options' in unary, false)
}

// --- non-streaming response ------------------------------------------------
{
  const translated = fromOpenAIResponse({
    id: 'chatcmpl-abc',
    choices: [{
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: 'Let me read that.',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'Read', arguments: '{"path":"/tmp/x"}' },
        }],
      },
    }],
    usage: { prompt_tokens: 120, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 100 } },
  }, 'gpt-4o')

  assert.equal(translated.type, 'message')
  assert.equal(translated.role, 'assistant')
  assert.equal(translated.model, 'gpt-4o')
  assert.equal(translated.id, 'msg_chatcmpl-abc')
  assert.equal(translated.stop_reason, 'tool_use')
  assert.equal(translated.stop_sequence, null)
  assert.deepEqual(translated.content, [
    { type: 'text', text: 'Let me read that.' },
    { type: 'tool_use', id: 'call_1', name: 'Read', input: { path: '/tmp/x' } },
  ])
  // Anthropic reports input_tokens excluding cached ones and counts them
  // separately; OpenAI's prompt_tokens includes them. Without the subtraction the
  // prompt is billed twice.
  assert.deepEqual(translated.usage, {
    input_tokens: 20,
    output_tokens: 8,
    cache_read_input_tokens: 100,
  })
}

// finish_reason → stop_reason, including the case that matters most: a server that
// reports 'stop' on a turn that did emit tool calls. Claude Code decides whether to
// run the tool from stop_reason, so getting it wrong drops the call silently.
{
  function reasonFor(finish, withToolCall = false) {
    return fromOpenAIResponse({
      choices: [{
        finish_reason: finish,
        message: withToolCall
          ? { content: '', tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{}' } }] }
          : { content: 'hi' },
      }],
    }, 'm').stop_reason
  }
  assert.equal(reasonFor('stop'), 'end_turn')
  assert.equal(reasonFor('length'), 'max_tokens')
  assert.equal(reasonFor('tool_calls'), 'tool_use')
  assert.equal(reasonFor('function_call'), 'tool_use')
  assert.equal(reasonFor('content_filter'), 'end_turn')
  assert.equal(reasonFor('something_new'), 'end_turn')
  assert.equal(reasonFor('stop', true), 'tool_use', 'a tool call outranks the reported reason')
}

// Degenerate bodies must still produce a parseable Anthropic message rather than
// throwing, because the alternative is a 500 in place of a usable answer.
{
  const empty = fromOpenAIResponse({}, 'm')
  assert.deepEqual(empty.content, [{ type: 'text', text: '' }])
  assert.deepEqual(empty.usage, { input_tokens: 0, output_tokens: 0 })

  const badArgs = fromOpenAIResponse({
    choices: [{ message: { tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{"a":' } }] } }],
  }, 'm')
  assert.deepEqual((badArgs.content )[0].input, {})

  // Some servers return the assistant content as an array of parts.
  const parts = fromOpenAIResponse({
    choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }],
  }, 'm')
  assert.deepEqual(parts.content, [{ type: 'text', text: 'ab' }])
}

// --- errors ----------------------------------------------------------------
// The envelope has to change to be parseable; the message must not, because Claude
// Code matches on upstream wording to auto-retry and to disable a rejected
// capability.
{
  const message = "Unsupported parameter: 'max_tokens' is not supported with this model."
  assert.deepEqual(toAnthropicError({ error: { message, type: 'invalid_request_error', code: 'x' } }, 400), {
    type: 'error',
    error: { type: 'invalid_request_error', message },
  })

  assert.equal(toAnthropicError({ error: { message: 'slow down' } }, 429).error.type, 'rate_limit_error')
  assert.equal(toAnthropicError({ error: { message: 'boom' } }, 502).error.type, 'api_error')

  // Not an envelope we recognise: forward whatever text there was rather than
  // replacing it with a description of our own.
  assert.equal((toAnthropicError('upstream exploded', 500).error ).message,
    'upstream exploded')
  assert.equal((toAnthropicError('', 503).error ).message, 'HTTP 503')
}

// --- count_tokens estimate -------------------------------------------------
{
  assert.ok(estimateInputTokens({ messages: [{ role: 'user', content: 'hi' }] }) >= 1)
  const small = estimateInputTokens({ messages: [{ role: 'user', content: 'hi' }] })
  const large = estimateInputTokens({ messages: [{ role: 'user', content: 'x'.repeat(4000) }] })
  assert.ok(large > small * 10, 'the estimate has to scale with the prompt')
  // A bodyless request still answers with a number rather than throwing.
  assert.ok(estimateInputTokens(undefined) >= 1)
}

// --- streaming -------------------------------------------------------------

/** Split a rendered Anthropic SSE body back into `{event, data}` pairs. */
function parseEvents(sse) {
  return sse
    .split('\n\n')
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const lines = block.split('\n')
      const event = lines.find((l) => l.startsWith('event: '))?.slice(7) ?? ''
      const data = lines.find((l) => l.startsWith('data: '))?.slice(6) ?? '{}'
      return { event, data: JSON.parse(data)  }
    })
}

async function translate(chunks, model = 'gpt-4o') {
  const stream = createOpenAIToAnthropicStream(model, { pingIntervalMs: 60_000 })
  const out = []
  stream.on('data', (chunk) => out.push(String(chunk)))
  for (const chunk of chunks) stream.write(chunk)
  stream.end()
  await once(stream, 'end')
  return parseEvents(out.join(''))
}

// A captured OpenAI stream, chunked the way one actually arrives — including a
// frame split mid-line, which is what the line buffer exists for.
{
  const events = await translate([
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o",'
      + '"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n',
    '\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":2}}\n\n',
    'data: [DONE]\n\n',
  ])

  assert.deepEqual(events.map((e) => e.event), [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ])

  const start = events[0].data.message 
  assert.equal(start.id, 'msg_chatcmpl-1')
  assert.equal(start.model, 'gpt-4o')
  assert.equal(start.role, 'assistant')
  assert.deepEqual(start.content, [])
  assert.equal(start.stop_reason, null)
  // Unknown until the final chunk, so it is corrected in message_delta.
  assert.deepEqual(start.usage, { input_tokens: 0, output_tokens: 0 })

  assert.deepEqual(events[1].data.content_block, { type: 'text', text: '' })
  assert.deepEqual(events[2].data.delta, { type: 'text_delta', text: 'Hel' })
  assert.deepEqual(events[3].data.delta, { type: 'text_delta', text: 'lo' })
  assert.equal(events[4].data.index, 0)
  assert.deepEqual(events[5].data.delta, { stop_reason: 'end_turn', stop_sequence: null })
  // proxy.ts's usage interceptor reads BOTH counts out of this event, because the
  // prompt size cannot be reported any earlier.
  assert.deepEqual(events[5].data.usage, { input_tokens: 11, output_tokens: 2 })
}

// Tool calls: `id` and `name` arrive on the first fragment only, `arguments` stream
// in pieces afterwards, and OpenAI's own tool index has to be mapped onto
// Anthropic's flat content-block index space.
{
  const events = await translate([
    'data: {"id":"c1","choices":[{"delta":{"content":"Reading."}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function",'
      + '"function":{"name":"Read","arguments":""}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"pa"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":1}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","type":"function",'
      + '"function":{"name":"Bash","arguments":"{}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":20,'
      + '"prompt_tokens_details":{"cached_tokens":40}}}\n\n',
    'data: [DONE]\n\n',
  ])

  assert.deepEqual(events.map((e) => e.event), [
    'message_start',
    'content_block_start', 'content_block_delta', 'content_block_stop',    // text, index 0
    'content_block_start', 'content_block_delta', 'content_block_delta',   // tool 0, index 1
    'content_block_stop',
    'content_block_start', 'content_block_delta',                          // tool 1, index 2
    'content_block_stop',
    'message_delta', 'message_stop',
  ])

  assert.deepEqual(events[4].data, {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'call_a', name: 'Read', input: {} },
  })
  // The empty `arguments: ""` on the opening fragment produces no delta of its own.
  assert.deepEqual(events[5].data.delta, { type: 'input_json_delta', partial_json: '{"pa' })
  assert.deepEqual(events[6].data.delta, { type: 'input_json_delta', partial_json: 'th":1}' })
  assert.equal(events[7].data.index, 1)
  assert.deepEqual(events[8].data.content_block, { type: 'tool_use', id: 'call_b', name: 'Bash', input: {} })
  assert.equal(events[8].data.index, 2)
  assert.deepEqual(events[11].data.delta, { stop_reason: 'tool_use', stop_sequence: null })
  assert.deepEqual(events[11].data.usage, {
    input_tokens: 10,
    output_tokens: 20,
    cache_read_input_tokens: 40,
  })
}

// Text after a tool call opens a second text block rather than reopening index 0,
// which Anthropic's format cannot express.
{
  const events = await translate([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"f","arguments":"{}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"after"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  ])
  const starts = events.filter((e) => e.event === 'content_block_start')
  assert.deepEqual(starts.map((e) => e.data.index), [0, 1])
  assert.deepEqual(starts.map((e) => (e.data.content_block ).type), ['tool_use', 'text'])
}

// A stream that carried nothing parseable still owes the client a well-formed
// envelope with one content block — Claude Code reports anything else as a
// malformed response.
{
  const events = await translate(['data: [DONE]\n\n'])
  assert.deepEqual(events.map((e) => e.event), [
    'message_start', 'content_block_start', 'content_block_stop', 'message_delta', 'message_stop',
  ])
  assert.deepEqual(events[1].data.content_block, { type: 'text', text: '' })
}

// Reasoning traces are dropped in v1 (see the note in openai-adapter.ts) but must
// not take the answer with them.
{
  const events = await translate([
    'data: {"choices":[{"delta":{"reasoning_content":"thinking hard"}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning":"more"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
  ])
  const deltas = events.filter((e) => e.event === 'content_block_delta')
  assert.equal(deltas.length, 1)
  assert.deepEqual(deltas[0].data.delta, { type: 'text_delta', text: 'answer' })
}

// An error inside a 200 stream becomes Anthropic's `error` event, so the client
// reports the real upstream failure instead of a parse error.
{
  const events = await translate([
    'data: {"error":{"message":"context length exceeded","type":"invalid_request_error"}}\n\n',
  ])
  const error = events.find((e) => e.event === 'error')
  assert.ok(error)
  assert.deepEqual(error.data, {
    type: 'error',
    error: { type: 'invalid_request_error', message: 'context length exceeded' },
  })
}

// Keep-alive pings during a silent gap. Claude Code counts relayed bytes and aborts
// a stream that delivers none for 300 s, and no OpenAI-compatible upstream pings.
{
  const stream = createOpenAIToAnthropicStream('gpt-4o', { pingIntervalMs: 20 })
  const out = []
  stream.on('data', (chunk) => out.push(String(chunk)))
  stream.write('data: {"id":"c","choices":[{"delta":{"content":"hi"}}]}\n\n')
  await new Promise((resolve) => setTimeout(resolve, 120))
  stream.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
  stream.end()
  await once(stream, 'end')

  const events = parseEvents(out.join(''))
  const pings = events.filter((e) => e.event === 'ping')
  assert.ok(pings.length >= 1, `expected at least one synthesized ping, got ${pings.length}`)
  assert.deepEqual(pings[0].data, { type: 'ping' })
  // The ping must not disturb the envelope around it.
  assert.equal(events[0].event, 'message_start')
  assert.equal(events[events.length - 1].event, 'message_stop')
}
})
