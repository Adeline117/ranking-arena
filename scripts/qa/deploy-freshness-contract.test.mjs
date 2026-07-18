import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')
const workflow = fs.readFileSync(path.join(root, '.github/workflows/deploy-freshness.yml'), 'utf8')

function checkScript() {
  const marker = '      - name: Check production deploy freshness'
  const stepStart = workflow.indexOf(marker)
  assert.notEqual(stepStart, -1)
  const runMarker = '\n        run: |\n'
  const runStart = workflow.indexOf(runMarker, stepStart)
  assert.notEqual(runStart, -1)
  const contentStart = runStart + runMarker.length
  const nextStep = workflow.indexOf('\n      - name:', contentStart)
  const end = nextStep === -1 ? workflow.length : nextStep
  return workflow
    .slice(contentStart, end)
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n')
}

function run(directory, command, env = {}) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function commitAt(directory, subject, epochSeconds) {
  fs.writeFileSync(path.join(directory, 'state.txt'), `${subject}\n`)
  run(directory, ['git', 'add', 'state.txt'])
  run(directory, ['git', 'commit', '--quiet', '-m', subject], {
    GIT_AUTHOR_DATE: new Date(epochSeconds * 1000).toISOString(),
    GIT_COMMITTER_DATE: new Date(epochSeconds * 1000).toISOString(),
  })
  return run(directory, ['git', 'rev-parse', 'HEAD'])
}

function installFakes(directory) {
  const bin = path.join(directory, 'fake-bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(
    path.join(bin, 'curl'),
    [
      '#!/usr/bin/env bash',
      'output=""',
      'url=""',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    --output) output="$2"; shift 2 ;;',
      '    --write-out|--connect-timeout|--max-time|--request|--header|--data-urlencode) shift 2 ;;',
      '    http*) url="$1"; shift ;;',
      '    *) shift ;;',
      '  esac',
      'done',
      'if [[ "$url" == *api.telegram.org* ]]; then',
      '  printf "telegram\\n" >> "$FAKE_CURL_LOG"',
      '  printf "%s" "${FAKE_TELEGRAM_HTTP:-200}"',
      '  exit "${FAKE_TELEGRAM_EXIT:-0}"',
      'fi',
      'printf "health\\n" >> "$FAKE_CURL_LOG"',
      'if [ -n "$output" ]; then printf "%s" "${FAKE_HEALTH_BODY:-}" > "$output"; fi',
      'printf "%s" "${FAKE_HEALTH_HTTP:-200}"',
      'exit "${FAKE_HEALTH_EXIT:-0}"',
      '',
    ].join('\n')
  )
  fs.writeFileSync(
    path.join(bin, 'gh'),
    [
      '#!/usr/bin/env bash',
      'printf "%s\\n" "$*" >> "$FAKE_GH_LOG"',
      'if [ "$1" = "issue" ] && [ "$2" = "list" ]; then',
      '  printf "%s" "${FAKE_GH_ISSUES:-[]}"',
      'fi',
      'exit "${FAKE_GH_EXIT:-0}"',
      '',
    ].join('\n')
  )
  fs.chmodSync(path.join(bin, 'curl'), 0o755)
  fs.chmodSync(path.join(bin, 'gh'), 0o755)
  return bin
}

function runScenario({
  oldestAgeMinutes = 120,
  newestAgeMinutes = 5,
  healthHttp = '200',
  healthExit = '0',
  healthStatus = 'healthy',
  telegramHttp = '401',
}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-deploy-freshness-'))
  try {
    run(directory, ['git', 'init', '--quiet', '--initial-branch=main'])
    run(directory, ['git', 'config', 'user.email', 'qa@example.test'])
    run(directory, ['git', 'config', 'user.name', 'Arena QA'])
    const now = Math.floor(Date.now() / 1000)
    const deployed = commitAt(directory, 'deployed', now - 180 * 60)
    const oldest = commitAt(directory, 'oldest undeployed', now - oldestAgeMinutes * 60)
    const head = commitAt(directory, 'newest undeployed', now - newestAgeMinutes * 60)
    run(directory, ['git', 'remote', 'add', 'origin', directory])
    const bin = installFakes(directory)
    const summary = path.join(directory, 'summary.md')
    const curlLog = path.join(directory, 'curl.log')
    const ghLog = path.join(directory, 'gh.log')
    fs.writeFileSync(summary, '')
    fs.writeFileSync(curlLog, '')
    fs.writeFileSync(ghLog, '')
    const healthBody = JSON.stringify({ status: healthStatus, commit: deployed })
    const result = spawnSync('bash', ['-c', checkScript()], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_STEP_SUMMARY: summary,
        HEALTH_URL: 'https://health.example.test/api/health',
        ISSUE_TITLE: 'Production deploy is stale',
        STALE_MINUTES: '45',
        TELEGRAM_BOT_TOKEN: 'bot-secret',
        TELEGRAM_ALERT_CHAT_ID: 'chat-secret',
        FAKE_HEALTH_BODY: healthBody,
        FAKE_HEALTH_HTTP: healthHttp,
        FAKE_HEALTH_EXIT: healthExit,
        FAKE_TELEGRAM_HTTP: telegramHttp,
        FAKE_TELEGRAM_EXIT: '0',
        FAKE_CURL_LOG: curlLog,
        FAKE_GH_LOG: ghLog,
        FAKE_GH_ISSUES: '[]',
      },
    })
    return {
      ...result,
      deployed,
      oldest,
      head,
      summary: fs.readFileSync(summary, 'utf8'),
      curlLog: fs.readFileSync(curlLog, 'utf8'),
      ghLog: fs.readFileSync(ghLog, 'utf8'),
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('ages the oldest undeployed commit instead of the newest push', () => {
  const result = runScenario({ oldestAgeMinutes: 120, newestAgeMinutes: 5 })
  assert.equal(result.status, 1)
  assert.match(result.stdout, new RegExp(`oldest undeployed ${result.oldest.slice(0, 8)}`))
  assert.match(result.stdout, /age=1(?:19|20)min/)
  assert.match(result.stdout, /最早未部署 commit/)
  assert.match(result.ghLog, /issue create/)
  assert.match(result.curlLog, /health\ntelegram\n/)
  assert.match(result.summary, /Telegram alert failed.*HTTP=401/)
})

test('keeps a genuinely recent undeployed range inside the normal window', () => {
  const result = runScenario({ oldestAgeMinutes: 10, newestAgeMinutes: 2 })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /within normal deploy window/)
  assert.doesNotMatch(result.ghLog, /issue create/)
  assert.equal(result.curlLog, 'health\n')
})

test('fails loudly and opens the independent issue when health is unreadable', () => {
  const result = runScenario({ healthHttp: '000', healthExit: '28' })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /哨兵失明/)
  assert.match(result.ghLog, /issue create/)
  assert.match(result.summary, /Telegram alert failed/)
})

test('requires a healthy full deployed SHA before doing ancestry math', () => {
  const result = runScenario({ healthStatus: 'degraded' })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /未提供 healthy/)
  assert.match(result.ghLog, /issue create/)
})

test('keeps alert transport bounded and the GitHub issue independent', () => {
  const script = checkScript()
  assert.match(script, /--connect-timeout 5 --max-time 25/)
  assert.match(script, /--connect-timeout 5 --max-time 10/)
  assert.match(script, /--write-out '%\{http_code\}'/)
  assert.match(script, /upsert_issue "\$message"/)
  assert.doesNotMatch(script, /HEAD_TIME=/)
  assert.doesNotMatch(script, /api\.telegram\.org[^\n]*\|\| true/)
  assert.doesNotMatch(script, /\$\{\{/)
})
