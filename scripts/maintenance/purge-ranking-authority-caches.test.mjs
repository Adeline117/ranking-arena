import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const SCRIPT = resolve(ROOT, 'scripts/maintenance/purge-ranking-authority-caches.sh')
const EXPECTED_TOMBSTONE = "#!/bin/bash\n\nprintf '%s\\n' '[RETIRED] V1 NO-GO.' >&2\nexit 2\n"
const forbiddenCapabilitySyntax =
  /\b(?:vercel|git|curl|wget|ssh|scp|ping|nc|netcat|host|hostname|env|export|source|dotenv)\b|https?:\/\/|\b(?:cache\s+purge|purge\s+cache)\b|\$(?:\{[^}]+\}|\([^)]*\)|[A-Za-z_][A-Za-z0-9_]*)/i

test('ranking authority cache maintenance path is a static V1 tombstone', () => {
  const source = readFileSync(SCRIPT, 'utf8')

  assert.equal(source, EXPECTED_TOMBSTONE)
  assert.notEqual(statSync(SCRIPT).mode & 0o111, 0, 'compatibility path must stay executable')
  assert.doesNotMatch(source, forbiddenCapabilitySyntax)
})
