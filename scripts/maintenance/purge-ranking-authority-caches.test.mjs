import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const SCRIPT = resolve(ROOT, 'scripts/maintenance/purge-ranking-authority-caches.sh')
const CONTRACT = 'public-rank-policy-v7+serving-metric-authority-v2+csr2'
const SHA = 'a'.repeat(40)

function run(args, env = {}) {
  return spawnSync('bash', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  })
}

function writeExecutable(path, body) {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

test('plan mode is mutation-free and documents the exact cutover order', () => {
  const result = run(['plan'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(
    result.stdout,
    /safe application release -> this purge -> fail-closed production probes -> 0547 authority migration -> postflight -> bounded V2 canary -> writer scale-up/
  )
  assert.match(result.stdout, /plan mode performs no network or cache mutation/)
})

test('apply fails before tools or network when release targeting is absent', () => {
  const result = run(['apply'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /ARENA_EXPECTED_RELEASE_SHA/)
})

test('confirmation must bind the policy, project, owner, and release together', () => {
  const result = run(['apply'], {
    ARENA_EXPECTED_RELEASE_SHA: SHA,
    ARENA_VERCEL_PRODUCTION_ALIAS: 'arena.example',
    VERCEL_PROJECT_ID: 'prj_arena_production',
    VERCEL_ORG_ID: 'team_arena_owner',
    ARENA_PUBLIC_RANKING_CACHE_PURGE_CONFIRM: CONTRACT,
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /not bound to the exact contract, target, and release/)
})

test('apply pins clean pushed provenance and purges both Vercel cache classes once', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'arena-cache-purge-'))
  const calls = resolve(directory, 'calls')
  writeExecutable(
    resolve(directory, 'git'),
    `#!/usr/bin/env bash
set -eu
printf 'git %s\n' "$*" >> "$FAKE_CALLS"
case " $* " in
  *' status --porcelain=v1 --untracked-files=all '*) ;;
  *' rev-parse --verify HEAD '*) printf '%s\n' "$FAKE_SHA" ;;
  *' rev-parse --verify refs/remotes/origin/main '*) printf '%s\n' "$FAKE_SHA" ;;
  *' ls-remote --exit-code origin refs/heads/main '*) printf '%s\trefs/heads/main\n' "$FAKE_SHA" ;;
  *) exit 99 ;;
esac
`
  )
  writeExecutable(
    resolve(directory, 'vercel'),
    `#!/usr/bin/env bash
set -eu
printf 'vercel %s\n' "$*" >> "$FAKE_CALLS"
case " $* " in
  *' inspect arena.example --format=json '*)
    printf '{"id":"dpl_release","target":"production","readyState":"READY","aliases":["arena.example"]}\n'
    ;;
  *' api /v13/deployments/dpl_release --raw '*)
    printf '{"id":"dpl_release","projectId":"prj_arena_production","teamId":"team_arena_owner","target":"production","readyState":"READY","meta":{"githubCommitSha":"%s"}}\n' "$FAKE_DEPLOYMENT_SHA"
    ;;
  *' api /v1/projects/prj_arena_production/rolling-release?teamId=team_arena_owner --raw '*)
    printf '{"rollingRelease":null}\n'
    ;;
  *' cache purge --yes '*) ;;
  *) exit 99 ;;
esac
`
  )

  try {
    const result = run(['apply'], {
      PATH: `${directory}:${process.env.PATH}`,
      FAKE_CALLS: calls,
      FAKE_SHA: SHA,
      FAKE_DEPLOYMENT_SHA: SHA,
      ARENA_PUBLIC_RANKING_CACHE_PURGE_CONFIRM: `${CONTRACT}:team_arena_owner:prj_arena_production:arena.example:${SHA}`,
      ARENA_EXPECTED_RELEASE_SHA: SHA,
      ARENA_VERCEL_PRODUCTION_ALIAS: 'arena.example',
      VERCEL_PROJECT_ID: 'prj_arena_production',
      VERCEL_ORG_ID: 'team_arena_owner',
    })
    assert.equal(result.status, 0, result.stderr)
    const invocationLog = readFileSync(calls, 'utf8')
    assert.equal((invocationLog.match(/^vercel inspect /gm) ?? []).length, 2)
    assert.equal((invocationLog.match(/^vercel api /gm) ?? []).length, 4)
    assert.equal((invocationLog.match(/^vercel cache purge /gm) ?? []).length, 1)
    assert.match(invocationLog, /vercel cache purge --yes --cwd .* --no-color/)
    assert.doesNotMatch(invocationLog, /token/i)
    assert.match(result.stdout, new RegExp(`completed for release ${SHA} deployment dpl_release`))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('apply refuses split production traffic from an active rolling release', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'arena-cache-purge-rollout-'))
  const calls = resolve(directory, 'calls')
  writeExecutable(
    resolve(directory, 'git'),
    `#!/usr/bin/env bash
set -eu
case " $* " in
  *' status --porcelain=v1 --untracked-files=all '*) ;;
  *' rev-parse --verify HEAD '*) printf '%s\n' "$FAKE_SHA" ;;
  *' rev-parse --verify refs/remotes/origin/main '*) printf '%s\n' "$FAKE_SHA" ;;
  *' ls-remote --exit-code origin refs/heads/main '*) printf '%s\trefs/heads/main\n' "$FAKE_SHA" ;;
  *) exit 99 ;;
esac
`
  )
  writeExecutable(
    resolve(directory, 'vercel'),
    `#!/usr/bin/env bash
set -eu
printf 'vercel %s\n' "$*" >> "$FAKE_CALLS"
case " $* " in
  *' inspect arena.example --format=json '*)
    printf '{"id":"dpl_release","target":"production","readyState":"READY","aliases":["arena.example"]}\n'
    ;;
  *' api /v13/deployments/dpl_release --raw '*)
    printf '{"id":"dpl_release","projectId":"prj_arena_production","teamId":"team_arena_owner","target":"production","readyState":"READY","meta":{"githubCommitSha":"%s"}}\n' "$FAKE_DEPLOYMENT_SHA"
    ;;
  *' api /v1/projects/prj_arena_production/rolling-release?teamId=team_arena_owner --raw '*)
    printf '{"rollingRelease":{"state":"ACTIVE","canaryPercentage":50}}\n'
    ;;
  *) exit 99 ;;
esac
`
  )

  try {
    const result = run(['apply'], {
      PATH: `${directory}:${process.env.PATH}`,
      FAKE_CALLS: calls,
      FAKE_SHA: SHA,
      FAKE_DEPLOYMENT_SHA: SHA,
      ARENA_PUBLIC_RANKING_CACHE_PURGE_CONFIRM: `${CONTRACT}:team_arena_owner:prj_arena_production:arena.example:${SHA}`,
      ARENA_EXPECTED_RELEASE_SHA: SHA,
      ARENA_VERCEL_PRODUCTION_ALIAS: 'arena.example',
      VERCEL_PROJECT_ID: 'prj_arena_production',
      VERCEL_ORG_ID: 'team_arena_owner',
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /active Vercel rolling release/)
    const invocationLog = readFileSync(calls, 'utf8')
    assert.doesNotMatch(invocationLog, /vercel cache purge/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('apply refuses a production alias whose deployment commit differs from the release', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'arena-cache-purge-drift-'))
  const calls = resolve(directory, 'calls')
  writeExecutable(
    resolve(directory, 'git'),
    `#!/usr/bin/env bash
set -eu
case " $* " in
  *' status --porcelain=v1 --untracked-files=all '*) ;;
  *' rev-parse --verify HEAD '*) printf '%s\n' "$FAKE_SHA" ;;
  *' rev-parse --verify refs/remotes/origin/main '*) printf '%s\n' "$FAKE_SHA" ;;
  *' ls-remote --exit-code origin refs/heads/main '*) printf '%s\trefs/heads/main\n' "$FAKE_SHA" ;;
  *) exit 99 ;;
esac
`
  )
  writeExecutable(
    resolve(directory, 'vercel'),
    `#!/usr/bin/env bash
set -eu
printf 'vercel %s\n' "$*" >> "$FAKE_CALLS"
case " $* " in
  *' inspect arena.example --format=json '*)
    printf '{"id":"dpl_stale","target":"production","readyState":"READY","aliases":["arena.example"]}\n'
    ;;
  *' api /v13/deployments/dpl_stale --raw '*)
    printf '{"id":"dpl_stale","projectId":"prj_arena_production","teamId":"team_arena_owner","target":"production","readyState":"READY","meta":{"githubCommitSha":"%s"}}\n' "$FAKE_DEPLOYMENT_SHA"
    ;;
  *) exit 99 ;;
esac
`
  )

  try {
    const result = run(['apply'], {
      PATH: `${directory}:${process.env.PATH}`,
      FAKE_CALLS: calls,
      FAKE_SHA: SHA,
      FAKE_DEPLOYMENT_SHA: 'b'.repeat(40),
      ARENA_PUBLIC_RANKING_CACHE_PURGE_CONFIRM: `${CONTRACT}:team_arena_owner:prj_arena_production:arena.example:${SHA}`,
      ARENA_EXPECTED_RELEASE_SHA: SHA,
      ARENA_VERCEL_PRODUCTION_ALIAS: 'arena.example',
      VERCEL_PROJECT_ID: 'prj_arena_production',
      VERCEL_ORG_ID: 'team_arena_owner',
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /does not equal the exact project, owner, target, and release/)
    const invocationLog = readFileSync(calls, 'utf8')
    assert.doesNotMatch(invocationLog, /vercel cache purge/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('source never passes credentials on the Vercel command line', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  assert.doesNotMatch(source, /--token/)
  assert.match(source, /vercel cache purge --yes/)
  assert.match(source, /serving-metric-authority-v2/)
  assert.match(source, /COPIER_SNAPSHOT_RECORDS_CONTRACT = 'csr2'/)
  assert.match(source, /meta\.githubCommitSha == \$release_sha/)
  assert.match(source, /POST_PURGE_DEPLOYMENT_ID/)
  assert.match(source, /\.rollingRelease == null/)
})
