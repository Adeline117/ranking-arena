import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')
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

function ignoredByVercelRules(relativePath) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-vercel-upload-'))
  try {
    spawnSync('git', ['init', '--quiet'], { cwd: directory, check: true })
    fs.writeFileSync(path.join(directory, '.gitignore'), ignoreRules)
    const target = path.join(directory, relativePath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, '')
    const result = spawnSync('git', ['check-ignore', '--quiet', '--no-index', relativePath], {
      cwd: directory,
    })
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(`git check-ignore failed with status ${result.status}`)
    }
    return result.status === 0
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
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

test('uploads the build lifecycle checker required by package.json', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.match(packageJson.scripts.postbuild, /qa:build-bigint/)
  assert.equal(packageJson.scripts['qa:build-bigint'], 'node check-bigint-build-output.mjs')
  assert.equal(ignoredByVercelRules('check-bigint-build-output.mjs'), false)
  assert.equal(ignoredByVercelRules('scripts/qa/check-bigint-build-output.mjs'), true)
})

test('keeps unrelated operational scripts out of the Vercel upload', () => {
  assert.equal(ignoredByVercelRules('scripts/openclaw/daily-pipeline-report.mjs'), true)
  assert.equal(ignoredByVercelRules('scripts/post-deploy-check.sh'), true)
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
  assert.match(releaseControl, /uses: actions\/checkout@v4/)
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

test('verifies an exact healthy public SHA after deploy-gate rollback', () => {
  const workflow = deployGate
  assert.match(workflow, /echo "serving=\$SERVING" >> "\$GITHUB_OUTPUT"/)
  assert.match(workflow, /PREVIOUS_DEPLOYMENT_ID: \$\{\{ steps\.fresh\.outputs\.previous_id \}\}/)
  assert.match(workflow, /EXPECTED_ROLLBACK_SHA: \$\{\{ steps\.fresh\.outputs\.serving \}\}/)
  assert.match(workflow, /--connect-timeout 5 --max-time 30/)
  assert.match(workflow, /gate_rollback_verify=/)
  assert.match(workflow, /\[ "\$HEALTH_HTTP" = "200" \]/)
  assert.match(workflow, /\[ "\$HEALTH_STATUS" = "healthy" \]/)
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

test('skips duplicate Next type validation only for a CI-attested candidate', () => {
  assert.match(nextConfig, /ignoreBuildErrors: process\.env\.ARENA_CI_TYPES_ATTESTED === '1'/)
  assert.equal(deployGate.match(/--build-env ARENA_CI_TYPES_ATTESTED=1/g)?.length, 1)
  assert.doesNotMatch(deployGate, /--env ARENA_CI_TYPES_ATTESTED=/)
  assert.match(deployGate, /"Lint & Type Check"/)
  assert.match(ciWorkflow, /- run: npx tsc --noEmit/)
})

test('makes every deploy-gate Telegram failure observable without blocking the gate', () => {
  const workflow = deployGate
  assert.match(
    workflow,
    /- name: Alert on red gate \(deploy withheld\)\n        if: always\(\) && steps\.gate\.outputs\.pass != 'true'/
  )
  assert.equal(workflow.match(/send_telegram_alert\(\) \{/g)?.length, 3)
  assert.equal(workflow.match(/--connect-timeout 5 --max-time 10/g)?.length, 3)
  assert.equal(workflow.match(/--write-out '%\{http_code\}'/g)?.length, 3)
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
