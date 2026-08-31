'use strict'
/**
 * The gateway source is ESM (`import`/`export`, `.js` specifiers) but this app is
 * CommonJS, so Node would otherwise resolve build/gateway/*.js as CJS and fail on
 * the first `import`. Drop a nested package.json marking just that subtree as ESM.
 *
 * Also verifies the entry point exists, so a broken build fails here rather than
 * at app launch with a confusing "cannot find module".
 */
const { writeFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')

const outDir = join(__dirname, '..', 'build', 'gateway')
const entry = join(outDir, 'index.js')

if (!existsSync(entry)) {
  console.error(`[finalize-gateway-build] expected ${entry} to exist after tsc — build failed`)
  process.exit(1)
}

writeFileSync(join(outDir, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`)
console.log('[finalize-gateway-build] build/gateway marked as ESM')
