import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CONFIG = join(ROOT, 'worker/ecosystem.local-scoring.config.cjs')
const DEPLOY = join(ROOT, 'worker/deploy-scoring-local.sh')
const GATE_FILE = 'lib/cron/v1-ranking-command-chain-publication.ts'

function put(path, contents = '', mode) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
  if (mode) chmodSync(path, mode)
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

// ── PM2 config ──────────────────────────────────────────────────────────────

function loadConfig(env) {
  const clean = { ...process.env, ...env }
  delete clean.NODE_OPTIONS
  for (const name of ['ARENA_SCORING_RELEASE_DIR', 'ARENA_NODE_BIN']) {
    if (env[name] === undefined) delete clean[name]
  }
  return spawnSync(
    process.execPath,
    ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(CONFIG)})))`],
    { encoding: 'utf8', env: clean }
  )
}

function makeRelease(t, { artifact = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'arena-scoring-config-'))
  t.after(() => rmSync(root, { force: true, recursive: true }))
  const releaseDir = join(root, 'release')
  mkdirSync(join(releaseDir, 'worker', 'logs'), { recursive: true })
  put(join(releaseDir, 'worker', '.env'), 'X=1\n')
  if (artifact) put(join(releaseDir, 'worker', 'dist', 'scoring-worker.mjs'), 'export {}\n')
  return releaseDir
}

test('PM2 runs the prebuilt release artifact with an explicit node, never npx tsx', (t) => {
  const releaseDir = makeRelease(t)
  const r = loadConfig({ ARENA_SCORING_RELEASE_DIR: releaseDir, ARENA_NODE_BIN: process.execPath })
  assert.equal(r.status, 0, r.stderr)
  const [app] = JSON.parse(r.stdout).apps
  assert.equal(app.name, 'arena-worker')
  assert.equal(app.cwd, releaseDir)
  assert.equal(app.script, join(releaseDir, 'worker', 'dist', 'scoring-worker.mjs'))
  assert.equal(app.interpreter, process.execPath)
  assert.doesNotMatch(JSON.stringify(app), /npx|tsx/)
  assert.equal(app.env_file, undefined)
})

test('PM2 config fails closed without a built artifact or release dir', (t) => {
  const releaseDir = makeRelease(t, { artifact: false })
  const missing = loadConfig({
    ARENA_SCORING_RELEASE_DIR: releaseDir,
    ARENA_NODE_BIN: process.execPath,
  })
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /prebuilt scoring worker artifact/)
  const noDir = loadConfig({ ARENA_NODE_BIN: process.execPath })
  assert.notEqual(noDir.status, 0)
  assert.match(noDir.stderr, /ARENA_SCORING_RELEASE_DIR is required/)
})

// ── deploy script ───────────────────────────────────────────────────────────

function makeRepo(t, { gateOpen, gatePreamble = '' }) {
  const root = mkdtempSync(join(tmpdir(), 'arena-scoring-deploy-'))
  t.after(() => rmSync(root, { force: true, recursive: true }))
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'worker'), { recursive: true })
  copyFileSync(DEPLOY, join(repo, 'worker', 'deploy-scoring-local.sh'))
  put(
    join(repo, GATE_FILE),
    `${gatePreamble}export const V1_RANKING_COMMAND_CHAIN_PUBLISHED = ${gateOpen} as const\n`
  )
  put(join(repo, 'worker', 'build-scoring-worker.mjs'), '// stub\n')
  put(join(repo, 'worker', 'ecosystem.local-scoring.config.cjs'), '// stub\n')
  git(repo, 'init', '--quiet', '--initial-branch=main')
  git(repo, 'config', 'user.email', 'qa@example.test')
  git(repo, 'config', 'user.name', 'Arena QA')
  git(repo, 'add', '.')
  git(repo, 'commit', '--quiet', '-m', 'release')
  const sha = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'update-ref', 'refs/remotes/origin/main', sha)

  // Fake toolchain: node (runs the build stub), npm, pm2. All log their argv.
  const bin = join(root, 'bin')
  const log = join(root, 'calls.log')
  writeFileSync(log, '')
  put(
    join(bin, 'node'),
    `#!/usr/bin/env bash\necho "node $*" >> "${log}"\nfor a in "$@"; do case "$a" in --outdir=*) d="\${a#--outdir=}"; mkdir -p "$d"; echo 'export {}' > "$d/scoring-worker.mjs";; esac; done\n`,
    0o755
  )
  put(
    join(bin, 'npm'),
    `#!/usr/bin/env bash\necho "npm $*" >> "${log}"\n[ -z "$FAKE_NPM_FAIL" ] || exit 1\n`,
    0o755
  )
  put(
    join(bin, 'pm2'),
    `#!/usr/bin/env bash\necho "pm2 $*" >> "${log}"\nif [ "$1" = start ] && [ "\${FAKE_PM2_READY:-1}" = 1 ]; then mkdir -p "$ARENA_SCORING_RELEASE_DIR/worker/logs"; echo '[heartbeat] redis-hset-committed node=scoring@mac pid=1' >> "$ARENA_SCORING_RELEASE_DIR/worker/logs/scoring-out.log"; fi\nif [ "$1" = pid ]; then [ "\${FAKE_PM2_DEAD:-0}" = 1 ] && echo 0 || echo 4242; fi\n`,
    0o755
  )
  const envFile = join(root, 'worker.env')
  writeFileSync(envFile, 'X=1\n')
  return { root, repo, sha, bin, log, envFile, releaseRoot: join(root, 'releases') }
}

function deploy(ctx, args, extraEnv = {}) {
  return spawnSync('bash', [join(ctx.repo, 'worker', 'deploy-scoring-local.sh'), ...args], {
    cwd: ctx.repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      ARENA_NODE_BIN: join(ctx.bin, 'node'),
      ARENA_PM2_BIN: join(ctx.bin, 'pm2'),
      ARENA_SCORING_RELEASE_ROOT: ctx.releaseRoot,
      ARENA_SCORING_ENV_FILE: ctx.envFile,
      ARENA_SCORING_READY_TIMEOUT_SECONDS: '2',
      ...extraEnv,
    },
  })
}

test('rejects a non-40-hex target', (t) => {
  const ctx = makeRepo(t, { gateOpen: false })
  assert.equal(deploy(ctx, ['--target-sha=main']).status, 2)
})

test('dry-run is read-only: prints the plan, writes nothing, never touches PM2', (t) => {
  const ctx = makeRepo(t, { gateOpen: false })
  const r = deploy(ctx, [`--target-sha=${ctx.sha}`, '--dry-run'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /gate_open=0/)
  assert.match(r.stdout, /dry-run: no files written, PM2 untouched/)
  assert.equal(existsSync(ctx.releaseRoot), false)
  assert.equal(readFileSync(ctx.log, 'utf8'), '')
})

test('a real run refuses while the V1 ranking command chain is unpublished', (t) => {
  const ctx = makeRepo(t, { gateOpen: false })
  const r = deploy(ctx, [`--target-sha=${ctx.sha}`])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /scoring deploy is suspended/)
  assert.equal(existsSync(ctx.releaseRoot), false)
  assert.equal(readFileSync(ctx.log, 'utf8'), '')
})

test('refuses a commit that is not in origin/main', (t) => {
  const ctx = makeRepo(t, { gateOpen: true })
  put(join(ctx.repo, 'extra.txt'), 'x')
  git(ctx.repo, 'add', '.')
  git(ctx.repo, 'commit', '--quiet', '-m', 'unmerged')
  const r = deploy(ctx, [`--target-sha=${git(ctx.repo, 'rev-parse', 'HEAD')}`, '--dry-run'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /not in origin\/main/)
})

test('with the gate open: immutable release, build, PM2 start, heartbeat proof, current pointer', (t) => {
  const ctx = makeRepo(t, { gateOpen: true })
  const r = deploy(ctx, [`--target-sha=${ctx.sha}`])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const release = join(ctx.releaseRoot, ctx.sha)
  assert.ok(existsSync(join(release, GATE_FILE)), 'release materialized from git archive')
  assert.ok(existsSync(join(release, 'worker', 'dist', 'scoring-worker.mjs')))
  assert.equal(readFileSync(join(release, 'worker', '.env'), 'utf8'), 'X=1\n')
  const calls = readFileSync(ctx.log, 'utf8')
  assert.match(calls, /npm ci --ignore-scripts/)
  assert.match(calls, /node .*build-scoring-worker\.mjs --outdir=/)
  assert.match(calls, /pm2 start .*ecosystem\.local-scoring\.config\.cjs --only arena-worker/)
  assert.doesNotMatch(calls, /tsx/)
  assert.match(r.stdout, /arena-worker running/)

  // Releases are immutable: redeploying the same sha refuses.
  const again = deploy(ctx, [`--target-sha=${ctx.sha}`])
  assert.equal(again.status, 1)
  assert.match(again.stderr, /already exists/)
})

test('rolls back (no previous release → stopped) when the heartbeat never appears', (t) => {
  const ctx = makeRepo(t, { gateOpen: true })
  const r = deploy(ctx, [`--target-sha=${ctx.sha}`], { FAKE_PM2_READY: '0' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /rolling back/)
  assert.match(readFileSync(ctx.log, 'utf8'), /pm2 delete arena-worker/)
  assert.equal(existsSync(join(ctx.releaseRoot, 'current')), false)
})

test('a comment mentioning "= true" does not open the V1 gate', (t) => {
  const ctx = makeRepo(t, {
    gateOpen: false,
    gatePreamble: '// flip to V1_RANKING_COMMAND_CHAIN_PUBLISHED = true at launch\n',
  })
  const r = deploy(ctx, [`--target-sha=${ctx.sha}`])
  assert.equal(r.status, 1)
  assert.equal(readFileSync(ctx.log, 'utf8'), '')
})

test('a failed npm ci leaves no release behind, so the same sha can be retried', (t) => {
  const ctx = makeRepo(t, { gateOpen: true })
  const failed = deploy(ctx, [`--target-sha=${ctx.sha}`], { FAKE_NPM_FAIL: '1' })
  assert.notEqual(failed.status, 0)
  assert.deepEqual(readdirSync(ctx.releaseRoot), [])
  const retry = deploy(ctx, [`--target-sha=${ctx.sha}`])
  assert.equal(retry.status, 0, retry.stderr + retry.stdout)
})

test('a process that is gone after its heartbeat is not live; rollback reports the real outcome', (t) => {
  const ctx = makeRepo(t, { gateOpen: true })
  const r = deploy(ctx, [`--target-sha=${ctx.sha}`], { FAKE_PM2_DEAD: '1' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /no previous release; arena-worker left stopped/)
  assert.doesNotMatch(r.stderr, /restored/)
  assert.equal(existsSync(join(ctx.releaseRoot, 'current')), false)
})
