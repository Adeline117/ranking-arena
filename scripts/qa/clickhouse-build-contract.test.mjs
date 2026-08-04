import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const [clientSource, dualWriteSource, nextConfigSource, packageSource] = await Promise.all([
  readFile(new URL('../../lib/analytics/clickhouse.ts', import.meta.url), 'utf8'),
  readFile(new URL('../../lib/analytics/dual-write.ts', import.meta.url), 'utf8'),
  readFile(new URL('../../next.config.ts', import.meta.url), 'utf8'),
  readFile(new URL('../../package.json', import.meta.url), 'utf8'),
])

const packageJson = JSON.parse(packageSource)

test('ClickHouse uses a statically analyzable lazy import and a declared runtime dependency', () => {
  assert.match(clientSource, /await import\(['"]@clickhouse\/client['"]\)/)
  assert.doesNotMatch(clientSource, /\brequire\s*\(/)
  assert.equal(packageJson.dependencies?.['@clickhouse/client'], '^1.12.1')
})

test('Next keeps the server client traceable instead of globally stubbing or ignoring it', () => {
  const turbopackAliases = nextConfigSource.slice(
    nextConfigSource.indexOf('turbopack:'),
    nextConfigSource.indexOf('// Webpack config')
  )
  const ignorePlugin = nextConfigSource.match(/new webpack\.IgnorePlugin\([\s\S]*?\n\s*\}\)\n/)?.[0]

  assert.doesNotMatch(turbopackAliases, /@clickhouse\/client/)
  assert.ok(ignorePlugin, 'webpack IgnorePlugin policy must remain explicit')
  assert.doesNotMatch(ignorePlugin, /@clickhouse\\\/client/)
  assert.match(nextConfigSource, /serverExternalPackages:\s*\[[\s\S]*?['"]@clickhouse\/client['"]/)
})

test('the low-level client surfaces configured failures at the dual-write boundary', () => {
  assert.match(clientSource, /throw error/)
  assert.match(dualWriteSource, /catch \(err\)/)
  assert.match(dualWriteSource, /Failed to sync/)
})
