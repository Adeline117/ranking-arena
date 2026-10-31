import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const manifest = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '..', '..', 'cloudflare-worker', 'package.json'),
    'utf8'
  )
)

// V1 forbids deploying or tailing the geo proxy. The package exposes only a
// loopback-bound local emulator; publishing needs a separately approved plan.
test('cloudflare-worker package exposes only a local loopback emulator', () => {
  assert.deepEqual(manifest.scripts, { dev: 'wrangler dev --local --ip 127.0.0.1' })
  for (const command of Object.values(manifest.scripts)) {
    assert.doesNotMatch(command, /\b(deploy|publish|tail|secret)\b/)
  }
})
