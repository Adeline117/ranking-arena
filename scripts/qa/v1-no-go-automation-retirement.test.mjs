import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const root = process.cwd()

const retiredEntrypoints = [
  'scripts/openclaw/auto-fix.mjs',
  'scripts/cron/auto-fix-platform.ts',
  'scripts/openclaw/merge-autofix-to-main.sh',
  'scripts/openclaw/weekly-self-check.sh',
  'scripts/openclaw/schema-canary-sentinel.mjs',
  'scripts/openclaw/fetch-lbank.mjs',
  'scripts/openclaw/fetch-htx.mjs',
  'scripts/openclaw/fetch-blofin.mjs',
  'scripts/openclaw/fetch-phemex.mjs',
  'scripts/openclaw/fetch-bingx-spot.mjs',
  'scripts/vps-deploy/setup-crontab.sh',
  'scripts/vps-deploy/setup.sh',
  'scripts/vps-deploy/setup-env.sh',
  'scripts/vps-deploy/check-vps.sh',
  'scripts/vps-deploy/cron-runner.js',
  'scripts/vps-deploy/scraper-cron.mjs',
  'scripts/vps-scrapers/bybit-detail-pnl.mjs',
  'scripts/sync-vps-key.sh',
  'infra/vps-cron/deploy-vps-cron.sh',
  'infra/vps-cron/vps-cron-htx.sh',
  'worker/deploy.sh',
]

const forbiddenTombstoneSyntax =
  /\bimport\b|\brequire\(|process\.env|dotenv|@supabase|createClient|fetch\(|https?:\/\/|child_process|exec(?:Sync)?\(|spawn(?:Sync)?\(|cron\.schedule|\bcrontab\s+-|\bssh\b|\bscp\b|\bpm2\b|\bvercel\b|\bclaude\b|writeFile(?:Sync)?\(|appendFile(?:Sync)?\(|\.from\(|\.rpc\(|\.upsert\(|\.insert\(|\.update\(|\.delete\(/i

function run(relativePath, args = []) {
  const executable = relativePath.endsWith('.sh') ? '/bin/bash' : process.execPath
  const commandArgs = [relativePath, ...args]

  return spawnSync(executable, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    env: {},
    timeout: 5_000,
  })
}

function assertRetiredResult(result, label) {
  assert.equal(result.error, undefined, `${label} must launch`)
  assert.equal(result.status, 2, `${label} must fail closed with exit 2`)
  assert.equal(result.stdout, '', `${label} must not claim success on stdout`)
  assert.match(result.stderr, /\[RETIRED\]/, `${label} must identify retirement on stderr`)
}

test('V1 autonomous actuator entrypoints are inert compatibility tombstones', () => {
  const invocationSets = [[], ['--force', '--dry-run'], ['--unexpected-legacy-flag']]

  for (const entrypoint of retiredEntrypoints) {
    const source = readFileSync(join(root, entrypoint), 'utf8')
    const basename = entrypoint.split('/').at(-1)

    assert.match(source, /\[RETIRED\]/, `${entrypoint} must identify itself as retired`)
    assert.match(source, /process\.exitCode = 2|exit 2/, `${entrypoint} must return exit 2`)
    assert.match(source, new RegExp(basename.replace('.', '\\.'), 'u'))
    if (entrypoint.endsWith('.sh')) {
      assert.notEqual(
        statSync(join(root, entrypoint)).mode & 0o111,
        0,
        `${entrypoint} must stay executable`
      )
    }
    assert.doesNotMatch(
      source,
      forbiddenTombstoneSyntax,
      `${entrypoint} must not retain a runtime actuator capability`
    )

    for (const args of invocationSets) {
      assertRetiredResult(run(entrypoint, args), `${entrypoint} ${args.join(' ')}`)
    }
  }
})

test('legacy VPS inspection tombstone retains no remote inspection capability', () => {
  const entrypoint = 'scripts/vps-deploy/check-vps.sh'
  const source = readFileSync(join(root, entrypoint), 'utf8')

  assert.equal(
    source,
    "#!/bin/bash\n\nprintf '%s\\n' '[RETIRED] check-vps.sh is disabled during V1 NO-GO.' >&2\nexit 2\n"
  )
  assert.doesNotMatch(
    source,
    /\b(?:host|ssh|pm2|curl|env|log)\b|\b(?:\d{1,3}\.){3}\d{1,3}\b/i,
    `${entrypoint} must retain no host, IP, SSH, PM2, curl, env, or log capability name`
  )
})

test('legacy VPS cron configuration contains no executable schedule', () => {
  const configPath = join(root, 'infra/vps-cron/vps-crontab-htx.txt')
  const source = readFileSync(configPath, 'utf8')

  assert.match(source, /^# RETIRED V1 compatibility configuration\./)
  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    assert.ok(!trimmed || trimmed.startsWith('#'), 'retired cron config must contain comments only')
  }
  assert.doesNotMatch(source, /CRON_SECRET|API_ENDPOINT|\/root\/|\bdelete\b/i)
})

const guardedObservers = [
  {
    path: 'scripts/openclaw/health-monitor.mjs',
    flag: '--with-auto-fix',
    forbidden: /triggerAutoFix|child_process|spawn\(|auto-fix\.mjs|getActiveFetcherFailures/,
    nextRuntimeLoad: "await import('dotenv')",
  },
  {
    path: 'scripts/openclaw/pipeline-health-monitor.mjs',
    flag: '--auto-cleanup',
    forbidden: /createClient|@supabase|cleanupStuckLogs|\.update\(/,
    nextRuntimeLoad: "await import('dotenv')",
  },
  {
    path: 'scripts/openclaw/sentry-convergence.mjs',
    flag: '--resolve-stale',
    forbidden: /resolveStaleIssues|method:\s*['"]PUT['"]/,
    nextRuntimeLoad: "await import('dotenv')",
  },
  {
    path: 'scripts/openclaw/field-coverage-canary.mts',
    flag: '--update-baseline',
    forbidden: /writeFileSync|writeFile\(/,
    nextRuntimeLoad: "await import('../../lib/ingest/db')",
  },
]

test('retained observers reject every former mutation flag before loading runtime dependencies', () => {
  for (const observer of guardedObservers) {
    const source = readFileSync(join(root, observer.path), 'utf8')
    const guard = source.indexOf(`process.argv.includes('${observer.flag}')`)
    const nextRuntimeLoad = source.indexOf(observer.nextRuntimeLoad)

    assert.ok(guard >= 0, `${observer.path} must guard ${observer.flag}`)
    assert.ok(nextRuntimeLoad >= 0, `${observer.path} must have its expected runtime dependency`)
    assert.ok(
      guard < nextRuntimeLoad,
      `${observer.path} must reject ${observer.flag} before loading`
    )
    assert.doesNotMatch(
      source,
      observer.forbidden,
      `${observer.path} must not retain mutation code`
    )
    assertRetiredResult(run(observer.path, [observer.flag]), `${observer.path} ${observer.flag}`)
  }
})
