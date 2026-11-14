import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { parse } from 'yaml'

const root = path.resolve(import.meta.dirname, '../..')
const ignoreRules = fs.readFileSync(path.join(root, '.vercelignore'), 'utf8')
const deployGate = fs.readFileSync(path.join(root, '.github/workflows/deploy-gate.yml'), 'utf8')
const releaseControl = fs.readFileSync(
  path.join(root, '.github/workflows/vercel-release-control.yml'),
  'utf8'
)
const parsedReleaseControl = parse(releaseControl)
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

function runTelegramFunction(
  helper,
  { http = '200', curlExit = '0', token = 'bot-secret', chat = '42' }
) {
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
    const result = spawnSync('bash', ['-c', `${helper}\nsend_telegram_alert "test alert"`], {
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
    })
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

test('keeps Deploy Gate as the only writer of production domains', () => {
  assert.deepEqual(Object.keys(parsedReleaseControl.on), ['workflow_call'])
  assert.equal(parsedReleaseControl.on.workflow_call.secrets, undefined)
  assert.equal(parsedReleaseControl.jobs['enforce-single-production-writer'].if, '${{ false }}')
  assert.match(releaseControl, /cancel-in-progress: false/)
  assert.match(releaseControl, /uses: actions\/checkout@[0-9a-f]{40} # v4\.\d+\.\d+/)
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

test('skips duplicate Next type validation only for a CI-attested candidate', () => {
  assert.match(nextConfig, /ignoreBuildErrors: process\.env\.ARENA_CI_TYPES_ATTESTED === '1'/)
  assert.match(
    ciWorkflow,
    /- name: Type-check application[\s\S]*?NODE_OPTIONS: --max-old-space-size=4096[\s\S]*?run: npx tsc --noEmit/
  )
})

test('allocates enough V8 heap for the production application build', () => {
  assert.match(
    ciWorkflow,
    /build:\n[\s\S]*?- name: Build application\n\s+env:\n\s+# The production webpack graph[\s\S]*?NODE_OPTIONS: --max-old-space-size=4096[\s\S]*?run: npm run build/
  )
})

// Every inline copy of the alert helper is executed, however many there are.
const telegramHelpers = telegramFunctions()

test('deploy gate defines a Telegram alert helper', () => {
  assert.ok(telegramHelpers.length > 0)
})

for (const [index, helper] of telegramHelpers.entries()) {
  test(`Telegram helper ${index + 1}: HTTP failures are non-blocking but visible`, () => {
    const unauthorized = runTelegramFunction(helper, { http: '401' })
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

    const timedOut = runTelegramFunction(helper, { http: '000', curlExit: '28' })
    assert.equal(timedOut.status, 0)
    assert.match(timedOut.stdout, /curl=28 HTTP=000/)
  })

  test(`Telegram helper ${index + 1}: success is quiet, missing credentials are visible`, () => {
    const delivered = runTelegramFunction(helper, { http: '200' })
    assert.equal(delivered.status, 0)
    assert.match(delivered.stdout, /Telegram alert delivered HTTP 200/)
    assert.doesNotMatch(delivered.stdout, /::warning/)
    assert.equal(delivered.summary, '')

    const missing = runTelegramFunction(helper, { token: '', chat: '' })
    assert.equal(missing.status, 0)
    assert.match(missing.stdout, /required secret is missing/)
    assert.match(missing.summary, /required secret is missing/)
  })
}
