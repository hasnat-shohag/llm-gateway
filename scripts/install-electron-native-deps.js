#!/usr/bin/env node

const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const betterSqlite3Package = require.resolve('better-sqlite3/package.json')
const rebuildMarker = path.join(
  path.dirname(betterSqlite3Package),
  'build',
  'Release',
  '.forge-meta'
)

fs.rmSync(rebuildMarker, { force: true })

const electronBuilder = require.resolve('electron-builder/cli.js')
const result = spawnSync(process.execPath, [electronBuilder, 'install-app-deps'], {
  stdio: 'inherit',
})

if (result.error) {
  throw result.error
}

process.exit(result.status ?? 1)
