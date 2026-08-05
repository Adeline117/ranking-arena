import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { TextDecoder } from 'node:util'

const root = path.resolve(import.meta.dirname, '../..')
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })
const maxGitOutputBytes = 64 * 1024 * 1024
const ignoreRules = fs.readFileSync(path.join(root, '.vercelignore'), 'utf8')
const deployGate = fs.readFileSync(path.join(root, '.github/workflows/deploy-gate.yml'), 'utf8')
const releaseControl = fs.readFileSync(
  path.join(root, '.github/workflows/vercel-release-control.yml'),
  'utf8'
)
const releaseControlScript = fs.readFileSync(
  path.join(root, 'scripts/ci/enforce-vercel-release-control.mjs'),
  'utf8'
)
const nextConfig = fs.readFileSync(path.join(root, 'next.config.ts'), 'utf8')
const ciWorkflow = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8')
const vercelConfig = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'))
const sourceTestName = /\.(?:test|spec)\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$/i
let ignoreFixture

function isolatedGitEnv() {
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
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = os.devNull
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GIT_TERMINAL_PROMPT = '0'
  env.LC_ALL = 'C'
  return env
}

function runGit(args, { cwd = root, input, allowedStatuses = [0] } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'buffer',
    env: isolatedGitEnv(),
    input,
    maxBuffer: maxGitOutputBytes,
  })
  assert.equal(result.error, undefined, `git ${args[0]} failed to start: ${String(result.error)}`)
  assert.ok(
    allowedStatuses.includes(result.status),
    Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : `git ${args[0]} failed`
  )
  assert.equal(result.signal, null, `git ${args[0]} was terminated by ${result.signal}`)
  assert.ok(Buffer.isBuffer(result.stdout), `git ${args[0]} stdout must be a Buffer`)
  return result
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

function trackedEntries(pathspec) {
  const result = runGit(['ls-files', '--stage', '-z', '--', pathspec])
  return nulRecords(result.stdout, 'git ls-files').map((record) => {
    const separator = record.indexOf(9)
    assert.ok(separator > 0 && separator < record.length - 1, 'Git index record is malformed')
    const metadata = record.subarray(0, separator).toString('ascii')
    const match = /^(?<mode>[0-7]{6}) (?<object>[0-9a-f]{40}|[0-9a-f]{64}) (?<stage>[0-3])$/u.exec(
      metadata
    )
    assert.ok(match, 'Git index metadata is malformed')
    const relativePath = decodeUtf8(record.subarray(separator + 1), 'Git index path')
    assertCanonicalRepositoryPath(relativePath)
    return { mode: match.groups.mode, path: relativePath, stage: match.groups.stage }
  })
}

function trackedRegularPaths(pathspec) {
  const paths = trackedEntries(pathspec).map((entry) => {
    assert.equal(entry.stage, '0', `${entry.path} must not have an unmerged index stage`)
    assert.match(entry.mode, /^100(?:644|755)$/u, `${entry.path} must have a regular Git mode`)
    return entry.path
  })
  assert.equal(new Set(paths).size, paths.length, `${pathspec} index paths must be unique`)
  return paths.sort()
}

function vercelIgnoreRepository() {
  if (ignoreFixture !== undefined) return ignoreFixture
  ignoreFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-vercel-upload-'))
  runGit(['init', '--quiet'], { cwd: ignoreFixture })
  return ignoreFixture
}

function ignoredVercelPaths(relativePaths, rules = ignoreRules) {
  const paths = [...relativePaths]
  for (const relativePath of paths) assertCanonicalRepositoryPath(relativePath)
  assert.equal(
    new Set(paths).size,
    paths.length,
    'Vercel classification input paths must be unique'
  )
  if (paths.length === 0) return new Set()

  const directory = vercelIgnoreRepository()
  fs.writeFileSync(path.join(directory, '.gitignore'), rules)
  const input = Buffer.concat(
    paths.flatMap((relativePath) => [Buffer.from(relativePath), Buffer.of(0)])
  )
  const result = runGit(['check-ignore', '--no-index', '-z', '--stdin'], {
    cwd: directory,
    input,
    allowedStatuses: [0, 1],
  })
  const ignored = nulRecords(result.stdout, 'git check-ignore').map((record) => {
    const relativePath = decodeUtf8(record, 'git check-ignore path')
    assertCanonicalRepositoryPath(relativePath)
    assert.equal(paths.includes(relativePath), true, `${relativePath} was not requested`)
    return relativePath
  })
  assert.equal(new Set(ignored).size, ignored.length, 'git check-ignore returned duplicate paths')
  assert.equal(
    result.status,
    ignored.length === 0 ? 1 : 0,
    'git check-ignore status/output drifted'
  )
  return new Set(ignored)
}

function ignoredByVercelRules(relativePath) {
  return ignoredVercelPaths([relativePath]).has(relativePath)
}

after(() => {
  if (ignoreFixture !== undefined) {
    fs.rmSync(ignoreFixture, { recursive: true, force: true })
    ignoreFixture = undefined
  }
})

function assertProjectRegularFile(relativePath) {
  const metadata = fs.lstatSync(path.join(root, relativePath))
  assert.equal(metadata.isFile(), true, `${relativePath} must remain a regular project file`)
}

function telegramFunctions() {
  const marker = '          send_telegram_alert() {'
  const closing = '\n          }\n'
  const functions = []
  let cursor = 0
  while ((cursor = deployGate.indexOf(marker, cursor)) !== -1) {
    const end = deployGate.indexOf(closing, cursor)
    assert.notEqual(end, -1, 'Telegram helper must have a closing brace')
    functions.push(
      deployGate
        .slice(cursor, end + closing.length - 1)
        .split('\n')
        .map((line) => line.replace(/^ {10}/, ''))
        .join('\n')
    )
    cursor = end + closing.length
  }
  return functions
}

function runTelegramFunction({ http = '200', curlExit = '0', token = 'bot-secret', chat = '42' }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-telegram-alert-'))
  try {
    const fakeCurl = path.join(directory, 'curl')
    fs.writeFileSync(
      fakeCurl,
      [
        '#!/usr/bin/env bash',
        'printf "%s" "${FAKE_CURL_HTTP:-000}"',
        'exit "${FAKE_CURL_EXIT:-0}"',
        '',
      ].join('\n')
    )
    fs.chmodSync(fakeCurl, 0o755)
    const summary = path.join(directory, 'summary.md')
    fs.writeFileSync(summary, '')
    const result = spawnSync(
      'bash',
      ['-c', `${telegramFunctions()[0]}\nsend_telegram_alert "test alert"`],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          FAKE_CURL_HTTP: http,
          FAKE_CURL_EXIT: curlExit,
          GITHUB_STEP_SUMMARY: summary,
          TELEGRAM_BOT_TOKEN: token,
          TELEGRAM_ALERT_CHAT_ID: chat,
        },
      }
    )
    return { ...result, summary: fs.readFileSync(summary, 'utf8') }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

function runVercelBuildCommand({ vercelEnv, ciTypesAttested = '' }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-vercel-build-command-'))
  try {
    const fakeNpm = path.join(directory, 'npm')
    fs.writeFileSync(
      fakeNpm,
      [
        '#!/usr/bin/env bash',
        'printf "vercel=%s ci=%s preview_skip=%s args=%s\\n" "$VERCEL_ENV" "$ARENA_CI_TYPES_ATTESTED" "$ARENA_VERCEL_PREVIEW_SKIP_TYPES" "$*"',
        '',
      ].join('\n')
    )
    fs.chmodSync(fakeNpm, 0o755)
    return spawnSync('bash', ['-c', vercelConfig.buildCommand], {
      encoding: 'utf8',
      env: {
        PATH: `${directory}:${process.env.PATH}`,
        VERCEL_ENV: vercelEnv,
        ARENA_CI_TYPES_ATTESTED: ciTypesAttested,
      },
    })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('uploads every package lifecycle file required by package.json', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(packageJson.scripts.prepare, 'node install-git-hooks.mjs')
  assert.match(packageJson.scripts.postbuild, /qa:build-bigint/)
  assert.equal(packageJson.scripts['qa:build-bigint'], 'node check-bigint-build-output.mjs')
  assertProjectRegularFile('install-git-hooks.mjs')
  assert.equal(ignoredByVercelRules('install-git-hooks.mjs'), false)
  assert.equal(ignoredByVercelRules('scripts/install-git-hooks.mjs'), true)
  assert.equal(ignoredByVercelRules('check-bigint-build-output.mjs'), false)
  assert.equal(ignoredByVercelRules('scripts/qa/check-bigint-build-output.mjs'), true)
})

test('excludes repository control-plane and separately deployed roots from Web uploads', () => {
  const exactRules = ignoreRules
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  const excludedRoots = new Map([
    [
      '/supabase/',
      [
        'supabase/config.toml',
        'supabase/migrations/20260722055000_metric_trust_source_page_lineage_forward_repair.sql',
      ],
    ],
    ['/infra/', ['infra/vps-playwright/ecosystem.config.js']],
    ['/k6/', ['k6/config.js', 'k6/smoke-test.js']],
    ['/.github/', ['.github/CODEOWNERS', '.github/workflows/ci.yml']],
    ['/.cursor/', ['.cursor/mcp.json']],
    ['/.githooks/', ['.githooks/pre-commit', '.githooks/commit-msg']],
  ])

  for (const [rule, representativePaths] of excludedRoots) {
    assert.equal(
      exactRules.filter((candidate) => candidate === rule).length,
      1,
      `${rule} must have one explicit fail-closed upload exclusion`
    )
    for (const relativePath of representativePaths) {
      assertProjectRegularFile(relativePath)
      assert.equal(ignoredByVercelRules(relativePath), true, `${relativePath} must not upload`)
    }
  }
})

test('keeps the complete Web install and build closure in the Vercel upload', () => {
  const requiredUploads = [
    '.browserslistrc',
    '.npmrc',
    '.nvmrc',
    'package.json',
    'package-lock.json',
    'next.config.ts',
    'tsconfig.json',
    'postcss.config.mjs',
    'vercel.json',
    'install-git-hooks.mjs',
    'check-bigint-build-output.mjs',
    'instrumentation.ts',
    'sentry.client.config.ts',
    'sentry.edge.config.ts',
    'sentry.server.config.ts',
    'proxy.ts',
    'app/globals.css',
    'app/layout.tsx',
    'app/favicon.ico',
    'lib/config/webpack-warning-policy.mjs',
    'lib/supabase/server.ts',
    'public/icons/icon.svg',
    'vendor/brace-expansion-compat/package.json',
    'vendor/brace-expansion-compat/index.cjs',
    'vendor/brace-expansion-compat/index.mjs',
  ]

  for (const relativePath of requiredUploads) {
    assertProjectRegularFile(relativePath)
    assert.equal(ignoredByVercelRules(relativePath), false, `${relativePath} must upload`)
  }
})

test('keeps unrelated operational scripts out of the Vercel upload', () => {
  assert.equal(ignoredByVercelRules('scripts/openclaw/daily-pipeline-report.mjs'), true)
  assert.equal(ignoredByVercelRules('scripts/post-deploy-check.sh'), true)
})

test('uploads every tracked public asset while excluding the service-worker test inventory', () => {
  const publicAssets = trackedRegularPaths('public')
  const serviceWorkerFiles = trackedRegularPaths('__tests__/service-worker')
  const serviceWorkerTestSources = serviceWorkerFiles.filter((relativePath) =>
    sourceTestName.test(relativePath)
  )
  assert.ok(publicAssets.length > 0, 'tracked public asset inventory must not be empty')
  assert.ok(serviceWorkerTestSources.length > 0, 'service-worker test source inventory disappeared')

  const ignored = ignoredVercelPaths([...publicAssets, ...serviceWorkerFiles])
  for (const relativePath of publicAssets) {
    assert.equal(ignored.has(relativePath), false, `${relativePath} must upload`)
  }
  for (const relativePath of serviceWorkerFiles) {
    assert.equal(ignored.has(relativePath), true, `${relativePath} must not upload`)
  }
  for (const relativePath of serviceWorkerTestSources) {
    assert.equal(ignored.has(relativePath), true, `${relativePath} test source must not upload`)
  }

  const broadPublicExclusion = `${ignoreRules.trimEnd()}\n/public/\n`
  const mutatedIgnored = ignoredVercelPaths(publicAssets, broadPublicExclusion)
  assert.ok(mutatedIgnored.size > 0, 'broad public mutation must ignore tracked runtime assets')
  assert.throws(() => {
    for (const relativePath of publicAssets) {
      assert.equal(mutatedIgnored.has(relativePath), false, `${relativePath} must upload`)
    }
  }, /must upload/u)
})

test('keeps isolated mobile release tooling out of the Vercel upload', () => {
  assert.equal(ignoredByVercelRules('tooling/mobile-release/package.json'), true)
  assert.equal(ignoredByVercelRules('tooling/mobile-release/package-lock.json'), true)
})

test('keeps Vercel candidate failures reproducible and diagnosable', () => {
  const workflow = deployGate
  assert.doesNotMatch(workflow, /vercel@latest/)
  assert.match(
    workflow,
    /vercel@56\.2\.1 deploy --prod --skip-domain --yes --no-wait --meta gateSha/
  )
  assert.doesNotMatch(workflow, /vercel@56\.2\.1 deploy --prod[^\n]+--logs/)
  assert.match(workflow, /vercel@56\.2\.1 deploy --dry --format=json/)
  assert.match(workflow, /Vercel upload manifest is missing required build file/)
  assert.match(workflow, /--build-env VERCEL_BUILD_SYSTEM_REPORT=1/)
  assert.match(workflow, /timeout 60s npx vercel@56\.2\.1 inspect "\$CANDIDATE_URL" --logs/)
  assert.match(workflow, /timeout 60s npx vercel@56\.2\.1 inspect "\$DEPLOY_URL" --logs/)
  assert.match(workflow, /::error title=Vercel candidate build failed::/)
  assert.match(workflow, /::error title=Vercel candidate did not become ready::/)
})

test('keeps Deploy Gate as the only writer of production domains', () => {
  assert.match(releaseControl, /push:\n    branches: \[main\]/)
  assert.match(releaseControl, /workflow_dispatch:/)
  assert.match(releaseControl, /cancel-in-progress: false/)
  assert.match(releaseControl, /uses: actions\/checkout@[0-9a-f]{40}/)
  assert.match(releaseControl, /run: node scripts\/ci\/enforce-vercel-release-control\.mjs/)
  assert.match(releaseControlScript, /https:\/\/api\.vercel\.com/)
  assert.match(
    releaseControlScript,
    /\/v9\/projects\/\$\{encodeURIComponent\(resolvedProjectId\)\}/
  )
  assert.match(releaseControlScript, /JSON\.stringify\(\{ autoAssignCustomDomains: false \}\)/)
  assert.match(releaseControlScript, /payload\.id !== projectId/)
  assert.match(releaseControlScript, /payload\.autoAssignCustomDomains !== false/)
  assert.match(releaseControlScript, /method: 'PATCH'/)
  assert.match(releaseControlScript, /method: 'GET'/)
  assert.match(
    releaseControlScript,
    /Vercel autoAssignCustomDomains=false; Deploy Gate is the sole production writer/
  )
})

test('waits for Vercel READY within the job budget before allowing promotion', () => {
  const workflow = deployGate
  assert.match(workflow, /cancel-in-progress: false/)
  assert.match(workflow, /id: wait_candidate/)
  assert.match(workflow, /node scripts\/ci\/wait-for-vercel-deployment\.mjs "\$DEPLOY_URL"/)
  assert.match(workflow, /VERCEL_DEPLOY_WAIT_TIMEOUT_MS: '1200000'/)
  assert.match(workflow, /VERCEL_DEPLOY_POLL_INTERVAL_MS: '15000'/)
  assert.match(workflow, /VERCEL_DEPLOY_REQUEST_TIMEOUT_MS: '15000'/)
  assert.match(
    workflow,
    /if: steps\.fresh\.outputs\.deploy == 'true' && steps\.wait_candidate\.outcome == 'success'/
  )
})

test('revokes production write authority when a candidate is no longer exact main', () => {
  assert.match(deployGate, /Deploy decision \(run SHA is exact main and newer than serving\?\)/)
  assert.equal(deployGate.match(/^\s+MAIN_SHA=\$\(git rev-parse FETCH_HEAD\)$/gm)?.length, 2)
  assert.equal(deployGate.match(/if \[ "\$HEAD_SHA" != "\$MAIN_SHA" \]; then/g)?.length, 2)
  assert.match(deployGate, /skip stale candidate[\s\S]*echo "deploy=false"/)
  assert.match(deployGate, /superseded during build[\s\S]*echo "promoted=false"[\s\S]*exit 0/)
  assert.match(deployGate, /PROMOTE_MAIN_SHA=\$\(git rev-parse FETCH_HEAD\)/)
  assert.match(
    deployGate,
    /if \[ "\$HEAD_SHA" != "\$PROMOTE_MAIN_SHA" \]; then[\s\S]*echo "promoted=false"[\s\S]*exit 0[\s\S]*echo "promoted=true"[\s\S]*npx vercel@56\.2\.1 promote/
  )
  assert.doesNotMatch(deployGate, /不再要求恰好等于 HEAD/)
})

test('reasserts the single production writer without ever skipping promoted smoke', () => {
  assert.match(
    deployGate,
    /- name: Pin release-control helpers for this Gate run\n        run: \|[\s\S]*install -m 700 scripts\/ci\/enforce-vercel-release-control\.mjs "\$RUNNER_TEMP\/enforce-vercel-release-control\.mjs"[\s\S]*install -m 700 scripts\/ci\/validate-release-health\.mjs "\$RUNNER_TEMP\/validate-release-health\.mjs"[\s\S]*install -m 700 scripts\/ci\/verify-metric-trust-release-readiness\.mjs "\$RUNNER_TEMP\/verify-metric-trust-release-readiness\.mjs"[\s\S]*install -m 700 scripts\/ci\/verify-worker-release-readiness\.mjs "\$RUNNER_TEMP\/verify-worker-release-readiness\.mjs"[\s\S]*install -m 700 scripts\/ci\/worker-release-id\.mjs "\$RUNNER_TEMP\/worker-release-id\.mjs"/
  )
  assert.equal(
    deployGate.match(/node "\$RUNNER_TEMP\/enforce-vercel-release-control\.mjs"/g)?.length,
    4
  )
  assert.ok(
    deployGate.indexOf('Pin release-control helpers for this Gate run') <
      deployGate.indexOf('git checkout --quiet "$HEAD_SHA"')
  )
  assert.match(
    deployGate,
    /- name: Require production metric-trust schema before deploy\n        if: steps\.fresh\.outputs\.deploy == 'true'[\s\S]*NEXT_PUBLIC_SUPABASE_URL: \$\{\{ secrets\.NEXT_PUBLIC_SUPABASE_URL \}\}[\s\S]*SUPABASE_SERVICE_ROLE_KEY: \$\{\{ secrets\.SUPABASE_SERVICE_ROLE_KEY \}\}[\s\S]*node "\$RUNNER_TEMP\/verify-metric-trust-release-readiness\.mjs"/
  )
  assert.ok(
    deployGate.indexOf('Require production metric-trust schema before deploy') <
      deployGate.indexOf('Deploy to Vercel (build on Vercel infra)')
  )
  assert.match(
    deployGate,
    /- name: Require exact ingest worker fleet before promotion[\s\S]*id: worker_fleet[\s\S]*CRON_SECRET: \$\{\{ secrets\.CRON_SECRET \}\}[\s\S]*WORKER_READINESS_BASE_URL: \$\{\{ steps\.deploy_candidate\.outputs\.url \}\}[\s\S]*WORKER_RELEASE_ID: \$\{\{ steps\.worker_release\.outputs\.id \}\}[\s\S]*npx vercel@56\.2\.1 curl[\s\S]*"\/api\/health\/worker-release-readiness"[\s\S]*--deployment "\$WORKER_READINESS_BASE_URL" \\[\s\S]*-- \\[\s\S]*--max-redirs 0[\s\S]*WORKER_READINESS_PAYLOAD_FILE="\$PAYLOAD_FILE"[\s\S]*node "\$RUNNER_TEMP\/verify-worker-release-readiness\.mjs"/
  )
  assert.match(deployGate, /--build-env ARENA_WORKER_RELEASE_ID="\$WORKER_RELEASE_ID"/)
  assert.match(deployGate, /--env ARENA_WORKER_RELEASE_ID="\$WORKER_RELEASE_ID"/)
  assert.doesNotMatch(deployGate, /vercel@56\.2\.1 curl[\s\S]{0,500}--token/)
  assert.doesNotMatch(deployGate, /secrets\.VERCEL_AUTOMATION_BYPASS_SECRET/)
  assert.ok(
    deployGate.indexOf('Wait for candidate READY (bounded)') <
      deployGate.indexOf('Require exact ingest worker fleet before promotion')
  )
  assert.ok(
    deployGate.indexOf('Require exact ingest worker fleet before promotion') <
      deployGate.indexOf('Promote only if candidate is not stale after build')
  )
  assert.match(
    deployGate,
    /if: steps\.fresh\.outputs\.deploy == 'true' && steps\.wait_candidate\.outcome == 'success' && steps\.worker_fleet\.outcome == 'success'/
  )
  assert.match(
    deployGate,
    /echo "promoted=true" >> "\$GITHUB_OUTPUT"[\s\S]*npx vercel@56\.2\.1 promote/
  )
  assert.match(
    deployGate,
    /if: always\(\) && steps\.promote_candidate\.outputs\.promoted == 'true'/
  )
  assert.match(
    deployGate,
    /RELEASE_CONTROL_RESTORED: \$\{\{ steps\.promote_candidate\.outputs\.release_control \}\}/
  )
  assert.match(deployGate, /\[ "\$RELEASE_CONTROL_RESTORED" != "true" \]/)
  assert.match(deployGate, /ROLLBACK_CONTROL_RESTORED=false/)
  assert.match(deployGate, /ROLLBACK_CONTROL_RESTORED=true/)
  assert.match(
    deployGate,
    /- name: Finalize single production writer\n        if: always\(\) && steps\.promote_candidate\.outputs\.promoted == 'true'/
  )
})

test('verifies an exact release-safe public SHA after deploy-gate rollback', () => {
  const workflow = deployGate
  assert.match(workflow, /echo "serving=\$SERVING" >> "\$GITHUB_OUTPUT"/)
  assert.match(workflow, /PREVIOUS_DEPLOYMENT_ID: \$\{\{ steps\.fresh\.outputs\.previous_id \}\}/)
  assert.match(workflow, /EXPECTED_ROLLBACK_SHA: \$\{\{ steps\.fresh\.outputs\.serving \}\}/)
  assert.match(workflow, /--connect-timeout 5 --max-time 30/)
  assert.match(workflow, /gate_rollback_verify=/)
  assert.match(workflow, /install -m 700 scripts\/ci\/validate-release-health\.mjs/)
  assert.match(workflow, /node "\$RUNNER_TEMP\/validate-release-health\.mjs"/)
  assert.match(workflow, /"\$HEALTH_HTTP" = "200" \|\| "\$HEALTH_HTTP" = "202"/)
  assert.match(workflow, /\[ "\$HEALTH_SAFE" = "true" \]/)
  assert.match(workflow, /\[ "\$SERVING_SHA" = "\$EXPECTED_ROLLBACK_SHA" \]/)
  assert.match(workflow, /\[ "\$SERVING_SHA" != "\$HEAD_SHA" \]/)
  assert.match(workflow, /STABLE_CONFIRMATIONS.*2/)
  assert.match(workflow, /RECOVERY_SHA.*EXPECTED_ROLLBACK_SHA/)
  assert.doesNotMatch(workflow, /2\?\?\) ROLLED="已自动回滚/)
  assert.doesNotMatch(workflow, /promote\/\$PREV_ID/)
})

test('does not duplicate the detailed smoke rollback alert', () => {
  assert.match(deployGate, /id: smoke_release/)
  assert.match(deployGate, /echo "alerted=true" >> "\$GITHUB_OUTPUT"/)
  assert.match(
    deployGate,
    /if: failure\(\) && steps\.gate\.outputs\.pass == 'true' && steps\.smoke_release\.outputs\.alerted != 'true'/
  )
})

test('skips duplicate preview types without weakening production validation', () => {
  assert.match(nextConfig, /process\.env\.ARENA_CI_TYPES_ATTESTED === '1'/)
  assert.match(
    nextConfig,
    /process\.env\.VERCEL_ENV === 'preview'[\s\S]*process\.env\.ARENA_VERCEL_PREVIEW_SKIP_TYPES === '1'/
  )
  assert.equal(deployGate.match(/--build-env ARENA_CI_TYPES_ATTESTED=1/g)?.length, 1)
  assert.doesNotMatch(deployGate, /--env ARENA_CI_TYPES_ATTESTED=/)
  assert.doesNotMatch(deployGate, /ARENA_VERCEL_PREVIEW_SKIP_TYPES/)
  assert.match(deployGate, /"Lint & Type Check"/)
  assert.match(
    ciWorkflow,
    /- name: Type-check application[\s\S]*?NODE_OPTIONS: --max-old-space-size=4096[\s\S]*?run: npx tsc --noEmit/
  )

  const preview = runVercelBuildCommand({ vercelEnv: 'preview' })
  assert.equal(preview.status, 0)
  assert.match(preview.stdout, /vercel=preview ci= preview_skip=1 args=run build/)

  const emergencyProduction = runVercelBuildCommand({ vercelEnv: 'production' })
  assert.equal(emergencyProduction.status, 0)
  assert.match(emergencyProduction.stdout, /vercel=production ci= preview_skip= args=run build/)

  const deployGateProduction = runVercelBuildCommand({
    vercelEnv: 'production',
    ciTypesAttested: '1',
  })
  assert.equal(deployGateProduction.status, 0)
  assert.match(deployGateProduction.stdout, /vercel=production ci=1 preview_skip= args=run build/)

  const local = runVercelBuildCommand({ vercelEnv: '' })
  assert.equal(local.status, 0)
  assert.match(local.stdout, /vercel= ci= preview_skip= args=run build/)
})

test('allocates enough V8 heap for the production application build', () => {
  assert.match(
    ciWorkflow,
    /build:\n[\s\S]*?- name: Build application\n\s+env:\n\s+# The production webpack graph[\s\S]*?NODE_OPTIONS: --max-old-space-size=4096[\s\S]*?run: npm run build/
  )
})

test('makes every deploy-gate Telegram failure observable without blocking the gate', () => {
  const workflow = deployGate
  assert.match(
    workflow,
    /- name: Alert on red gate \(deploy withheld\)\n        if: always\(\) && steps\.gate\.outputs\.pass != 'true'/
  )
  assert.equal(workflow.match(/send_telegram_alert\(\) \{/g)?.length, 3)
  assert.equal(workflow.match(/--connect-timeout 5 --max-time 10/g)?.length, 3)
  assert.equal(workflow.match(/--output \/dev\/null --write-out '%\{http_code\}'/g)?.length, 3)
  assert.equal(workflow.match(/\[\[ "\$\{http:-000\}" != 2\* \]\]/g)?.length, 3)
  assert.equal(workflow.match(/::warning title=Telegram alert delivery failed::/g)?.length, 6)
  assert.equal(
    workflow.match(/TELEGRAM_BOT_TOKEN: \$\{\{ secrets\.TELEGRAM_BOT_TOKEN \}\}/g)?.length,
    3
  )
  assert.equal(
    workflow.match(/TELEGRAM_ALERT_CHAT_ID: \$\{\{ secrets\.TELEGRAM_ALERT_CHAT_ID \}\}/g)?.length,
    3
  )
  assert.doesNotMatch(workflow, /api\.telegram\.org[^\n]+\|\| true/)
  assert.doesNotMatch(workflow, /if \[ -n "\$\{\{ secrets\.TELEGRAM_BOT_TOKEN \}\}"/)
})

test('treats Telegram HTTP failures as non-blocking but visible', () => {
  const functions = telegramFunctions()
  assert.equal(functions.length, 3)
  assert.equal(new Set(functions).size, 1)

  const unauthorized = runTelegramFunction({ http: '401' })
  assert.equal(unauthorized.status, 0)
  assert.match(
    unauthorized.stdout,
    /::warning title=Telegram alert delivery failed::curl=0 HTTP=401/
  )
  assert.match(unauthorized.summary, /Telegram alert delivery failed .* HTTP=401/)
  assert.doesNotMatch(
    `${unauthorized.stdout}${unauthorized.stderr}${unauthorized.summary}`,
    /bot-secret|42/
  )

  const timedOut = runTelegramFunction({ http: '000', curlExit: '28' })
  assert.equal(timedOut.status, 0)
  assert.match(timedOut.stdout, /curl=28 HTTP=000/)
})

test('keeps successful Telegram delivery quiet and missing credentials visible', () => {
  const delivered = runTelegramFunction({ http: '200' })
  assert.equal(delivered.status, 0)
  assert.match(delivered.stdout, /Telegram alert delivered HTTP 200/)
  assert.doesNotMatch(delivered.stdout, /::warning/)
  assert.equal(delivered.summary, '')

  const missing = runTelegramFunction({ token: '', chat: '' })
  assert.equal(missing.status, 0)
  assert.match(missing.stdout, /required secret is missing/)
  assert.match(missing.summary, /required secret is missing/)
})
