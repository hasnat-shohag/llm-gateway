'use strict'
/**
 * providers-store.js — reading, masking, merging and writing providers.json.
 *
 * The file is seeded directly into the temp userData dir before the first read so
 * `ensureProvidersFile()` never migrates the developer's real providers.json (with
 * real keys) into the test sandbox.
 */
const stub = require('./helpers/electron-stub.js').install()

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync, writeFileSync, existsSync, statSync, utimesSync, rmSync } = require('node:fs')

const paths = require('../main/paths.js')
const store = require('../main/providers-store.js')

const KEY_A = 'sk-aaaaaaaaaaaaaaaaaaaa1234'
const KEY_B = 'sk-bbbbbbbbbbbbbbbbbbbb5678'

const SEED = [
  { name: 'alpha', baseUrl: 'https://alpha.example.com', apiKey: KEY_A, enabled: true, weight: 1 },
  { name: 'beta', baseUrl: 'https://beta.example.com', apiKey: KEY_B, enabled: false, weight: 3, authStyle: 'bearer' },
  { name: 'official', baseUrl: 'https://api.anthropic.com', enabled: true, weight: 1, authStyle: 'passthrough' },
]

function seed(providers = SEED) {
  const path = paths.providersPath() // creates userData/ as a side effect
  writeFileSync(path, `${JSON.stringify(providers, null, 2)}\n`)
  return path
}

/** The renderer's edit payload: masks replaced by the sentinel, plus originalName. */
function asIncoming(publicProviders, patch = {}) {
  return publicProviders.map((p) => ({
    name: p.name,
    originalName: p.name,
    baseUrl: p.baseUrl,
    enabled: p.enabled,
    weight: p.weight,
    authStyle: p.authStyle,
    ...(p.apiKeySet ? { apiKey: store.UNCHANGED } : {}),
    ...(patch[p.name] ?? {}),
  }))
}

test('read masks keys and never exposes a full one', async () => {
  seed()
  const result = await store.read()
  assert.equal(result.ok, true)

  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes(KEY_A), false)
  assert.equal(serialized.includes(KEY_B), false)

  const alpha = result.providers.find((p) => p.name === 'alpha')
  assert.equal(alpha.apiKeySet, true)
  assert.equal(alpha.apiKeyLength, KEY_A.length)
  assert.equal(alpha.apiKeyMasked, `${KEY_A.slice(0, 6)}${store.MASK_CHAR}${KEY_A.slice(-4)}`)

  // Passthrough carries no key of its own.
  const official = result.providers.find((p) => p.name === 'official')
  assert.equal(official.apiKeySet, false)
  assert.equal(official.apiKeyMasked, '••••')
})

test('read reports invalid JSON instead of throwing', async () => {
  writeFileSync(paths.providersPath(), '{ not json')
  const result = await store.read()
  assert.equal(result.ok, false)
  assert.match(result.error, /not valid JSON/)
})

test('write keeps the stored key when the renderer sends the sentinel', async () => {
  seed()
  const before = await store.read()

  const result = await store.write(asIncoming(before.providers, { alpha: { enabled: false } }), {
    ifMatch: before.version,
  })
  assert.equal(result.ok, true)

  const onDisk = JSON.parse(readFileSync(paths.providersPath(), 'utf-8'))
  assert.equal(onDisk.find((p) => p.name === 'alpha').apiKey, KEY_A)
  assert.equal(onDisk.find((p) => p.name === 'alpha').enabled, false)
  assert.equal(onDisk.find((p) => p.name === 'beta').apiKey, KEY_B)
})

test('write carries the key across a rename via originalName', async () => {
  seed()
  const before = await store.read()
  const incoming = asIncoming(before.providers).map((p) =>
    p.originalName === 'alpha' ? { ...p, name: 'alpha-renamed' } : p)

  const result = await store.write(incoming, { ifMatch: before.version })
  assert.equal(result.ok, true)

  const onDisk = JSON.parse(readFileSync(paths.providersPath(), 'utf-8'))
  assert.equal(onDisk.find((p) => p.name === 'alpha-renamed').apiKey, KEY_A)
  assert.equal(onDisk.some((p) => p.name === 'alpha'), false)
})

test('write drops the key for a provider switched to passthrough', async () => {
  seed()
  const before = await store.read()
  const result = await store.write(asIncoming(before.providers, { alpha: { authStyle: 'passthrough' } }), {
    ifMatch: before.version,
  })
  assert.equal(result.ok, true)

  const onDisk = JSON.parse(readFileSync(paths.providersPath(), 'utf-8'))
  assert.equal('apiKey' in onDisk.find((p) => p.name === 'alpha'), false)
})

test('write normalizes a trailing slash in baseUrl', async () => {
  seed()
  const before = await store.read()
  const result = await store.write(asIncoming(before.providers, { alpha: { baseUrl: 'https://alpha.example.com/' } }), {
    ifMatch: before.version,
  })
  assert.equal(result.ok, true)
  assert.equal(result.providers.find((p) => p.name === 'alpha').baseUrl, 'https://alpha.example.com')
})

test('write refuses a masked display value handed back as a key', async () => {
  seed()
  const before = await store.read()
  const alpha = before.providers.find((p) => p.name === 'alpha')

  const result = await store.write(asIncoming(before.providers, { alpha: { apiKey: alpha.apiKeyMasked } }), {
    ifMatch: before.version,
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /masked display value/)
  // Nothing was written.
  assert.equal(JSON.parse(readFileSync(paths.providersPath(), 'utf-8')).find((p) => p.name === 'alpha').apiKey, KEY_A)
})

test('write refuses a stale version', async () => {
  seed()
  const before = await store.read()
  const result = await store.write(asIncoming(before.providers), { ifMatch: 'not-the-current-hash' })
  assert.equal(result.ok, false)
  assert.equal(result.conflict, true)
})

test('write refuses when the file changed on disk since the last read', async () => {
  seed()
  const before = await store.read()

  // An external edit: different content, so the mtime+hash guard trips.
  writeFileSync(paths.providersPath(), `${JSON.stringify(SEED.slice(0, 1), null, 2)}\n`)

  const result = await store.write(asIncoming(before.providers), { ifMatch: before.version })
  assert.equal(result.ok, false)
  assert.equal(result.conflict, true)
  assert.match(result.error, /changed on disk/)
})

test('an in-place rewrite of identical bytes is not treated as a conflict', async () => {
  seed()
  const before = await store.read()
  const path = paths.providersPath()

  // mtime alone is noisy; the hash check is what keeps this from crying conflict.
  const text = readFileSync(path, 'utf-8')
  const future = new Date(Date.now() + 5000)
  writeFileSync(path, text)
  utimesSync(path, future, future)

  const result = await store.write(asIncoming(before.providers), { ifMatch: before.version })
  assert.equal(result.ok, true)
})

test('write rejects invalid input without touching the file', async () => {
  seed()
  const before = await store.read()
  const path = paths.providersPath()
  const original = readFileSync(path, 'utf-8')

  const result = await store.write(asIncoming(before.providers, { alpha: { baseUrl: 'nope' } }), {
    ifMatch: before.version,
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.issues.map((i) => i.path), ['0.baseUrl'])
  assert.equal(readFileSync(path, 'utf-8'), original)
})

test('write writes a .bak sibling and keeps the file inode stable', async () => {
  seed()
  const before = await store.read()
  const path = paths.providersPath()
  const inodeBefore = statSync(path).ino

  const result = await store.write(asIncoming(before.providers, { beta: { weight: 7 } }), { ifMatch: before.version })
  assert.equal(result.ok, true)

  assert.equal(existsSync(paths.providersBackupPath()), true)
  assert.equal(readFileSync(paths.providersBackupPath(), 'utf-8'), readFileSync(path, 'utf-8'))
  // The gateway's fs.watch binds to the inode: a temp-file+rename would break
  // hot reload, so the write must land on the same inode.
  assert.equal(statSync(path).ino, inodeBefore)
})

test('write returns a fresh version that the next write accepts', async () => {
  seed()
  const first = await store.read()
  const afterWrite = await store.write(asIncoming(first.providers, { beta: { weight: 5 } }), {
    ifMatch: first.version,
  })
  assert.equal(afterWrite.ok, true)
  assert.notEqual(afterWrite.version, first.version)

  const second = await store.write(asIncoming(afterWrite.providers, { beta: { weight: 6 } }), {
    ifMatch: afterWrite.version,
  })
  assert.equal(second.ok, true)
})

test('rawProvider exposes the full key to the main process only', async () => {
  seed()
  await store.read()
  assert.equal(store.rawProvider('alpha').apiKey, KEY_A)
  assert.equal(store.rawProvider('nope'), null)
})

test('maskKey never leaks a short key', () => {
  assert.equal(store.maskKey('short'), '••••')
  assert.equal(store.maskKey(''), '••••')
  assert.equal(store.maskKey(undefined), '••••')
})

test('hasEnabledPassthrough reads the file, not the snapshot', () => {
  seed() // SEED's 'official' entry is passthrough and enabled
  assert.equal(store.hasEnabledPassthrough(), true)

  seed(SEED.map((p) => (p.authStyle === 'passthrough' ? { ...p, enabled: false } : p)))
  assert.equal(store.hasEnabledPassthrough(), false)

  seed(SEED.filter((p) => p.authStyle !== 'passthrough'))
  assert.equal(store.hasEnabledPassthrough(), false)
})

test('hasEnabledPassthrough answers true when it cannot tell, and false when there is no file', () => {
  // Unknown has to read as "yes": claude-settings.js would otherwise overwrite a
  // live subscription credential with a placeholder.
  writeFileSync(paths.providersPath(), '{ broken')
  assert.equal(store.hasEnabledPassthrough(), true)

  writeFileSync(paths.providersPath(), '{"not":"an array"}')
  assert.equal(store.hasEnabledPassthrough(), true)

  rmSync(paths.providersPath(), { force: true })
  assert.equal(store.hasEnabledPassthrough(), false)
})

test('the temp sandbox is what was used, not the real userData', () => {
  assert.ok(paths.providersPath().startsWith(stub.userData))
})
