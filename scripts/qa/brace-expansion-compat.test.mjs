import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '../..')
const compatRoot = join(root, 'vendor', 'brace-expansion-compat')
const compatPath = join(compatRoot, 'index.cjs')

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

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
  const module = await import(pathToFileURL(join(compatRoot, 'index.mjs')).href)

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
  assert.equal(upstream.version, '5.0.9')
})

test('root application owns the compatibility facade outside the Worker boundary', () => {
  const dependencyPath = ['file:vendor', 'brace-expansion-compat'].join('/')
  const oldPath = ['worker', 'vendor', 'brace-expansion-compat'].join('/')
  const manifest = readJson(join(root, 'package.json'))
  const lockfile = readJson(join(root, 'package-lock.json'))
  const eslintConfig = readFileSync(join(root, 'eslint.config.mjs'), 'utf8')
  const workerManifest = readFileSync(join(root, 'worker', 'package.json'), 'utf8')
  const workerLockfile = readFileSync(join(root, 'worker', 'package-lock.json'), 'utf8')

  assert.equal(manifest.devDependencies['brace-expansion'], dependencyPath)
  assert.equal(lockfile.packages[''].devDependencies['brace-expansion'], dependencyPath)
  assert.equal(lockfile.packages['node_modules/brace-expansion'].resolved, dependencyPath.slice(5))
  assert.equal(lockfile.packages[dependencyPath.slice(5)].name, 'brace-expansion')
  assert.equal(existsSync(join(root, ...oldPath.split('/'))), false)
  assert.match(eslintConfig, /globalIgnores\(\[[\s\S]*?'vendor\/\*\*'/u)
  assert.doesNotMatch(workerManifest, /brace-expansion-compat/u)
  assert.doesNotMatch(workerLockfile, /brace-expansion-compat/u)

  const staleReferences = spawnSync('git', ['grep', '-n', '-I', '-F', oldPath, '--', '.'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(staleReferences.status, 1, staleReferences.stdout || staleReferences.stderr)
  assert.equal(staleReferences.stdout, '')
  assert.equal(staleReferences.stderr, '')
})
