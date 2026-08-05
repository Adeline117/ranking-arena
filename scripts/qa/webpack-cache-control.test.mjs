import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const config = readFileSync(new URL('../../next.config.ts', import.meta.url), 'utf8')
const localSetup = readFileSync(new URL('../../docs/LOCAL_SETUP.md', import.meta.url), 'utf8')

test('webpack cache opt-out is explicit and leaves hosted builds unchanged by default', () => {
  assert.match(
    config,
    /if \(process\.env\.ARENA_DISABLE_WEBPACK_CACHE === ['"]1['"]\) \{\s*config\.cache = false\s*\}/
  )
  assert.equal(config.match(/config\.cache = false/g)?.length, 1)
})

test('local setup documents the recoverable low-disk build path', () => {
  assert.match(localSetup, /Production build fails with `ENOSPC`/)
  assert.match(localSetup, /ARENA_DISABLE_WEBPACK_CACHE=1 npm run build/)
})
