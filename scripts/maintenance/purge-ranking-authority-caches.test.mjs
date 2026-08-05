import assert from 'node:assert/strict'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const SCRIPT = resolve(ROOT, 'scripts/maintenance/purge-ranking-authority-caches.sh')
const CONTRACT = 'public-rank-policy-v4+serving-metric-authority-v1'
const SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)
const PUBLIC_EPOCH = 'public-rank-policy-v4'
const SERVING_EPOCH = 'serving-metric-authority-v1'

function run(args, env = {}, script = SCRIPT, cwd = ROOT) {
  return spawnSync('bash', [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  })
}

function writeExecutable(path, body) {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

function createReleaseFixture({ publicEpoch = PUBLIC_EPOCH, servingEpoch = SERVING_EPOCH } = {}) {
  const directory = mkdtempSync(resolve(tmpdir(), 'arena-cache-purge-'))
  const calls = resolve(directory, 'calls')
  const releaseRoot = resolve(directory, 'release')
  const releaseScript = resolve(
    releaseRoot,
    'scripts/maintenance/purge-ranking-authority-caches.sh'
  )
  mkdirSync(resolve(releaseRoot, 'scripts/maintenance'), { recursive: true })
  mkdirSync(resolve(releaseRoot, 'lib/rankings'), { recursive: true })
  mkdirSync(resolve(releaseRoot, 'lib/data/serving'), { recursive: true })
  copyFileSync(SCRIPT, releaseScript)
  writeFileSync(
    resolve(releaseRoot, 'lib/rankings/publication-policy.ts'),
    `export const PUBLIC_RANKING_CACHE_EPOCH = '${publicEpoch}'\n`
  )
  writeFileSync(
    resolve(releaseRoot, 'lib/data/serving/cache-policy.ts'),
    `export const SERVING_METRIC_AUTHORITY_CACHE_EPOCH = '${servingEpoch}'\n`
  )
  writeExecutable(
    resolve(directory, 'git'),
    `#!/usr/bin/env bash
set -eu
printf 'git %s\n' "$*" >> "$FAKE_CALLS"
case " $* " in
  *' status --porcelain=v1 --untracked-files=all '*) printf '%s' "$FAKE_DIRTY_STATUS" ;;
  *' rev-parse --verify HEAD '*) printf '%s\n' "$FAKE_HEAD_SHA" ;;
  *' rev-parse --verify refs/remotes/origin/main '*) printf '%s\n' "$FAKE_LOCAL_MAIN_SHA" ;;
  *' ls-remote --exit-code origin refs/heads/main '*) printf '%s\trefs/heads/main\n' "$FAKE_LIVE_MAIN_SHA" ;;
  *) exit 99 ;;
esac
`
  )
  writeExecutable(
    resolve(directory, 'vercel'),
    `#!/usr/bin/env bash
set -eu
printf 'vercel %s\n' "$*" >> "$FAKE_CALLS"
`
  )

  return { calls, directory, releaseRoot, releaseScript }
}

function withReleaseFixture(options, callback) {
  const fixture = createReleaseFixture(options)
  try {
    callback(fixture)
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
  }
}

function runFixture(fixture, overrides = {}) {
  return run(
    ['apply'],
    {
      PATH: `${fixture.directory}:${process.env.PATH}`,
      FAKE_CALLS: fixture.calls,
      FAKE_DIRTY_STATUS: '',
      FAKE_HEAD_SHA: SHA,
      FAKE_LOCAL_MAIN_SHA: SHA,
      FAKE_LIVE_MAIN_SHA: SHA,
      ARENA_PUBLIC_RANKING_CACHE_PURGE_CONFIRM: `${CONTRACT}:team_arena_owner:prj_arena_production:${SHA}`,
      ARENA_EXPECTED_RELEASE_SHA: SHA,
      VERCEL_PROJECT_ID: 'prj_arena_production',
      VERCEL_ORG_ID: 'team_arena_owner',
      ...overrides,
    },
    fixture.releaseScript,
    fixture.releaseRoot
  )
}

function readInvocations(fixture) {
  return readFileSync(fixture.calls, 'utf8').trimEnd().split('\n')
}

function assertFailsWithoutPurge(fixture, overrides) {
  const result = runFixture(fixture, overrides)
  assert.notEqual(result.status, 0, result.stdout)
  const vercelCalls = readInvocations(fixture).filter((line) => line.startsWith('vercel '))
  assert.deepEqual(vercelCalls, [])
  return result
}

test('plan mode is mutation-free and documents the exact cutover order', () => {
  const result = run(['plan'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /safe application release -> authority migration -> this purge/)
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
    VERCEL_PROJECT_ID: 'prj_arena_production',
    VERCEL_ORG_ID: 'team_arena_owner',
    ARENA_PUBLIC_RANKING_CACHE_PURGE_CONFIRM: CONTRACT,
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /not bound to the exact contract, target, and release/)
})

test('apply pins clean pushed provenance and purges both Vercel cache classes once', () => {
  withReleaseFixture({}, (fixture) => {
    const result = runFixture(fixture)
    assert.equal(result.status, 0, result.stderr)
    const expectedGitCalls = [
      `git -C ${fixture.releaseRoot} status --porcelain=v1 --untracked-files=all`,
      `git -C ${fixture.releaseRoot} rev-parse --verify HEAD`,
      `git -C ${fixture.releaseRoot} rev-parse --verify refs/remotes/origin/main`,
      `git -C ${fixture.releaseRoot} ls-remote --exit-code origin refs/heads/main`,
    ]
    const expectedVercelCall = `vercel cache purge --yes --cwd ${fixture.releaseRoot} --no-color`
    const invocations = readInvocations(fixture)
    const actualVercelCalls = invocations.filter((line) => line.startsWith('vercel '))
    assert.deepEqual(
      invocations.filter((line) => line.startsWith('git ')),
      expectedGitCalls
    )
    assert.deepEqual(actualVercelCalls, [expectedVercelCall])
    assert.deepEqual(invocations, [...expectedGitCalls, expectedVercelCall])
    assert.doesNotMatch(actualVercelCalls[0], /(?:^|\s)--type(?:\s|$)/)
    assert.doesNotMatch(invocations.join('\n'), /token/i)
    assert.match(result.stdout, new RegExp(`completed for release ${SHA}`))
  })
})

test('apply rejects a dirty release worktree before any Vercel purge', () => {
  withReleaseFixture({}, (fixture) => {
    const result = assertFailsWithoutPurge(fixture, {
      FAKE_DIRTY_STATUS: ' M package.json\n',
    })
    assert.match(result.stderr, /clean release worktree/)
  })
})

test('apply rejects a HEAD that differs from the expected release', () => {
  withReleaseFixture({}, (fixture) => {
    const result = assertFailsWithoutPurge(fixture, { FAKE_HEAD_SHA: OTHER_SHA })
    assert.match(result.stderr, /expected local origin\/main SHA/)
  })
})

test('apply rejects local origin main when it differs from the expected release', () => {
  withReleaseFixture({}, (fixture) => {
    const result = assertFailsWithoutPurge(fixture, { FAKE_LOCAL_MAIN_SHA: OTHER_SHA })
    assert.match(result.stderr, /expected local origin\/main SHA/)
  })
})

test('apply rejects live origin main when it differs from the expected release', () => {
  withReleaseFixture({}, (fixture) => {
    const result = assertFailsWithoutPurge(fixture, { FAKE_LIVE_MAIN_SHA: OTHER_SHA })
    assert.match(result.stderr, /live pushed origin\/main SHA/)
  })
})

test('apply rejects a release whose public ranking epoch differs from the purge contract', () => {
  withReleaseFixture({ publicEpoch: 'public-rank-policy-mutant' }, (fixture) => {
    const result = assertFailsWithoutPurge(fixture)
    assert.match(result.stderr, /cache authority epochs/)
  })
})

test('apply rejects a release whose serving metric epoch differs from the purge contract', () => {
  withReleaseFixture({ servingEpoch: 'serving-metric-authority-mutant' }, (fixture) => {
    const result = assertFailsWithoutPurge(fixture)
    assert.match(result.stderr, /cache authority epochs/)
  })
})

test('source never passes credentials on the Vercel command line', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  assert.doesNotMatch(source, /--token/)
  assert.doesNotMatch(source, /vercel cache purge[^\n]*--type/)
  assert.match(source, /vercel cache purge --yes/)
})
