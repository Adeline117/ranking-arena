import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const CONFIG = fileURLToPath(
  new URL('../../worker/ecosystem.local-ingest.config.cjs', import.meta.url)
)
const CONFIG_SOURCE = readFileSync(CONFIG, 'utf8')
const REAL_TSX_LOADER = fileURLToPath(
  new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url)
)

function put(path, contents = '') {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

function makeRelease(t) {
  const root = mkdtempSync(join(tmpdir(), 'arena-local-ingest-config-'))
  t.after(() => rmSync(root, { force: true, recursive: true }))
  const releaseDir = join(root, 'release')
  mkdirSync(join(releaseDir, 'worker', 'logs'), { recursive: true })
  put(join(releaseDir, 'worker', '.env'), 'WORKER_NODE_ID=mac-mini\n')
  put(join(releaseDir, 'worker', 'src', 'ingest-worker.ts'), 'export {}\n')
  put(join(releaseDir, 'node_modules', 'tsx', 'dist', 'loader.mjs'), 'export {}\n')
  return { releaseDir, root }
}

function loadConfig(envOverrides = {}) {
  const env = { ...process.env, ...envOverrides }
  delete env.NODE_OPTIONS
  for (const name of ['ARENA_INGEST_RELEASE_DIR', 'ARENA_NODE_BIN']) {
    if (envOverrides[name] === undefined) delete env[name]
  }
  return spawnSync(
    process.execPath,
    ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(CONFIG)})))`],
    { encoding: 'utf8', env }
  )
}

test('runs the worker directly in PM2 with the release-owned tsx loader', (t) => {
  const { releaseDir } = makeRelease(t)
  const result = loadConfig({
    ARENA_INGEST_RELEASE_DIR: releaseDir,
    ARENA_NODE_BIN: process.execPath,
  })

  assert.equal(result.status, 0, result.stderr)
  const config = JSON.parse(result.stdout)
  assert.equal(config.apps.length, 1)
  assert.deepEqual(config.apps[0], {
    name: 'arena-ingest-worker',
    cwd: releaseDir,
    script: join(releaseDir, 'worker', 'src', 'ingest-worker.ts'),
    interpreter: process.execPath,
    env: {
      NODE_ENV: 'production',
      PLAYWRIGHT_BROWSERS_PATH: join(releaseDir, '.playwright-browsers'),
    },
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 5000,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: join(releaseDir, 'worker', 'logs', 'ingest-error.log'),
    out_file: join(releaseDir, 'worker', 'logs', 'ingest-out.log'),
    merge_logs: true,
    max_memory_restart: '3072M',
    node_args: [
      '--max-old-space-size=2560',
      '--import',
      join(releaseDir, 'node_modules', 'tsx', 'dist', 'loader.mjs'),
    ],
    kill_timeout: 30000,
    listen_timeout: 10000,
  })
  assert.doesNotMatch(CONFIG_SOURCE, /\bnpx\b|npm\s+exec|pnpm\s+dlx|tsxCli|cli\.mjs/)
  assert.doesNotMatch(CONFIG_SOURCE, /env_file\s*:/)
})

test('Node plus the tsx loader executes TypeScript in the launched PID', (t) => {
  const { root } = makeRelease(t)
  const probe = join(root, 'pid-probe.ts')
  put(probe, 'const workerPid: number = process.pid\nprocess.stdout.write(String(workerPid))\n')

  const result = spawnSync(
    process.execPath,
    ['--max-old-space-size=2560', '--import', REAL_TSX_LOADER, probe],
    { encoding: 'utf8' }
  )

  assert.equal(result.status, 0, result.stderr)
  assert.equal(Number(result.stdout), result.pid)
})

test('fails closed when either deployment path is absent or relative', (t) => {
  const { releaseDir } = makeRelease(t)
  const cases = [
    [{ ARENA_NODE_BIN: process.execPath }, /ARENA_INGEST_RELEASE_DIR is required/],
    [{ ARENA_INGEST_RELEASE_DIR: releaseDir }, /ARENA_NODE_BIN is required/],
    [
      { ARENA_INGEST_RELEASE_DIR: 'relative-release', ARENA_NODE_BIN: process.execPath },
      /ARENA_INGEST_RELEASE_DIR must be an absolute path/,
    ],
    [
      { ARENA_INGEST_RELEASE_DIR: releaseDir, ARENA_NODE_BIN: 'relative-node' },
      /ARENA_NODE_BIN must be an absolute path/,
    ],
  ]

  for (const [env, expectedError] of cases) {
    const result = loadConfig(env)
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, expectedError)
  }
})

test('rejects a symlink release and a non-executable Node file', (t) => {
  const { releaseDir, root } = makeRelease(t)
  const releaseLink = join(root, 'current')
  symlinkSync(releaseDir, releaseLink, 'dir')

  let result = loadConfig({
    ARENA_INGEST_RELEASE_DIR: releaseLink,
    ARENA_NODE_BIN: process.execPath,
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /ARENA_INGEST_RELEASE_DIR must not be a symlink/)

  const inertNode = join(root, 'node')
  put(inertNode, '#!/bin/sh\n')
  chmodSync(inertNode, 0o644)
  result = loadConfig({
    ARENA_INGEST_RELEASE_DIR: releaseDir,
    ARENA_NODE_BIN: inertNode,
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /ARENA_NODE_BIN is not executable/)

  const linkedNode = join(root, 'linked-node')
  symlinkSync(process.execPath, linkedNode)
  result = loadConfig({
    ARENA_INGEST_RELEASE_DIR: releaseDir,
    ARENA_NODE_BIN: linkedNode,
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /ARENA_NODE_BIN must not be a symlink/)
})

test('rejects an incomplete candidate before PM2 can start it', (t) => {
  const { releaseDir } = makeRelease(t)
  rmSync(join(releaseDir, 'node_modules', 'tsx', 'dist', 'loader.mjs'))
  const result = loadConfig({
    ARENA_INGEST_RELEASE_DIR: releaseDir,
    ARENA_NODE_BIN: process.execPath,
  })

  assert.notEqual(result.status, 0)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /candidate tsx loader is not accessible/)
})

test('rejects symlinked candidate code and loader inputs', (t) => {
  const entryRelease = makeRelease(t).releaseDir
  const entrypoint = join(entryRelease, 'worker', 'src', 'ingest-worker.ts')
  const entryTarget = join(entryRelease, 'worker', 'src', 'actual-worker.ts')
  put(entryTarget, 'export {}\n')
  rmSync(entrypoint)
  symlinkSync(entryTarget, entrypoint)

  let result = loadConfig({
    ARENA_INGEST_RELEASE_DIR: entryRelease,
    ARENA_NODE_BIN: process.execPath,
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /candidate ingest worker entrypoint must not be a symlink/)

  const loaderRelease = makeRelease(t).releaseDir
  const loader = join(loaderRelease, 'node_modules', 'tsx', 'dist', 'loader.mjs')
  const loaderTarget = join(loaderRelease, 'node_modules', 'tsx', 'dist', 'actual-loader.mjs')
  put(loaderTarget, 'export {}\n')
  rmSync(loader)
  symlinkSync(loaderTarget, loader)
  result = loadConfig({
    ARENA_INGEST_RELEASE_DIR: loaderRelease,
    ARENA_NODE_BIN: process.execPath,
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /candidate tsx loader must not be a symlink/)
})
