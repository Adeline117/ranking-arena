import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const source = readFileSync(join(process.cwd(), 'scripts/qa/button-sweep.mjs'), 'utf8')
const authSource = readFileSync(join(process.cwd(), 'scripts/qa/auth-button-sweep.mjs'), 'utf8')

test('public entity routes use live API samples instead of retired fixtures', () => {
  assert.doesNotMatch(source, /\/trader\/soul|\/wrapped\/soul|\/u\/arena_bot/)
  assert.match(source, /addDynamic\(\s*'\/trader\/\[handle\]'/)
  assert.match(source, /addDynamic\('\/wrapped\/\[handle\]'/)
  assert.match(source, /addDynamic\('\/u\/\[handle\]'/)
  assert.match(source, /if \(!response\.ok\) throw new Error/)
})

test('the dynamic trader sample participates in the locale sweep', () => {
  assert.match(source, /\{ coreLang: true \}/)
  assert.match(source, /for \(const route of coreLangRoutes\)/)
})

test('the authenticated write sweep has no retired trader fallback', () => {
  assert.doesNotMatch(authSource, /\/trader\/soul/)
  assert.match(authSource, /\?source=\$\{encodeURIComponent\(t0r\.platform\)\}/)
  assert.match(authSource, /不回退历史 fixture/)
})
