import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const root = process.cwd()

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

test('k6 scenarios require an explicit target and production authorization', () => {
  const config = read('k6/config.js')
  assert.match(config, /BASE_URL is required/)
  assert.match(config, /ALLOW_PRODUCTION_LOAD/)
  assert.equal(config.includes('arenafi\\.org'), true)

  for (const path of [
    'k6/smoke-test.js',
    'k6/load-test.js',
    'k6/stress-test.js',
    'k6/api-load-test.js',
  ]) {
    const source = read(path)
    assert.match(source, /import \{ resolveLoadTestBaseUrl \} from '\.\/config\.js'/)
    assert.match(source, /const BASE_URL = resolveLoadTestBaseUrl\(\)/)
    assert.doesNotMatch(source, /__ENV\.BASE_URL\s*\|\|/)
  }
})
