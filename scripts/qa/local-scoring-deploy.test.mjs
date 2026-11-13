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
  readlinkSync,
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

function makeRepo(t, { gateOpen, gateSource }) {
  const root = mkdtempSync(join(tmpdir(), 'arena-scoring-deploy-'))
  t.after(() => rmSync(root, { force: true, recursive: true }))
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'worker'), { recursive: true })
  copyFileSync(DEPLOY, join(repo, 'worker', 'deploy-scoring-local.sh'))
  put(
    join(repo, GATE_FILE),
    gateSource ?? `export const V1_RANKING_COMMAND_CHAIN_PUBLISHED = ${gateOpen} as const\n`
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
    `#!/usr/bin/env bash\necho "node $*" >> "${log}"\nif [ "$1" = -p ]; then cat "${join(root, 'node-major')}" 2>/dev/null || echo 22; exit 0; fi\nif [ -f "${join(root, 'build-fails')}" ]; then exit 1; fi\nfor a in "$@"; do case "$a" in --outdir=*) d="\${a#--outdir=}"; mkdir -p "$d"; echo 'export {}' > "$d/scoring-worker.mjs";; esac; done\n`,
    0o755
  )
  put(
    join(bin, 'npm'),
    `#!/usr/bin/env bash\necho "npm $* NODE_ENV=\${NODE_ENV:-unset}" >> "${log}"\n`,
    0o755
  )
  put(
    join(bin, 'pm2'),
    [
      '#!/usr/bin/env bash',
      `echo "pm2 $*" >> "${log}"`,
      '[ "$1" = start ] || exit 0',
      'mode="${FAKE_PM2_READY:-1}"',
      `if [ -f "${join(root, 'fail-release')}" ] && grep -qxF "$ARENA_SCORING_RELEASE_DIR" "${join(root, 'fail-release')}"; then mode=0; fi`,
      'out="$ARENA_SCORING_RELEASE_DIR/worker/logs/scoring-out.log"',
      'mkdir -p "$(dirname "$out")"',
      'boot() {',
      '  echo "2026-11-13 00:00:00: [worker] Arena Pipeline Worker starting..." >> "$out"',
      '  echo "2026-11-13 00:00:00: [heartbeat] redis-hset-committed node=scoring@mac pid=$$ sha=x" >> "$out"',
      '  echo "2026-11-13 00:00:00: [worker] Ready — processing queue" >> "$out"',
      '}',
      'case "$mode" in',
      '  1) boot ;;',
      '  crashloop) boot; boot ;;',
      'esac',
      '',
    ].join('\n'),
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
      ARENA_SCORING_STABILITY_SECONDS: '0',
      NODE_ENV: 'production',
      npm_config_omit: 'dev',
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
  // Clean install env: the caller's NODE_ENV/npm_config_omit never reach npm,
  // and dev deps (esbuild, via tsx) are always installed for the build.
  assert.match(calls, /npm ci --include=dev --ignore-scripts .* NODE_ENV=unset/)
  assert.deepEqual(
    readdirSync(ctx.releaseRoot).filter((name) => name.startsWith('.')),
    [],
    'no staging directory or lock left behind'
  )
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

function commitNext(ctx, name) {
  put(join(ctx.repo, `${name}.txt`), name)
  git(ctx.repo, 'add', '.')
  git(ctx.repo, 'commit', '--quiet', '-m', name)
  const sha = git(ctx.repo, 'rev-parse', 'HEAD')
  git(ctx.repo, 'update-ref', 'refs/remotes/origin/main', sha)
  return sha
}

test('a gate value mentioned only in a comment does not open the deploy', (t) => {
  const ctx = makeRepo(t, {
    gateOpen: false,
    gateSource:
      '// Reopen with: V1_RANKING_COMMAND_CHAIN_PUBLISHED = true\n' +
      'export const V1_RANKING_COMMAND_CHAIN_PUBLISHED = false as const\n',
  })
  const r = deploy(ctx, [`--target-sha=${ctx.sha}`])
  assert.equal(r.status, 1)
  assert.match(r.stdout, /gate_open=0/)
  assert.match(r.stderr, /scoring deploy is suspended/)
  assert.equal(readFileSync(ctx.log, 'utf8'), '')
})

test('a failed build leaves no release behind, so the same sha can be retried', (t) => {
  const ctx = makeRepo(t, { gateOpen: true })
  writeFileSync(join(ctx.root, 'build-fails'), '')
  const failed = deploy(ctx, [`--target-sha=${ctx.sha}`])
  assert.notEqual(failed.status, 0)
  assert.equal(existsSync(join(ctx.releaseRoot, ctx.sha)), false)
  assert.deepEqual(readdirSync(ctx.releaseRoot), [], 'staging and lock cleaned up')
  assert.doesNotMatch(readFileSync(ctx.log, 'utf8'), /pm2/)

  rmSync(join(ctx.root, 'build-fails'))
  const retried = deploy(ctx, [`--target-sha=${ctx.sha}`])
  assert.equal(retried.status, 0, retried.stderr)
})

test('a live deploy lock refuses a concurrent run; a dead owner fails closed', (t) => {
  const ctx = makeRepo(t, { gateOpen: true })
  const lock = join(ctx.releaseRoot, '.arena-scoring-deploy-lock')
  put(join(lock, 'pid'), `${process.pid}\n`)
  const busy = deploy(ctx, [`--target-sha=${ctx.sha}`])
  assert.equal(busy.status, 1)
  assert.match(busy.stderr, /BUSY/)
  assert.ok(existsSync(lock), 'another deploy keeps its lock')

  writeFileSync(join(lock, 'pid'), '999999999\n')
  const stale = deploy(ctx, [`--target-sha=${ctx.sha}`])
  assert.equal(stale.status, 1)
  assert.match(stale.stderr, /stale scoring deploy lock/)
  assert.doesNotMatch(readFileSync(ctx.log, 'utf8'), /pm2|npm/)
})

test('a crash-looping release (PM2 restarted it) is rolled back even after a heartbeat', (t) => {
  const ctx = makeRepo(t, { gateOpen: true })
  const r = deploy(ctx, [`--target-sha=${ctx.sha}`], { FAKE_PM2_READY: 'crashloop' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /rolling back/)
  assert.equal(existsSync(join(ctx.releaseRoot, 'current')), false)
})

test('rollback restarts the previous release and proves it live from new log lines only', (t) => {
  const ctx = makeRepo(t, { gateOpen: true })
  assert.equal(deploy(ctx, [`--target-sha=${ctx.sha}`]).status, 0)
  const first = join(ctx.releaseRoot, ctx.sha)
  const second = commitNext(ctx, 'second')
  writeFileSync(join(ctx.root, 'fail-release'), `${join(ctx.releaseRoot, second)}\n`)

  const r = deploy(ctx, [`--target-sha=${second}`])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /previous release .* restored and live/)
  assert.equal(readlinkSync(join(ctx.releaseRoot, 'current')), first)
})

test('a previous release that cannot prove liveness is reported, never claimed restored', (t) => {
  const ctx = makeRepo(t, { gateOpen: true })
  assert.equal(deploy(ctx, [`--target-sha=${ctx.sha}`]).status, 0)
  const first = join(ctx.releaseRoot, ctx.sha)
  const second = commitNext(ctx, 'second')
  // The previous release's log already holds a heartbeat from its first start;
  // the rollback proof must not accept those stale lines.
  writeFileSync(join(ctx.root, 'fail-release'), `${join(ctx.releaseRoot, second)}\n${first}\n`)

  const r = deploy(ctx, [`--target-sha=${second}`])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /did not prove liveness; arena-worker stopped, manual recovery required/)
  assert.doesNotMatch(r.stderr, /restored and live/)
  assert.match(readFileSync(ctx.log, 'utf8'), /pm2 stop arena-worker/)
})

test('a real run refuses a Node binary that is not major 22', (t) => {
  const ctx = makeRepo(t, { gateOpen: true })
  writeFileSync(join(ctx.root, 'node-major'), '25\n')
  const r = deploy(ctx, [`--target-sha=${ctx.sha}`])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /requires Node 22, got 25/)
  assert.equal(existsSync(join(ctx.releaseRoot, ctx.sha)), false)
  assert.doesNotMatch(readFileSync(ctx.log, 'utf8'), /pm2|npm/)
})
