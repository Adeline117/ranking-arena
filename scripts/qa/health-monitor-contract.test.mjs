import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')
const workflow = fs.readFileSync(path.join(root, '.github/workflows/health-monitor.yml'), 'utf8')

function runBlock(stepName) {
  const stepStart = workflow.indexOf(`      - name: ${stepName}`)
  assert.notEqual(stepStart, -1, `missing workflow step: ${stepName}`)
  const runMarker = '\n        run: |\n'
  const runStart = workflow.indexOf(runMarker, stepStart)
  assert.notEqual(runStart, -1, `missing run block: ${stepName}`)
  const contentStart = runStart + runMarker.length
  const nextStep = workflow.indexOf('\n      - name:', contentStart)
  const end = nextStep === -1 ? workflow.length : nextStep
  return workflow
    .slice(contentStart, end)
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n')
}

function createFakeCurl(directory) {
  const fakeCurl = path.join(directory, 'curl')
  fs.writeFileSync(
    fakeCurl,
    [
      '#!/usr/bin/env bash',
      'output=""',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    --output) output="$2"; shift 2 ;;',
      '    --write-out) shift 2 ;;',
      '    *) shift ;;',
      '  esac',
      'done',
      'printf "called\\n" >> "${FAKE_CURL_LOG}"',
      'if [ -n "$output" ]; then printf "%s" "${FAKE_CURL_BODY:-}" > "$output"; fi',
      'printf "%s" "${FAKE_CURL_HTTP:-000}"',
      'exit "${FAKE_CURL_EXIT:-0}"',
      '',
    ].join('\n')
  )
  fs.chmodSync(fakeCurl, 0o755)
}

function runHealthCheck({ body, http = '200', curlExit = '0' }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-health-check-'))
  try {
    createFakeCurl(directory)
    const output = path.join(directory, 'github-output')
    const message = path.join(directory, 'health-message.txt')
    const curlLog = path.join(directory, 'curl.log')
    fs.writeFileSync(output, '')
    fs.writeFileSync(curlLog, '')
    const result = spawnSync('bash', ['-c', runBlock('Check pipeline health')], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        CRON_SECRET: 'cron-secret',
        HEALTH_URL: 'https://health.example.test/pipeline',
        HEALTH_MESSAGE_FILE: message,
        GITHUB_OUTPUT: output,
        FAKE_CURL_BODY: body,
        FAKE_CURL_HTTP: http,
        FAKE_CURL_EXIT: curlExit,
        FAKE_CURL_LOG: curlLog,
      },
    })
    return {
      ...result,
      output: fs.readFileSync(output, 'utf8'),
      message: fs.existsSync(message) ? fs.readFileSync(message, 'utf8') : '',
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

function runTelegram({
  http = '200',
  curlExit = '0',
  token = 'bot-secret',
  chat = 'critical-chat',
  marker,
}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-health-telegram-'))
  try {
    createFakeCurl(directory)
    const output = path.join(directory, 'github-output')
    const summary = path.join(directory, 'summary.md')
    const message = path.join(directory, 'health-message.txt')
    const curlLog = path.join(directory, 'curl.log')
    fs.writeFileSync(output, '')
    fs.writeFileSync(summary, '')
    fs.writeFileSync(message, 'critical: test summary')
    fs.writeFileSync(curlLog, '')
    if (marker !== undefined) {
      fs.writeFileSync(path.join(directory, '.hm-alert-marker'), String(marker))
    }
    const result = spawnSync(
      'bash',
      ['-c', runBlock('Send Telegram alert on failure (2h dedup)')],
      {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          HEALTH_STATUS: 'critical',
          HEALTH_MESSAGE_FILE: message,
          TELEGRAM_BOT_TOKEN: token,
          TELEGRAM_CHAT_ID: chat,
          FAKE_CURL_BODY: '{}',
          FAKE_CURL_HTTP: http,
          FAKE_CURL_EXIT: curlExit,
          FAKE_CURL_LOG: curlLog,
        },
      }
    )
    const markerPath = path.join(directory, '.hm-alert-marker')
    return {
      ...result,
      output: fs.readFileSync(output, 'utf8'),
      summary: fs.readFileSync(summary, 'utf8'),
      curlCalls: fs.readFileSync(curlLog, 'utf8'),
      marker: fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8') : null,
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('allowlists health status and keeps dynamic detail out of GitHub outputs', () => {
  const healthy = runHealthCheck({ body: JSON.stringify({ status: 'healthy' }) })
  assert.equal(healthy.status, 0)
  assert.equal(healthy.output, 'status=healthy\n')
  assert.equal(healthy.message, 'All systems healthy\n')

  const critical = runHealthCheck({
    body: JSON.stringify({ status: 'critical', summary: { failedJobs: 4 } }),
  })
  assert.equal(critical.status, 0)
  assert.equal(critical.output, 'status=critical\n')
  assert.match(critical.message, /failedJobs/)
  assert.doesNotMatch(critical.output, /failedJobs/)

  const injected = runHealthCheck({
    body: JSON.stringify({ status: 'healthy\ninjected=true', summary: { secret: 'value' } }),
  })
  assert.equal(injected.status, 0)
  assert.equal(injected.output, 'status=down\n')
  assert.doesNotMatch(injected.output, /injected|secret/)
})

test('turns transport, HTTP, and JSON failures into an explicit down result', () => {
  for (const scenario of [
    { body: '', http: '000', curlExit: '28' },
    { body: '{"error":"unauthorized"}', http: '401', curlExit: '0' },
    { body: 'not json', http: '200', curlExit: '0' },
  ]) {
    const result = runHealthCheck(scenario)
    assert.equal(result.status, 0)
    assert.equal(result.output, 'status=down\n')
    assert.notEqual(result.message, '')
  }
})

test('writes a dedup marker only after Telegram returns 2xx', () => {
  const delivered = runTelegram({ http: '200' })
  assert.equal(delivered.status, 0)
  assert.equal(delivered.output, 'delivered=true\n')
  assert.match(delivered.marker?.trim() ?? '', /^\d+$/)
  assert.equal(delivered.summary, '')

  for (const scenario of [
    { http: '401', curlExit: '0' },
    { http: '000', curlExit: '28' },
    { http: '200', curlExit: '0', token: '' },
  ]) {
    const failed = runTelegram(scenario)
    assert.equal(failed.status, 0)
    assert.equal(failed.output, 'delivered=false\n')
    assert.equal(failed.marker, null)
    assert.match(failed.summary, /Health alert delivery failed/)
    assert.doesNotMatch(
      `${failed.stdout}${failed.stderr}${failed.summary}`,
      /bot-secret|critical-chat/
    )
  }
})

test('dedups only a valid recent marker and retries invalid or future markers', () => {
  const now = Math.floor(Date.now() / 1000)
  const recent = runTelegram({ marker: now - 60 })
  assert.equal(recent.status, 0)
  assert.equal(recent.output, 'delivered=false\n')
  assert.equal(recent.curlCalls, '')

  for (const marker of ['not-a-number', now + 3600]) {
    const retried = runTelegram({ marker })
    assert.equal(retried.status, 0)
    assert.equal(retried.output, 'delivered=true\n')
    assert.equal(retried.curlCalls, 'called\n')
  }
})

test('restores and saves cache explicitly before failing unhealthy runs', () => {
  assert.match(workflow, /uses: actions\/cache\/restore@v4/)
  assert.match(workflow, /uses: actions\/cache\/save@v4/)
  assert.match(workflow, /if: steps\.telegram\.outputs\.delivered == 'true'/)
  assert.match(
    workflow,
    /- name: Fail unhealthy health-monitor run\n        if: always\(\) && steps\.health\.outputs\.status != 'healthy'/
  )
  assert.match(runBlock('Fail unhealthy health-monitor run'), /exit 1/)
  assert.doesNotMatch(workflow, /uses: actions\/cache@v4/)
})

test('keeps secrets and dynamic health data out of shell expression interpolation', () => {
  for (const name of [
    'Check pipeline health',
    'Send Telegram alert on failure (2h dedup)',
    'Fail unhealthy health-monitor run',
  ]) {
    assert.doesNotMatch(runBlock(name), /\$\{\{/)
  }
  const telegram = runBlock('Send Telegram alert on failure (2h dedup)')
  assert.match(telegram, /--connect-timeout 5 --max-time 10/)
  assert.match(telegram, /--write-out '%\{http_code\}'/)
  assert.doesNotMatch(telegram, /api\.telegram\.org[^\n]*\|\| true/)
  assert.ok(telegram.indexOf('if send_telegram_alert') < telegram.indexOf('> .hm-alert-marker'))
})
