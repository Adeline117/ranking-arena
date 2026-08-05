import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')
const workflow = fs.readFileSync(path.join(root, '.github/workflows/backup-db.yml'), 'utf8')
const requiredBackupSecrets = [
  'BACKUP_DATABASE_URL',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
]
const configuredValues = {
  BACKUP_DATABASE_URL: 'database-secret-value-must-not-be-logged',
  R2_ACCOUNT_ID: 'account-id-value-must-not-be-logged',
  R2_ACCESS_KEY_ID: 'access-key-value-must-not-be-logged',
  R2_SECRET_ACCESS_KEY: 'secret-key-value-must-not-be-logged',
  R2_BUCKET: 'bucket-value-must-not-be-logged',
}

function stepBlock(stepName) {
  const stepStart = workflow.indexOf(`      - name: ${stepName}`)
  assert.notEqual(stepStart, -1, `missing workflow step: ${stepName}`)
  const nextStep = workflow.indexOf('\n      - name:', stepStart + 1)
  const nextUnnamedStep = workflow.indexOf('\n      - uses:', stepStart + 1)
  const candidates = [nextStep, nextUnnamedStep].filter((position) => position !== -1)
  const end = candidates.length === 0 ? workflow.length : Math.min(...candidates)
  return workflow.slice(stepStart, end)
}

function runBlock(stepName) {
  const step = stepBlock(stepName)
  const runMarker = '\n        run: |\n'
  const runStart = step.indexOf(runMarker)
  assert.notEqual(runStart, -1, `missing run block: ${stepName}`)
  return step
    .slice(runStart + runMarker.length)
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n')
}

function runPreflight(overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-backup-preflight-'))
  try {
    const output = path.join(directory, 'github-output')
    const summary = path.join(directory, 'summary.md')
    fs.writeFileSync(output, '')
    fs.writeFileSync(summary, '')
    const result = spawnSync('bash', ['-c', runBlock('Validate backup configuration')], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...configuredValues,
        ...overrides,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
      },
    })
    return {
      ...result,
      output: fs.readFileSync(output, 'utf8'),
      summary: fs.readFileSync(summary, 'utf8'),
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

function createFakeCurl(directory) {
  const fakeCurl = path.join(directory, 'curl')
  fs.writeFileSync(
    fakeCurl,
    [
      '#!/usr/bin/env bash',
      'printf "called\\n" >> "${FAKE_CURL_LOG}"',
      'printf "%s" "${FAKE_CURL_HTTP:-000}"',
      'exit "${FAKE_CURL_EXIT:-0}"',
      '',
    ].join('\n')
  )
  fs.chmodSync(fakeCurl, 0o755)
}

function runAlert({
  configured = 'true',
  token = 'telegram-token-value-must-not-be-logged',
  chat = 'telegram-chat-value-must-not-be-logged',
  http = '200',
  curlExit = '0',
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-backup-alert-'))
  try {
    createFakeCurl(directory)
    const summary = path.join(directory, 'summary.md')
    const curlLog = path.join(directory, 'curl.log')
    fs.writeFileSync(summary, '')
    fs.writeFileSync(curlLog, '')
    const result = spawnSync('bash', ['-c', runBlock('Alert on failure')], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        BACKUP_CONFIGURED: configured,
        TELEGRAM_BOT_TOKEN: token,
        TELEGRAM_CHAT_ID: chat,
        GITHUB_STEP_SUMMARY: summary,
        FAKE_CURL_HTTP: http,
        FAKE_CURL_EXIT: curlExit,
        FAKE_CURL_LOG: curlLog,
      },
    })
    return {
      ...result,
      summary: fs.readFileSync(summary, 'utf8'),
      curlCalls: fs.readFileSync(curlLog, 'utf8'),
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('validates every backup secret before checkout or dependency installation', () => {
  const preflightPosition = workflow.indexOf('- name: Validate backup configuration')
  const checkoutPosition = workflow.indexOf('- uses: actions/checkout@')
  const setupNodePosition = workflow.indexOf('- uses: actions/setup-node@')
  assert.ok(preflightPosition >= 0)
  assert.ok(checkoutPosition >= 0)
  assert.ok(setupNodePosition >= 0)
  assert.ok(preflightPosition < checkoutPosition)
  assert.ok(preflightPosition < setupNodePosition)
  assert.ok(preflightPosition < workflow.indexOf('- run: npm ci --ignore-scripts'))

  const configured = runPreflight()
  assert.equal(configured.status, 0)
  assert.equal(configured.output, 'configured=true\n')
  assert.equal(configured.summary, '')

  for (const name of requiredBackupSecrets) {
    const missing = runPreflight({ [name]: '' })
    const diagnostic = `${missing.stdout}${missing.stderr}${missing.summary}`
    assert.equal(missing.status, 1, `${name} must be required`)
    assert.equal(missing.output, 'configured=false\n')
    assert.match(diagnostic, new RegExp(`\\b${name}\\b`))
    for (const value of Object.values(configuredValues)) {
      assert.equal(diagnostic.includes(value), false, `${name} diagnostic leaked a secret value`)
    }
  }

  assert.doesNotMatch(runBlock('Validate backup configuration'), /\$\{\{/)
})

test('requires both Telegram coordinates and accepts only a 2xx delivery', () => {
  for (const scenario of [{ token: '' }, { chat: '' }]) {
    const missing = runAlert(scenario)
    assert.equal(missing.status, 1)
    assert.equal(missing.curlCalls, '')
    assert.match(missing.summary, /missing required secret names/)
  }

  const delivered = runAlert({ http: '204', configured: 'false' })
  assert.equal(delivered.status, 0)
  assert.equal(delivered.curlCalls, 'called\n')
  assert.equal(delivered.summary, '')

  for (const scenario of [{ http: '401' }, { http: '503' }, { http: '000', curlExit: '28' }]) {
    const failed = runAlert(scenario)
    const diagnostic = `${failed.stdout}${failed.stderr}${failed.summary}`
    assert.equal(failed.status, 1)
    assert.equal(failed.curlCalls, 'called\n')
    assert.match(failed.summary, /DB backup alert delivery failed/)
    assert.doesNotMatch(
      diagnostic,
      /telegram-token-value-must-not-be-logged|telegram-chat-value-must-not-be-logged/
    )
  }

  const alert = stepBlock('Alert on failure')
  assert.match(alert, /TELEGRAM_BOT_TOKEN: \$\{\{ secrets\.TELEGRAM_BOT_TOKEN \}\}/)
  assert.match(alert, /TELEGRAM_CHAT_ID: \$\{\{ secrets\.TELEGRAM_ALERT_CHAT_ID \}\}/)
  assert.doesNotMatch(runBlock('Alert on failure'), /\$\{\{/)
  assert.match(runBlock('Alert on failure'), /\[\[ "\$\{HTTP:-000\}" != 2\* \]\]/)
})
