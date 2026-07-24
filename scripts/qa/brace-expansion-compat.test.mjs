import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const compatPath = '../../worker/vendor/brace-expansion-compat/index.cjs'

function dependencyFrom(consumer) {
  const consumerRequire = createRequire(require.resolve(consumer))
  return {
    minimatch: consumerRequire('minimatch'),
    version: consumerRequire('minimatch/package.json').version,
  }
}

function matches(loaded, path, pattern) {
  const minimatch = typeof loaded === 'function' ? loaded : loaded.minimatch
  assert.equal(typeof minimatch, 'function')
  return minimatch(path, pattern)
}

test('brace-expansion facade preserves callable and named CommonJS exports', () => {
  const legacyExpand = require(compatPath)

  assert.equal(typeof legacyExpand, 'function')
  assert.equal(legacyExpand.expand, legacyExpand)
  assert.deepEqual(legacyExpand('file-{1..3}.txt'), ['file-1.txt', 'file-2.txt', 'file-3.txt'])
  assert.equal(legacyExpand.EXPANSION_MAX, 100_000)
  assert.equal(legacyExpand.EXPANSION_MAX_LENGTH, 4_000_000)
})

test('brace-expansion facade preserves default and named ESM exports', async () => {
  const module = await import('../../worker/vendor/brace-expansion-compat/index.mjs')

  assert.equal(module.default, module.expand)
  assert.deepEqual(module.expand('file-{a,b}.txt'), ['file-a.txt', 'file-b.txt'])
  assert.equal(module.EXPANSION_MAX, 100_000)
  assert.equal(module.EXPANSION_MAX_LENGTH, 4_000_000)
})

test('installed minimatch 3, 9, and 10 consumers retain brace patterns', () => {
  const consumers = [
    dependencyFrom('eslint'),
    { minimatch: require('minimatch'), version: require('minimatch/package.json').version },
    dependencyFrom('glob'),
  ]

  assert.deepEqual(
    consumers.map(({ version }) => Number.parseInt(version, 10)),
    [3, 9, 10]
  )
  for (const { minimatch, version } of consumers) {
    assert.equal(matches(minimatch, 'file.js', '*.{js,ts}'), true, `minimatch ${version}`)
    assert.equal(matches(minimatch, 'file.css', '*.{js,ts}'), false, `minimatch ${version}`)
  }
})

test('facade delegates to the exact patched upstream release', () => {
  const upstream = require('brace-expansion-safe/package.json')

  assert.equal(upstream.name, 'brace-expansion')
  assert.equal(upstream.version, '5.0.8')
})
