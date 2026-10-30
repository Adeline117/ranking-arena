import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function assertTracked(path) {
  const result = spawnSync('git', ['ls-files', '--error-unmatch', '--', path], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || `${path} must be tracked`)
  assert.equal(result.stdout.trim(), path)
}

test('favicon has one canonical App Router owner', () => {
  const canonical = 'app/favicon.ico'
  const duplicatePublicRoute = 'public/favicon.ico'
  const canonicalMetadata = lstatSync(resolve(root, canonical))
  const layout = readFileSync(resolve(root, 'app/layout.tsx'), 'utf8')

  assert.equal(canonicalMetadata.isSymbolicLink(), false)
  assert.equal(canonicalMetadata.isFile(), true)
  assertTracked(canonical)
  assert.equal(
    lstatSync(resolve(root, duplicatePublicRoute), { throwIfNoEntry: false }),
    undefined,
    `${duplicatePublicRoute} must not duplicate the App Router metadata route`
  )
  assert.match(layout, /url:\s*['"]\/favicon\.ico(?:\?v=\d+)?['"]/)
})
