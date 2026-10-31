import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..', '..')

// Everything under public/ is served verbatim as a static file, so test
// sources and fixtures must never live there.
test('public/ contains no test sources', () => {
  const tracked = execFileSync('git', ['ls-files', '--', 'public'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
  const leaked = tracked.filter((file) =>
    /(^|\/)(__tests__|__mocks__|__fixtures__)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(file)
  )
  assert.deepEqual(leaked, [])
})
