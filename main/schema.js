'use strict'
/**
 * Provider validation, reusing the gateway's own zod schema rather than a copy.
 *
 * The compiled gateway is ESM and this process is CJS, so it comes in through a
 * dynamic import (cached). This matters: a hand-maintained duplicate would drift,
 * and the whole point is that the app never writes a file the gateway will reject
 * — an invalid write is swallowed by the watcher, so the UI would show a lie.
 */
const { gatewayEntry } = require('./paths.js')
const { pathToFileURL } = require('node:url')
const { join, dirname } = require('node:path')

/** Canonical key order for serializing providers.json. */
const PROVIDER_KEY_ORDER = ['name', 'baseUrl', 'apiKey', 'enabled', 'weight', 'authStyle', 'sanitize']

const AUTH_STYLES = ['x-api-key', 'bearer', 'passthrough']

let schemaPromise = null

function loadSchema() {
  if (!schemaPromise) {
    const configUrl = pathToFileURL(join(dirname(gatewayEntry()), 'config.js')).href
    schemaPromise = import(configUrl).then((m) => {
      if (!m.providersArraySchema) {
        throw new Error('gateway config.js does not export providersArraySchema — rebuild the gateway')
      }
      return m.providersArraySchema
    })
  }
  return schemaPromise
}

/** Trailing slashes produce `//v1/messages` upstream, so normalize on the way in. */
function normalizeBaseUrl(url) {
  return typeof url === 'string' ? url.trim().replace(/\/+$/, '') : url
}

/**
 * Validate a provider array. Resolves `{ ok: true, providers }` with zod's parsed
 * output (defaults applied), or `{ ok: false, error, issues }` where each issue is
 * `{ path, message }` so the renderer can point at the offending row/field.
 */
async function validateProviders(input) {
  let schema
  try {
    schema = await loadSchema()
  } catch (err) {
    return { ok: false, error: `validator unavailable: ${err.message}`, issues: [] }
  }

  const result = schema.safeParse(input)
  if (result.success) return { ok: true, providers: result.data }

  const issues = result.error.issues.map((i) => ({
    path: i.path.join('.'),
    message: i.message,
  }))
  return {
    ok: false,
    error: issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; '),
    issues,
  }
}

/** Stable, diff-friendly serialization: fixed key order, 2-space indent, trailing newline. */
function serializeProviders(providers) {
  const ordered = providers.map((p) => {
    const out = {}
    for (const key of PROVIDER_KEY_ORDER) {
      if (p[key] === undefined || p[key] === null) continue
      out[key] = p[key]
    }
    return out
  })
  return `${JSON.stringify(ordered, null, 2)}\n`
}

module.exports = { validateProviders, serializeProviders, normalizeBaseUrl, PROVIDER_KEY_ORDER, AUTH_STYLES }
