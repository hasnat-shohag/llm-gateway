import { randomUUID } from 'crypto'
import { Transform } from 'stream'
import type { OpenAIOptions, ProviderConfig } from './types.js'

/**
 * Anthropic Messages ⇄ OpenAI Chat Completions translation.
 *
 * Claude Code speaks one protocol and one only: it POSTs an Anthropic Messages
 * body to `/v1/messages` and parses an Anthropic SSE stream back. A provider
 * marked `compatibility: 'openai'` doesn't understand either, so everything on
 * the way out is rebuilt as a Chat Completions call and everything on the way
 * back is rebuilt as Anthropic events — Claude Code never learns the difference.
 *
 * Every function here is pure (the Transform aside), which is the point: the
 * translation is the part most likely to be wrong, so it is testable without a
 * server, a socket, or a provider.
 *
 * Deliberately dropped, because no OpenAI-compatible endpoint accepts them and
 * forwarding them is a 400: `cache_control` markers, `context_management`,
 * `output_config`, `metadata`, `tool_reference` blocks, tool-schema `strict` and
 * `defer_loading`, `top_k`, and `thinking` blocks in the transcript. The output
 * body is built as an allowlist rather than by deleting keys, so a field Claude
 * Code adds in a future release is dropped by construction instead of leaking.
 */

/** Loose alias for the wire shapes on either side, none of which we own. */
type Json = Record<string, unknown>

function asObject(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Build the chat-completions URL for a provider's `baseUrl`.
 *
 * One rule has to cover four conventions, so it keys off what the path already
 * says rather than off the host:
 *   1. the path already names the endpoint — Azure OpenAI, whose deployment is
 *      part of the path and whose api-version is a required query parameter:
 *      `https://r.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=…`
 *   2. bare host — a local server addressed as `http://127.0.0.1:11434`, which
 *      still wants the `/v1` prefix
 *   3. anything else — `https://api.openai.com/v1`, `https://openrouter.ai/api/v1`
 *
 * Note this differs from a Claude-compatible provider's `baseUrl`, which is the
 * host root because Claude Code supplies `/v1/messages` itself. The two
 * conventions are not interchangeable and the UI says so.
 */
export function openAIChatUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  const path = url.pathname.replace(/\/+$/, '')
  if (path.includes('/chat/completions')) return url.toString()
  url.pathname = path === '' ? '/v1/chat/completions' : `${path}/chat/completions`
  return url.toString()
}

/** True when this provider needs translating rather than relaying. */
export function isTranslated(provider: Pick<ProviderConfig, 'compatibility'>): boolean {
  return (provider.compatibility ?? 'claude') === 'openai'
}

// ---------------------------------------------------------------------------
// Request: Anthropic Messages → OpenAI Chat Completions
// ---------------------------------------------------------------------------

/** Anthropic `system` is a string or an array of text blocks; OpenAI wants one string. */
function flattenSystem(system: unknown): string | null {
  const direct = asString(system)
  if (direct !== undefined) return direct.length > 0 ? direct : null
  const texts: string[] = []
  for (const entry of asArray(system)) {
    const block = asObject(entry)
    const text = asString(block?.text)
    if (block?.type === 'text' && text) texts.push(text)
  }
  return texts.length > 0 ? texts.join('\n\n') : null
}

/** A `tool_result`'s content is a string or a block array; OpenAI tool messages take text. */
function flattenToolResult(block: Json): string {
  const direct = asString(block.content)
  const text = direct !== undefined
    ? direct
    : asArray(block.content)
        .map((entry) => asObject(entry))
        .filter((b): b is Json => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('\n')
  // OpenAI has no error flag on a tool message, so the only way to preserve
  // Anthropic's `is_error` is in the text the model reads.
  return block.is_error === true ? `Error: ${text}` : text
}

/** Anthropic image blocks carry base64 or a URL; OpenAI takes a data: URL either way. */
function imageUrl(source: Json | null): string | undefined {
  if (!source) return undefined
  if (source.type === 'url') return asString(source.url)
  const data = asString(source.data)
  if (source.type === 'base64' && data) {
    return `data:${asString(source.media_type) ?? 'image/png'};base64,${data}`
  }
  return undefined
}

/**
 * Convert one Anthropic message into the one-or-more OpenAI messages it becomes.
 *
 * The asymmetry that makes this a fan-out rather than a map: Anthropic returns
 * tool results as `tool_result` blocks inside the *user* turn, while OpenAI wants
 * them as separate `role:'tool'` messages placed directly after the assistant turn
 * that made the calls. Emitting the tool messages first and the leftover user
 * content after is what lands them in that position, because the user turn
 * carrying them always immediately follows the assistant turn that called them.
 */
function convertMessage(message: Json, out: Json[]): void {
  const role = message.role === 'assistant' ? 'assistant' : 'user'
  const direct = asString(message.content)

  if (direct !== undefined) {
    out.push({ role, content: direct })
    return
  }

  const blocks = asArray(message.content).map((b) => asObject(b)).filter((b): b is Json => b !== null)

  if (role === 'assistant') {
    let text = ''
    const toolCalls: Json[] = []
    for (const block of blocks) {
      if (block.type === 'text') text += asString(block.text) ?? ''
      else if (block.type === 'tool_use') {
        toolCalls.push({
          id: asString(block.id) ?? `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
          type: 'function',
          function: {
            name: asString(block.name) ?? '',
            arguments: JSON.stringify(block.input ?? {}),
          },
        })
      }
      // `thinking` / `redacted_thinking`: dropped. They are signed by Anthropic and
      // meaningless to any other upstream, and re-sending one is what makes a
      // resumed conversation 400 rather than merely lose the trace.
    }
    // `content: null` alongside tool_calls is the canonical OpenAI shape; an empty
    // string is not accepted there by every server.
    out.push(toolCalls.length > 0
      ? { role, content: text.length > 0 ? text : null, tool_calls: toolCalls }
      : { role, content: text })
    return
  }

  const parts: Json[] = []
  for (const block of blocks) {
    if (block.type === 'tool_result') {
      out.push({
        role: 'tool',
        tool_call_id: asString(block.tool_use_id) ?? '',
        content: flattenToolResult(block),
      })
    } else if (block.type === 'text') {
      const text = asString(block.text)
      if (text) parts.push({ type: 'text', text })
    } else if (block.type === 'image') {
      const url = imageUrl(asObject(block.source))
      if (url) parts.push({ type: 'image_url', image_url: { url } })
    }
    // `document` (PDF) blocks are dropped: OpenAI's chat API has no equivalent part.
  }
  // A turn that was nothing but tool results contributes no user message at all,
  // which is correct — the tool messages above already carry it.
  if (parts.length > 0) out.push({ role, content: parts })
}

/** Anthropic tools carry `input_schema`; the server-tool entries that don't aren't functions. */
function convertTools(tools: unknown): Json[] | undefined {
  const converted: Json[] = []
  for (const entry of asArray(tools)) {
    const tool = asObject(entry)
    const name = asString(tool?.name)
    // No `input_schema` means a server-side tool (`web_search_…`) or a
    // `tool_reference`, neither of which the upstream can run for us.
    if (!tool || !name || !asObject(tool.input_schema)) continue
    const fn: Json = { name, parameters: tool.input_schema }
    const description = asString(tool.description)
    if (description) fn.description = description
    converted.push({ type: 'function', function: fn })
  }
  return converted.length > 0 ? converted : undefined
}

function convertToolChoice(choice: Json | null): unknown {
  switch (choice?.type) {
    case 'auto': return 'auto'
    case 'any': return 'required'
    case 'none': return 'none'
    case 'tool': {
      const name = asString(choice.name)
      return name ? { type: 'function', function: { name } } : 'auto'
    }
    default: return undefined
  }
}

/**
 * Rebuild an Anthropic Messages body as an OpenAI Chat Completions body.
 *
 * `model` is the name the client asked for, forwarded verbatim: Claude Code is
 * pointed at this provider by its `ANTHROPIC_MODEL`, so the name it sends is the
 * name the upstream must answer to.
 */
export function toOpenAIRequest(body: unknown, provider: ProviderConfig, model: string): Json {
  const source = asObject(body) ?? {}
  const opts: OpenAIOptions = provider.openai ?? {}

  const messages: Json[] = []
  const system = flattenSystem(source.system)
  if (system) messages.push({ role: 'system', content: system })
  for (const entry of asArray(source.messages)) {
    const message = asObject(entry)
    if (message) convertMessage(message, messages)
  }

  const out: Json = { model, messages }

  // Reasoning models on OpenAI and Azure reject `max_tokens` outright and require
  // `max_completion_tokens`, which every current non-reasoning model also accepts —
  // hence the default. Older local servers only know `max_tokens`.
  if (typeof source.max_tokens === 'number') {
    out[opts.maxTokensField ?? 'max_completion_tokens'] = source.max_tokens
  }

  // Claude Code sends temperature 1 by default, and 1 is the only value Azure's
  // reasoning models accept — so omitting it at 1 removes a class of 400s without
  // adding a knob, and still forwards a temperature the user actually chose.
  if (typeof source.temperature === 'number' && source.temperature !== 1) {
    out.temperature = source.temperature
  }
  if (typeof source.top_p === 'number') out.top_p = source.top_p
  // `top_k` has no OpenAI equivalent and is dropped.

  const stop = asArray(source.stop_sequences).filter((s): s is string => typeof s === 'string')
  if (stop.length > 0) out.stop = stop

  const tools = convertTools(source.tools)
  if (tools) out.tools = tools
  const toolChoice = convertToolChoice(asObject(source.tool_choice))
  if (toolChoice !== undefined) out.tool_choice = toolChoice
  if (asObject(source.tool_choice)?.disable_parallel_tool_use === true) {
    out.parallel_tool_calls = false
  }

  // Claude Code asks for extended thinking with `thinking: {type:'adaptive'|'enabled'}`.
  // The nearest OpenAI concept is reasoning_effort, which only some models accept —
  // so it is opt-in per provider rather than inferred, and the request is otherwise
  // sent without it.
  if (asObject(source.thinking) && opts.reasoningEffort) {
    out.reasoning_effort = opts.reasoningEffort
  }

  if (source.stream === true) {
    out.stream = true
    // The only way to get token counts out of a streamed Chat Completions call.
    // Without it the usage interceptor records nothing and the call costs $0.
    out.stream_options = { include_usage: true }
  }

  return out
}

/** Rough prompt-token estimate for answering `count_tokens` locally. */
export function estimateInputTokens(body: unknown): number {
  const source = asObject(body) ?? {}
  // Everything the model will read, which is what the client is asking about.
  const text = JSON.stringify([source.system ?? null, source.messages ?? [], source.tools ?? []])
  // ~4 characters per token is the usual English rule of thumb. This is an
  // estimate and cannot be otherwise: tokenising correctly would mean shipping the
  // upstream's tokeniser, and the alternative — proxying to a `/count_tokens`
  // endpoint no OpenAI-compatible server has — is a guaranteed 404.
  return Math.max(1, Math.ceil(text.length / 4))
}

// ---------------------------------------------------------------------------
// Response: OpenAI Chat Completions → Anthropic Messages
// ---------------------------------------------------------------------------

/** Anthropic message ids are `msg_…`; keep the upstream's id inside ours for tracing. */
function messageId(upstream: unknown): string {
  const id = asString(upstream)
  if (id && id.startsWith('msg_')) return id
  return `msg_${id ?? randomUUID().replace(/-/g, '').slice(0, 24)}`
}

/**
 * `finish_reason` → `stop_reason`.
 *
 * `hasToolUse` overrides the mapping because several OpenAI-compatible servers
 * report `stop` on a turn that did emit tool calls. Anthropic's contract is that a
 * turn containing a `tool_use` block ends with `stop_reason: 'tool_use'`, and
 * Claude Code decides whether to run the tool from that field — get it wrong and
 * the tool call is silently ignored.
 */
function mapStopReason(finishReason: unknown, hasToolUse: boolean): string {
  if (hasToolUse) return 'tool_use'
  switch (finishReason) {
    case 'length': return 'max_tokens'
    case 'tool_calls':
    case 'function_call': return 'tool_use'
    case 'stop':
    case 'content_filter':
    default: return 'end_turn'
  }
}

function parseToolArguments(raw: unknown): Json {
  const text = asString(raw)
  if (!text) return {}
  try {
    return asObject(JSON.parse(text)) ?? {}
  } catch {
    // A truncated or malformed argument string would otherwise throw here and turn
    // a usable answer into a 500. An empty input lets Claude Code report the tool
    // failing rather than the gateway failing.
    return {}
  }
}

/**
 * Anthropic reports `input_tokens` *excluding* cached tokens and counts them
 * separately; OpenAI's `prompt_tokens` includes them. Subtracting keeps the
 * gateway's cost arithmetic (and Claude Code's context display) honest.
 */
function mapUsage(usage: Json | null): Json {
  const prompt = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : 0
  const completion = typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : 0
  const details = asObject(usage?.prompt_tokens_details)
  const cached = typeof details?.cached_tokens === 'number' ? details.cached_tokens : 0
  const out: Json = {
    input_tokens: Math.max(0, prompt - cached),
    output_tokens: completion,
  }
  if (cached > 0) out.cache_read_input_tokens = cached
  return out
}

/** Non-streaming translation, used when the client sent `stream: false`. */
export function fromOpenAIResponse(json: unknown, model: string): Json {
  const source = asObject(json) ?? {}
  const choice = asObject(asArray(source.choices)[0])
  const message = asObject(choice?.message)

  const content: Json[] = []
  const text = asString(message?.content)
  if (text) content.push({ type: 'text', text })
  else {
    // Some servers return the assistant content as an array of parts.
    const joined = asArray(message?.content)
      .map((part) => asString(asObject(part)?.text))
      .filter((t): t is string => Boolean(t))
      .join('')
    if (joined) content.push({ type: 'text', text: joined })
  }

  for (const entry of asArray(message?.tool_calls)) {
    const call = asObject(entry)
    if (!call) continue
    const fn = asObject(call.function)
    content.push({
      type: 'tool_use',
      id: asString(call.id) ?? `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      name: asString(fn?.name) ?? '',
      input: parseToolArguments(fn?.arguments),
    })
  }

  // Claude Code parses `content[0]`; an empty array is not a shape it expects.
  if (content.length === 0) content.push({ type: 'text', text: '' })

  return {
    id: messageId(source.id),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapStopReason(choice?.finish_reason, content.some((b) => b.type === 'tool_use')),
    stop_sequence: null,
    usage: mapUsage(asObject(source.usage)),
  }
}

/**
 * Convert an OpenAI error body into Anthropic's envelope, copying the upstream
 * message **verbatim**.
 *
 * Claude Code matches on the wording of an upstream error to auto-retry and to
 * disable a rejected capability, so the text has to survive intact even though the
 * envelope around it has to change to be parseable at all.
 */
export function toAnthropicError(payload: unknown, statusCode: number): Json {
  const source = asObject(payload)
  const error = asObject(source?.error)
  const message =
    asString(error?.message) ??
    asString(source?.message) ??
    // Not JSON, or an envelope we don't recognise: forward whatever text there was
    // rather than replacing it with a description of our own.
    (typeof payload === 'string' && payload.trim() ? payload.trim() : `HTTP ${statusCode}`)
  return {
    type: 'error',
    error: {
      type: asString(error?.type) ?? anthropicErrorType(statusCode),
      message,
    },
  }
}

function anthropicErrorType(statusCode: number): string {
  if (statusCode === 400) return 'invalid_request_error'
  if (statusCode === 401) return 'authentication_error'
  if (statusCode === 403) return 'permission_error'
  if (statusCode === 404) return 'not_found_error'
  if (statusCode === 413) return 'request_too_large'
  if (statusCode === 429) return 'rate_limit_error'
  if (statusCode >= 500) return 'api_error'
  return 'invalid_request_error'
}

// ---------------------------------------------------------------------------
// Streaming: OpenAI SSE → Anthropic SSE
// ---------------------------------------------------------------------------

export interface OpenAIStreamOptions {
  /**
   * How long the stream may be silent before a keep-alive `ping` is synthesized.
   * Claude Code counts relayed bytes and aborts a stream that delivers none for
   * 300 s; OpenAI-compatible upstreams send no keep-alives of their own, so a long
   * reasoning pause on the upstream reads as a dead connection without this.
   */
  pingIntervalMs?: number
  onWarn?: (message: string, detail?: Record<string, unknown>) => void
}

/**
 * A Transform that reads an OpenAI SSE stream and writes an Anthropic one.
 *
 * The same shape as `createUsageInterceptor` in proxy.ts — a Transform in the
 * response pipeline — except that this one rewrites rather than observes. Usage
 * still comes out of the translated stream, so the interceptor stays downstream of
 * it and needs no knowledge of this protocol.
 *
 * Block indices are allocated here rather than mirrored from upstream: OpenAI
 * numbers tool calls in their own sequence and says nothing about text, while
 * Anthropic wants one flat, gapless index space over both.
 */
export function createOpenAIToAnthropicStream(model: string, options: OpenAIStreamOptions = {}): Transform {
  const pingIntervalMs = options.pingIntervalMs ?? 15_000
  const warn = options.onWarn ?? (() => {})

  let lineBuffer = ''
  let started = false
  let finished = false
  let id = messageId(undefined)
  let nextIndex = 0
  let current: { kind: 'text' | 'tool'; index: number; oaIndex?: number } | null = null
  const toolBlocks = new Set<number>()
  let finishReason: unknown
  let usage: Json = { input_tokens: 0, output_tokens: 0 }
  let lastPushAt = Date.now()
  let pingTimer: NodeJS.Timeout | null = null

  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const text = lineBuffer + chunk.toString('utf8')
      const lines = text.split('\n')
      lineBuffer = lines.pop() ?? ''
      for (const line of lines) handleLine(line.replace(/\r$/, ''))
      callback()
    },
    flush(callback) {
      if (lineBuffer) handleLine(lineBuffer.replace(/\r$/, ''))
      finish()
      callback()
    },
    destroy(err, callback) {
      stopPings()
      callback(err)
    },
  })

  const send = (event: string, data: Json) => {
    if (finished) return
    lastPushAt = Date.now()
    stream.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  const stopPings = () => {
    if (pingTimer) clearInterval(pingTimer)
    pingTimer = null
  }

  const startPings = () => {
    if (pingTimer) return
    pingTimer = setInterval(() => {
      if (finished || Date.now() - lastPushAt < pingIntervalMs) return
      send('ping', { type: 'ping' })
    }, pingIntervalMs)
    // The gateway must still be able to exit while a stream is idle.
    pingTimer.unref()
  }

  const ensureStart = (source?: Json) => {
    if (started) return
    started = true
    if (source?.id) id = messageId(source.id)
    startPings()
    send('message_start', {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        // Real values are unknown until the final chunk — OpenAI reports prompt
        // tokens only once, at the end — so they are corrected in `message_delta`.
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
  }

  const closeCurrent = () => {
    if (!current) return
    send('content_block_stop', { type: 'content_block_stop', index: current.index })
    current = null
  }

  const openBlock = (kind: 'text' | 'tool', block: Json, oaIndex?: number) => {
    closeCurrent()
    const index = nextIndex++
    send('content_block_start', { type: 'content_block_start', index, content_block: block })
    current = { kind, index, oaIndex }
    if (oaIndex !== undefined) toolBlocks.add(oaIndex)
  }

  const handleTextDelta = (text: string) => {
    if (current?.kind !== 'text') openBlock('text', { type: 'text', text: '' })
    send('content_block_delta', {
      type: 'content_block_delta',
      index: current!.index,
      delta: { type: 'text_delta', text },
    })
  }

  const handleToolCall = (entry: Json) => {
    const oaIndex = typeof entry.index === 'number' ? entry.index : 0
    const fn = asObject(entry.function)

    if (current?.kind !== 'tool' || current.oaIndex !== oaIndex) {
      if (toolBlocks.has(oaIndex)) {
        // A fragment for a tool call whose block we already closed. Anthropic's
        // format cannot reopen a block, so this would need every tool call buffered
        // to the end of the stream — which would stall each one behind the whole
        // generation. OpenAI, Azure and OpenRouter all stream a call's fragments
        // contiguously, so this is reported rather than designed around.
        warn('openai stream sent a tool-call fragment out of order — dropped', { oaIndex })
        return
      }
      // `id` and `function.name` arrive only on a call's first fragment.
      openBlock('tool', {
        type: 'tool_use',
        id: asString(entry.id) ?? `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        name: asString(fn?.name) ?? '',
        input: {},
      }, oaIndex)
    }

    const args = asString(fn?.arguments)
    // The first fragment usually carries `arguments: ""`; an empty delta is noise.
    if (args) {
      send('content_block_delta', {
        type: 'content_block_delta',
        index: current!.index,
        delta: { type: 'input_json_delta', partial_json: args },
      })
    }
  }

  const handleChunk = (source: Json) => {
    // An error can arrive inside a 200 stream. Anthropic has an `error` event for
    // exactly this, and forwarding it is what lets Claude Code report the real
    // upstream failure instead of "malformed response".
    if (asObject(source.error)) {
      ensureStart(source)
      send('error', toAnthropicError(source, 500))
      return
    }

    ensureStart(source)

    // `usage` rides the final chunk (with an empty `choices`), which is why
    // stream_options.include_usage is set on the way out.
    const chunkUsage = asObject(source.usage)
    if (chunkUsage) usage = mapUsage(chunkUsage)

    const choice = asObject(asArray(source.choices)[0])
    if (!choice) return
    if (choice.finish_reason) finishReason = choice.finish_reason

    const delta = asObject(choice.delta)
    if (!delta) return

    const text = asString(delta.content)
    if (text) handleTextDelta(text)

    // `delta.reasoning_content` (DeepSeek) and `delta.reasoning` (OpenRouter) are
    // dropped in v1: an Anthropic `thinking` block carries a signature Anthropic
    // issues, and emitting unsigned ones risks Claude Code echoing a block back
    // that the upstream then rejects. The text of the answer is unaffected.

    for (const entry of asArray(delta.tool_calls)) {
      const call = asObject(entry)
      if (call) handleToolCall(call)
    }
  }

  const handleLine = (line: string) => {
    if (!line.startsWith('data:')) return          // `event:` lines and blank separators
    const raw = line.slice(5).trim()
    if (raw === '' || raw === '[DONE]') return
    try {
      const parsed = asObject(JSON.parse(raw))
      if (parsed) handleChunk(parsed)
    } catch {
      // Not JSON — skip the line rather than fail the stream.
    }
  }

  const finish = () => {
    if (finished) return
    // A stream that produced no parsable chunk still owes the client a well-formed
    // envelope; without one Claude Code reports a malformed response.
    ensureStart()
    // Claude Code expects at least one content block, as every Anthropic stream has.
    if (nextIndex === 0) openBlock('text', { type: 'text', text: '' })
    closeCurrent()
    send('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: mapStopReason(finishReason, toolBlocks.size > 0),
        stop_sequence: null,
      },
      // Anthropic normally reports only output_tokens here. The input count has to
      // ride along too, because it is not knowable at message_start time — see
      // proxy.ts's parseLine, which reads both from this event.
      usage,
    })
    send('message_stop', { type: 'message_stop' })
    finished = true
    stopPings()
  }

  return stream
}
