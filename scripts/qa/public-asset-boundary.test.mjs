import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { devNull, tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { TextDecoder } from 'node:util'

const require = createRequire(import.meta.url)
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })
const root = path.resolve(import.meta.dirname, '../..')
const requiredServiceWorkerTests = [
  '__tests__/service-worker/offline-cache-contract.test.ts',
  '__tests__/service-worker/push-viewer-isolation.test.ts',
]
const retiredPublicTests = [
  'public/__tests__/sw.offline-cache-contract.test.ts',
  'public/__tests__/sw.push-viewer.test.ts',
]
const sourceTestName = /\.(?:test|spec)\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$/i
const maxGitOutputBytes = 64 * 1024 * 1024

function isolatedGitEnv(overrides = {}) {
  const env = {}
  for (const key of [
    'PATH',
    'TMPDIR',
    'TMP',
    'TEMP',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!key.startsWith('GIT_') && value !== undefined) env[key] = String(value)
  }

  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = devNull
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GIT_TERMINAL_PROMPT = '0'
  env.LC_ALL = 'C'
  return env
}

function processEnvWithoutGit() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => !key.startsWith('GIT_') && value !== undefined
    )
  )
}

function runGit(args, { cwd = root, envOverrides = {}, input } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'buffer',
    env: isolatedGitEnv(envOverrides),
    input,
    maxBuffer: maxGitOutputBytes,
  })
  assert.equal(result.error, undefined, `git ${args[0]} failed to start: ${String(result.error)}`)
  assert.equal(
    result.status,
    0,
    Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : `git ${args[0]} failed`
  )
  assert.equal(result.signal, null, `git ${args[0]} was terminated by ${result.signal}`)
  assert.ok(Buffer.isBuffer(result.stdout), `git ${args[0]} stdout must be a Buffer`)
  return result.stdout
}

function nulRecords(output, label) {
  assert.ok(Buffer.isBuffer(output), `${label} output must be a Buffer`)
  if (output.length === 0) return []
  assert.equal(output.at(-1), 0, `${label} output must be NUL-terminated`)

  const records = []
  let start = 0
  for (let end = output.indexOf(0, start); end !== -1; end = output.indexOf(0, start)) {
    assert.notEqual(end, start, `${label} output contains an empty record`)
    records.push(output.subarray(start, end))
    start = end + 1
    if (start === output.length) break
  }
  assert.equal(start, output.length, `${label} output has trailing bytes`)
  return records
}

function decodeUtf8(value, label) {
  try {
    return utf8Decoder.decode(value)
  } catch {
    assert.fail(`${label} is not valid UTF-8`)
  }
}

function assertCanonicalRepositoryPath(relativePath) {
  assert.equal(typeof relativePath, 'string', 'repository path must be a string')
  assert.notEqual(relativePath.length, 0, 'repository path must not be empty')
  assert.equal(path.posix.isAbsolute(relativePath), false, `${relativePath} must be relative`)
  assert.equal(relativePath.includes('\\'), false, `${relativePath} must use POSIX separators`)
  assert.doesNotMatch(relativePath, /[\u0000-\u001f\u007f]/u, `${relativePath} is unsafe`)
  assert.equal(path.posix.normalize(relativePath), relativePath, `${relativePath} is not canonical`)
  assert.ok(
    relativePath
      .split('/')
      .every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    `${relativePath} contains an unsafe segment`
  )
}

function indexEntries(pathspecs, { cwd = root, envOverrides = {} } = {}) {
  const requestedPaths = Array.isArray(pathspecs) ? pathspecs : [pathspecs]
  const output = runGit(['ls-files', '--stage', '-z', '--', ...requestedPaths], {
    cwd,
    envOverrides,
  })

  return nulRecords(output, 'git ls-files').map((record) => {
    const separator = record.indexOf(9)
    assert.ok(separator > 0 && separator < record.length - 1, 'Git index record is malformed')
    const metadata = record.subarray(0, separator).toString('ascii')
    const match = /^(?<mode>[0-7]{6}) (?<object>[0-9a-f]{40}|[0-9a-f]{64}) (?<stage>[0-3])$/u.exec(
      metadata
    )
    assert.ok(match, 'Git index metadata is malformed')
    const relativePath = decodeUtf8(record.subarray(separator + 1), 'Git index path')
    assertCanonicalRepositoryPath(relativePath)
    return {
      mode: match.groups.mode,
      object: match.groups.object,
      path: relativePath,
      stage: match.groups.stage,
    }
  })
}

function portablePathKey(relativePath) {
  assertCanonicalRepositoryPath(relativePath)
  return relativePath.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC')
}

function assertPortablePathUniqueness(paths, label) {
  const exact = new Set()
  const portable = new Map()
  for (const relativePath of paths) {
    assertCanonicalRepositoryPath(relativePath)
    assert.equal(exact.has(relativePath), false, `${label} repeats ${relativePath}`)
    exact.add(relativePath)

    const key = portablePathKey(relativePath)
    const previous = portable.get(key)
    assert.equal(
      previous,
      undefined,
      `${label} has a case-fold/NFC collision: ${previous} <> ${relativePath}`
    )
    portable.set(key, relativePath)
  }
}

function trackedRegularPaths(entries, label) {
  const paths = entries.map((entry) => {
    assert.equal(entry.stage, '0', `${entry.path} must not have an unmerged index stage`)
    assert.match(entry.mode, /^100(?:644|755)$/u, `${entry.path} must have a regular Git mode`)
    return entry.path
  })
  assertPortablePathUniqueness(paths, `${label} index`)
  return paths.sort()
}

function listPhysicalRegularFiles(repositoryRoot, relativeDirectory) {
  assertCanonicalRepositoryPath(relativeDirectory)
  const repositoryMetadata = fs.lstatSync(repositoryRoot)
  assert.equal(
    repositoryMetadata.isSymbolicLink(),
    false,
    'fixture/repository root must not be a symlink'
  )
  assert.equal(
    repositoryMetadata.isDirectory(),
    true,
    'fixture/repository root must be a directory'
  )

  const files = []
  function visit(absolutePath, relativePath) {
    const metadata = fs.lstatSync(absolutePath)
    assert.equal(metadata.isSymbolicLink(), false, `${relativePath} must not be a symlink`)
    if (metadata.isDirectory()) {
      const children = fs
        .readdirSync(absolutePath, { withFileTypes: true })
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      for (const child of children) {
        const childRelativePath = `${relativePath}/${child.name}`
        assertCanonicalRepositoryPath(childRelativePath)
        visit(path.join(absolutePath, child.name), childRelativePath)
      }
      return
    }
    assert.equal(metadata.isFile(), true, `${relativePath} has an unsupported filesystem type`)
    files.push(relativePath)
  }

  visit(path.resolve(repositoryRoot, ...relativeDirectory.split('/')), relativeDirectory)
  files.sort()
  assertPortablePathUniqueness(files, `${relativeDirectory} checkout`)
  return files
}

function assertExactInventoryParity(indexPaths, physicalPaths, label) {
  assertPortablePathUniqueness(indexPaths, `${label} index`)
  assertPortablePathUniqueness(physicalPaths, `${label} checkout`)
  const indexSet = new Set(indexPaths)
  const physicalSet = new Set(physicalPaths)
  const indexOnly = [...indexSet].filter((relativePath) => !physicalSet.has(relativePath)).sort()
  const physicalOnly = [...physicalSet].filter((relativePath) => !indexSet.has(relativePath)).sort()
  assert.deepEqual(
    { indexOnly, physicalOnly },
    { indexOnly: [], physicalOnly: [] },
    `${label} index/checkout inventory drifted`
  )
}

function assertPublicRuntimePath(relativePath) {
  assertCanonicalRepositoryPath(relativePath)
  assert.match(relativePath, /^public\/.+/u, `${relativePath} must stay below public/`)
  const segments = relativePath.toLowerCase().split('/')
  assert.equal(
    segments.includes('__tests__'),
    false,
    `${relativePath} puts a test directory in the public runtime asset tree`
  )
  assert.equal(
    sourceTestName.test(segments.at(-1)),
    false,
    `${relativePath} puts test source in the public runtime asset tree`
  )
}

function assertRegularRepositoryFile(relativePath) {
  assertCanonicalRepositoryPath(relativePath)
  let current = root
  let metadata = fs.lstatSync(root)
  assert.equal(metadata.isSymbolicLink(), false, 'repository root must not be a symlink')
  assert.equal(metadata.isDirectory(), true, 'repository root must be a directory')
  for (const segment of relativePath.split('/')) {
    current = path.join(current, segment)
    metadata = fs.lstatSync(current)
    assert.equal(metadata.isSymbolicLink(), false, `${relativePath} must not traverse a symlink`)
  }
  assert.equal(metadata.isFile(), true, `${relativePath} must be a regular file`)
}

function assertPhysicallyMissing(relativePath) {
  assert.throws(
    () => fs.lstatSync(path.join(root, relativePath)),
    (error) => error?.code === 'ENOENT',
    `${relativePath} must be physically absent`
  )
}

function repositoryRelativeJestPath(absolutePath) {
  assert.equal(typeof absolutePath, 'string', 'Jest listTests entries must be strings')
  assert.equal(path.isAbsolute(absolutePath), true, `${absolutePath} must be an absolute Jest path`)
  const resolved = path.resolve(absolutePath)
  const relativePath = path.relative(root, resolved)
  assert.ok(
    relativePath !== '' &&
      relativePath !== '..' &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath),
    `${absolutePath} escapes the Jest repository root`
  )
  const repositoryPath = relativePath.split(path.sep).join('/')
  assertCanonicalRepositoryPath(repositoryPath)
  return repositoryPath
}

function discoveredJestTests() {
  const jestBinary = require.resolve('jest/bin/jest')
  const binaryMetadata = fs.lstatSync(jestBinary)
  assert.equal(
    binaryMetadata.isSymbolicLink(),
    false,
    'resolved local Jest CLI must not be a symlink'
  )
  assert.equal(binaryMetadata.isFile(), true, 'resolved local Jest CLI must be a regular file')

  const result = spawnSync(
    process.execPath,
    [jestBinary, '--listTests', '--json', '--runInBand', '--no-cache'],
    {
      cwd: root,
      encoding: 'utf8',
      env: processEnvWithoutGit(),
      maxBuffer: maxGitOutputBytes,
      timeout: 60_000,
    }
  )
  assert.equal(result.error, undefined, `local Jest listTests failed: ${String(result.error)}`)
  assert.equal(result.status, 0, result.stderr || 'local Jest listTests returned non-zero')
  assert.equal(result.signal, null, `local Jest listTests was terminated by ${result.signal}`)

  let listed
  try {
    listed = JSON.parse(result.stdout)
  } catch {
    assert.fail(`local Jest listTests did not return JSON: ${result.stdout.slice(0, 200)}`)
  }
  assert.ok(Array.isArray(listed), 'local Jest listTests JSON must be an array')
  const paths = listed.map(repositoryRelativeJestPath)
  assertPortablePathUniqueness(paths, 'Jest discovered test inventory')
  return new Set(paths)
}

test('Git index discovery ignores caller-controlled repository redirections', () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'arena-public-assets-index-'))
  const alternateIndex = path.join(directory, 'alternate-index')
  try {
    const emptyIndex = spawnSync('git', ['read-tree', '--empty'], {
      cwd: root,
      encoding: 'buffer',
      env: { ...isolatedGitEnv(), GIT_INDEX_FILE: alternateIndex },
    })
    assert.equal(emptyIndex.error, undefined, String(emptyIndex.error))
    assert.equal(
      emptyIndex.status,
      0,
      Buffer.isBuffer(emptyIndex.stderr) ? emptyIndex.stderr.toString('utf8') : 'Git failed'
    )

    const hostileGitEnvironment = {
      GIT_INDEX_FILE: alternateIndex,
      GIT_DIR: directory,
      GIT_WORK_TREE: directory,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.sparseCheckout',
      GIT_CONFIG_VALUE_0: 'true',
    }
    const sanitized = isolatedGitEnv(hostileGitEnvironment)
    for (const key of Object.keys(hostileGitEnvironment)) {
      assert.equal(key in sanitized, false, `${key} must not reach Git discovery`)
    }
    assert.deepEqual(
      indexEntries('public', { envOverrides: hostileGitEnvironment }),
      indexEntries('public'),
      'an alternate empty index must not hide the tracked public asset inventory'
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('inventory comparison rejects untracked files, missing checkout files, and portable collisions', (t) => {
  const fixture = fs.mkdtempSync(path.join(tmpdir(), 'arena-public-assets-fixture-'))
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }))
  runGit(['init', '--quiet'], { cwd: fixture })
  fs.mkdirSync(path.join(fixture, 'public'))
  fs.writeFileSync(path.join(fixture, 'public/runtime.js'), 'runtime\n')
  runGit(['add', '--', 'public/runtime.js'], { cwd: fixture })

  fs.writeFileSync(path.join(fixture, 'public/.env.production'), 'secret\n')
  const tracked = trackedRegularPaths(indexEntries('public', { cwd: fixture }), 'fixture public')
  assert.throws(
    () =>
      assertExactInventoryParity(
        tracked,
        listPhysicalRegularFiles(fixture, 'public'),
        'fixture public'
      ),
    /index\/checkout inventory drifted/u
  )

  fs.rmSync(path.join(fixture, 'public/.env.production'))
  fs.rmSync(path.join(fixture, 'public/runtime.js'))
  assert.throws(
    () =>
      assertExactInventoryParity(
        tracked,
        listPhysicalRegularFiles(fixture, 'public'),
        'fixture public'
      ),
    /index\/checkout inventory drifted/u
  )

  assert.throws(
    () => assertPortablePathUniqueness(['public/Icon.svg', 'public/icon.svg'], 'case fixture'),
    /case-fold\/NFC collision/u
  )
  assert.throws(
    () =>
      assertPortablePathUniqueness(
        ['public/caf\u00e9.svg', 'public/cafe\u0301.svg'],
        'Unicode fixture'
      ),
    /case-fold\/NFC collision/u
  )
})

test('public/ is an exact tracked regular-file runtime asset inventory', () => {
  const entries = indexEntries('public')
  const trackedPaths = trackedRegularPaths(entries, 'public')
  const physicalPaths = listPhysicalRegularFiles(root, 'public')
  assert.ok(
    trackedPaths.includes('public/sw.js'),
    'the service-worker runtime asset must be tracked'
  )
  for (const relativePath of trackedPaths) assertPublicRuntimePath(relativePath)
  for (const relativePath of physicalPaths) assertPublicRuntimePath(relativePath)
  assertExactInventoryParity(trackedPaths, physicalPaths, 'public')

  assert.doesNotThrow(() => assertPublicRuntimePath('public/sw.js'))
  assert.throws(() => assertPublicRuntimePath('public/__TESTS__/sw.ts'))
  assert.throws(() => assertPublicRuntimePath('public/runtime/sw.spec.mjs'))
  assert.throws(() => assertPublicRuntimePath('public/runtime/sw.test.tsx'))
})

test('service-worker test ownership is extensible and uses the real Jest discovery result', () => {
  const entries = indexEntries('__tests__/service-worker')
  const trackedPaths = trackedRegularPaths(entries, 'service-worker tests')
  const trackedSet = new Set(trackedPaths)
  for (const requiredPath of requiredServiceWorkerTests) {
    assert.equal(trackedSet.has(requiredPath), true, `${requiredPath} must remain tracked`)
  }
  for (const relativePath of trackedPaths) assertRegularRepositoryFile(relativePath)

  const testSources = trackedPaths.filter((relativePath) => sourceTestName.test(relativePath))
  assert.ok(testSources.length > 0, 'service-worker test source inventory disappeared')
  const discovered = discoveredJestTests()
  for (const relativePath of testSources) {
    assert.equal(
      discovered.has(relativePath),
      true,
      `${relativePath} is not discovered by real Jest`
    )
  }

  const publicEntries = new Set(indexEntries('public').map((entry) => entry.path))
  for (const retiredPath of retiredPublicTests) {
    assert.equal(
      publicEntries.has(retiredPath),
      false,
      `${retiredPath} must be absent from the index`
    )
    assertPhysicallyMissing(retiredPath)
  }
  assert.equal(
    [...publicEntries].some((relativePath) => relativePath.startsWith('public/__tests__/')),
    false,
    'public/__tests__/ must be absent from the index'
  )
  assertPhysicallyMissing('public/__tests__')
})
