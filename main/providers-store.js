'use strict'
/**
 * Reads and writes providers.json — the riskiest file in the app.
 *
 * Five rules, each preventing a specific failure:
 *
 * 1. Write IN PLACE, never temp-file-plus-rename. The gateway's fs.watch binds to
 *    the file's inode; renaming over it makes hot reload go deaf. (The gateway now
 *    re-arms on 'rename' as a backstop, but that is not a licence to rename.)
 * 2. Validate BEFORE writing. A rejected file is silently ignored by the gateway,
 *    which would leave the UI showing state the gateway never adopted.
 * 3. Write a .bak sibling first, so a crash mid-write is recoverable.
 * 4. Conflict guard on mtime+hash, so an external edit is never clobbered.
 * 5. Full API keys never leave this process. The renderer sees masks and sends
 *    back a sentinel for "unchanged".
 */
const { readFileSync, writeFileSync, statSync } = require('node:fs')
const { createHash } = require('node:crypto')
const { providersPath, providersBackupPath, ensureProvidersFile } = require('./paths.js')
const { validateProviders, serializeProviders, normalizeBaseUrl } = require('./schema.js')

/** Renderer sends this back for a key field the user did not touch. */
const UNCHANGED = '__UNCHANGED__'
const MASK_CHAR = '…'

/** Last state read from disk: the source of truth for keys and conflict detection. */
let snapshot = { providers: [], mtimeMs: 0, hash: '' }

function hashOf(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function maskKey(key) {
  if (typeof key !== 'string' || key.length === 0) return '••••'
  if (key.length < 16) return '••••'
  return `${key.slice(0, 6)}${MASK_CHAR}${key.slice(-4)}`
}

/** The shape the renderer sees. Never contains a full key. */
function toPublic(p) {
  return {
    name: p.name,
    baseUrl: p.baseUrl,
    enabled: p.enabled,
    weight: p.weight,
    authStyle: p.authStyle ?? 'x-api-key',
    sanitize: typeof p.sanitize === 'boolean' ? p.sanitize : null,
    apiKeySet: typeof p.apiKey === 'string' && p.apiKey.length > 0,
    apiKeyLength: typeof p.apiKey === 'string' ? p.apiKey.length : 0,
    apiKeyMasked: maskKey(p.apiKey),
  }
}

/** Read + validate from disk, refreshing the snapshot used for keys and conflicts. */
async function read() {
  ensureProvidersFile()
  const path = providersPath()
  const text = readFileSync(path, 'utf-8')
  const stat = statSync(path)

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { ok: false, error: `providers.json is not valid JSON: ${err.message}`, issues: [] }
  }

  const validated = await validateProviders(parsed)
  if (!validated.ok) return validated

  snapshot = { providers: validated.providers, mtimeMs: stat.mtimeMs, hash: hashOf(text) }
  return {
    ok: true,
    providers: validated.providers.map(toPublic),
    version: snapshot.hash,
  }
}

/** True when the file changed underneath us since the last read(). */
function hasExternalChange() {
  try {
    const path = providersPath()
    const stat = statSync(path)
    if (stat.mtimeMs === snapshot.mtimeMs) return false
    // mtime alone is noisy (an in-place rewrite of identical bytes bumps it), so
    // confirm with a content hash before crying conflict.
    return hashOf(readFileSync(path, 'utf-8')) !== snapshot.hash
  } catch {
    return true
  }
}

/**
 * Merge renderer input with the on-disk truth.
 *
 * `apiKey` semantics:
 *   absent / UNCHANGED  → keep the stored key (matched by `originalName`)
 *   ''                  → rejected upstream by the schema, except for passthrough
 *   contains the mask    → rejected; the renderer handed a display value back
 */
function mergeIncoming(incoming) {
  const byName = new Map(snapshot.providers.map((p) => [p.name, p]))

  return incoming.map((raw) => {
    const previous = byName.get(raw.originalName ?? raw.name)
    const authStyle = raw.authStyle ?? previous?.authStyle ?? 'x-api-key'

    const out = {
      name: typeof raw.name === 'string' ? raw.name.trim() : raw.name,
      baseUrl: normalizeBaseUrl(raw.baseUrl),
      enabled: raw.enabled,
      weight: raw.weight,
      authStyle,
    }

    if (typeof raw.sanitize === 'boolean') out.sanitize = raw.sanitize

    // Passthrough injects no credential, so it carries no key at all.
    if (authStyle !== 'passthrough') {
      const supplied = raw.apiKey
      if (supplied === undefined || supplied === null || supplied === UNCHANGED) {
        if (previous && typeof previous.apiKey === 'string') out.apiKey = previous.apiKey
      } else {
        out.apiKey = supplied
      }
    }

    return out
  })
}

function containsMask(providers) {
  return providers.some((p) => typeof p.apiKey === 'string' && p.apiKey.includes(MASK_CHAR))
}

/**
 * Validate, then write .bak followed by an in-place rewrite of providers.json.
 *
 * `ifMatch` is the `version` the renderer last saw; a mismatch means someone else
 * edited the file and the write is refused instead of clobbering it.
 */
async function write(incoming, { ifMatch } = {}) {
  if (!Array.isArray(incoming)) {
    return { ok: false, error: 'expected an array of providers', issues: [] }
  }

  if (hasExternalChange()) {
    return { ok: false, conflict: true, error: 'providers.json changed on disk since it was loaded', issues: [] }
  }
  if (ifMatch && ifMatch !== snapshot.hash) {
    return { ok: false, conflict: true, error: 'stale version — reload before saving', issues: [] }
  }

  const merged = mergeIncoming(incoming)

  if (containsMask(merged)) {
    return {
      ok: false,
      error: 'an API key field still holds its masked display value — retype the key or leave it untouched',
      issues: [],
    }
  }

  const validated = await validateProviders(merged)
  if (!validated.ok) return validated

  const text = serializeProviders(validated.providers)
  const path = providersPath()

  // .bak carries the NEW content, so the failure window is only between the two
  // writes: a crash there leaves a truncated providers.json restorable from .bak.
  writeFileSync(providersBackupPath(), text)
  writeFileSync(path, text)

  const stat = statSync(path)
  snapshot = { providers: validated.providers, mtimeMs: stat.mtimeMs, hash: hashOf(text) }

  return { ok: true, providers: validated.providers.map(toPublic), version: snapshot.hash }
}

/** Full config for one provider, main-process only (used by the prober). */
function rawProvider(name) {
  return snapshot.providers.find((p) => p.name === name) ?? null
}

module.exports = { read, write, rawProvider, toPublic, maskKey, UNCHANGED, MASK_CHAR }
