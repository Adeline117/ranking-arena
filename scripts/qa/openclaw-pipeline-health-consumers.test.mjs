import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { generateDailyReport } from '../openclaw/daily-pipeline-report.mjs'
import {
  checkBasicHealth,
  checkPipelineHealthSnapshot,
  sendTelegram,
} from '../openclaw/health-monitor.mjs'
import {
  checkPipelineHealth,
  parsePipelineHealthResponse,
} from '../openclaw/pipeline-health-monitor.mjs'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const NOW_MS = Date.parse('2026-08-03T12:01:00.000Z')

function healthPayload(overrides = {}) {
  return {
    status: 'healthy',
    timestamp: '2026-08-03T12:00:00.000Z',
    authority: { status: 'available', unavailable: [] },
    summary: {
      totalJobs: 2,
      healthyJobs: 2,
      failedJobs: 0,
      stuckJobs: 0,
      staleJobs: 0,
      avgSuccessRate7d: 99.5,
    },
    platformHealth: [
      {
        platform: 'binance_futures',
        status: 'healthy',
        ageHours: 1,
        lastUpdate: '2026-08-03T11:00:00.000Z',
      },
    ],
    jobs: [],
    stats: [],
    recentFailures: [],
    backgroundFailures: [],
    ...overrides,
  }
}

function fetchResponse(payload, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Service Unavailable',
    json: async () => payload,
  })
}

function captureLogger() {
  const lines = []
  return {
    lines,
    logger: {
      log: (...parts) => lines.push(parts.join(' ')),
      error: (...parts) => lines.push(parts.join(' ')),
    },
  }
}

test('pipeline monitor trusts a critical API verdict when cron jobs are empty', async () => {
  const output = captureLogger()
  const result = await checkPipelineHealth({
    fetchImpl: fetchResponse(
      healthPayload({
        status: 'critical',
        summary: {
          totalJobs: 0,
          healthyJobs: 0,
          failedJobs: 0,
          stuckJobs: 0,
          staleJobs: 0,
          avgSuccessRate7d: 0,
        },
        platformHealth: [{ platform: 'bitget_bots_futures', status: 'critical', ageHours: null }],
      })
    ),
    logger: output.logger,
    nowMs: NOW_MS,
  })

  assert.equal(result.alert, true)
  assert.equal(result.level, 'CRITICAL')
  assert.match(result.message, /bitget_bots_futures/)
  assert.match(result.message, /no data/)
})

test('pipeline monitor keeps cron jobs diagnostic when the API verdict is healthy', async () => {
  const result = await checkPipelineHealth({
    fetchImpl: fetchResponse(
      healthPayload({
        jobs: [
          { job_name: 'old-failed-job', health_status: 'failed', error_message: 'old error' },
          { job_name: 'old-stuck-job', health_status: 'stuck' },
        ],
      })
    ),
    logger: captureLogger().logger,
    nowMs: NOW_MS,
  })

  assert.equal(result.alert, false)
  assert.equal(result.level, 'HEALTHY')
})

test('pipeline monitor fails closed when the API authority is unavailable', async () => {
  const result = await checkPipelineHealth({
    fetchImpl: fetchResponse(
      healthPayload({
        status: 'critical',
        authority: { status: 'unavailable', unavailable: ['platform_freshness'] },
      })
    ),
    logger: captureLogger().logger,
    nowMs: NOW_MS,
  })

  assert.equal(result.alert, true)
  assert.equal(result.level, 'ERROR')
  assert.match(result.message, /platform_freshness/)
})

test('pipeline monitor fails closed on a contradictory healthy source verdict', async () => {
  const result = await checkPipelineHealth({
    fetchImpl: fetchResponse(
      healthPayload({
        status: 'healthy',
        platformHealth: [{ platform: 'phemex', status: 'critical', ageHours: 36 }],
      })
    ),
    logger: captureLogger().logger,
    nowMs: NOW_MS,
  })

  assert.equal(result.alert, true)
  assert.equal(result.level, 'ERROR')
  assert.match(result.message, /contradictory healthy verdict/)
})

test('daily report uses authoritative status and canonical seven-day stat fields', async () => {
  const output = captureLogger()
  const result = await generateDailyReport({
    fetchImpl: fetchResponse(
      healthPayload({
        status: 'critical',
        platformHealth: [{ platform: 'phemex', status: 'critical', ageHours: 36 }],
        stats: [
          { job_name: 'compute-leaderboard', total_runs: 12, error_count: 3, success_rate: 75 },
          { job_name: 'sync-cache', total_runs: '5', error_count: '2', success_rate: 60 },
        ],
      })
    ),
    now: new Date('2026-08-03T12:00:00.000Z'),
    logger: output.logger,
  })

  assert.equal(result.status, 'critical')
  assert.equal(result.data.totalRuns7d, 17)
  assert.equal(result.data.totalFailures7d, 5)
  assert.match(result.report, /Authoritative status: 🔴 critical/)
  assert.match(result.report, /phemex: critical \(36\.0h old\)/)
  assert.match(result.report, /Total Runs \(7d\): 17/)
  assert.match(result.report, /Errors \(7d\): 5/)
  assert.doesNotMatch(result.report, /All systems healthy/)
})

test('daily report keeps failed cron jobs diagnostic under a healthy API verdict', async () => {
  const result = await generateDailyReport({
    fetchImpl: fetchResponse(
      healthPayload({
        jobs: [
          {
            job_name: 'tolerated-cron-failure',
            health_status: 'failed',
            error_message: 'retrying',
          },
        ],
      })
    ),
    logger: captureLogger().logger,
    now: new Date(NOW_MS),
  })

  assert.equal(result.status, 'healthy')
  assert.equal(result.data.failed, 1)
  assert.match(result.report, /diagnostic only/)
  assert.match(result.report, /Authoritative health verdict is healthy/)
})

test('daily report fails closed instead of inventing health without platform authority', async () => {
  const result = await generateDailyReport({
    fetchImpl: fetchResponse(healthPayload({ platformHealth: [] })),
    logger: captureLogger().logger,
    now: new Date(NOW_MS),
  })

  assert.equal(result.status, 'error')
  assert.equal(result.data, null)
  assert.match(result.report, /no active platform health rows/)
})

test('pipeline authority rejects contradictory and stale snapshots', () => {
  assert.throws(
    () =>
      parsePipelineHealthResponse(
        healthPayload({ authority: { status: 'available', unavailable: ['job_stats'] } }),
        { nowMs: NOW_MS }
      ),
    /contradictory authority verdict/
  )
  assert.throws(
    () =>
      parsePipelineHealthResponse(healthPayload({ timestamp: '2026-08-03T11:50:00.000Z' }), {
        nowMs: NOW_MS,
      }),
    /stale snapshot/
  )
})

test('pipeline parser preserves validated failure diagnostics for the aggregate monitor', () => {
  const recentFailures = [
    {
      job_name: 'compute-leaderboard',
      started_at: '2026-08-03T11:59:00.000Z',
      error_message: 'database timeout',
      metadata: {},
    },
  ]
  const backgroundFailures = [
    {
      label: 'ranking-cache-refresh',
      count: 3,
      lastError: 'redis unavailable',
      lastAt: '2026-08-03T11:59:30.000Z',
    },
  ]
  const parsed = parsePipelineHealthResponse(
    healthPayload({ recentFailures, backgroundFailures }),
    { nowMs: NOW_MS }
  )

  assert.deepEqual(parsed.recentFailures, recentFailures)
  assert.deepEqual(parsed.backgroundFailures, backgroundFailures)
  assert.throws(
    () =>
      parsePipelineHealthResponse(
        healthPayload({ backgroundFailures: [{ label: '', count: -1, lastError: 42 }] }),
        { nowMs: NOW_MS }
      ),
    /invalid background failures/
  )
})

test('pipeline and daily monitors bound a response body that never completes', async () => {
  const hangingBody = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => new Promise(() => undefined),
  })

  const pipeline = await checkPipelineHealth({
    fetchImpl: hangingBody,
    logger: captureLogger().logger,
    timeoutMs: 10,
    nowMs: NOW_MS,
  })
  const daily = await generateDailyReport({
    fetchImpl: hangingBody,
    logger: captureLogger().logger,
    timeoutMs: 10,
    now: new Date(NOW_MS),
  })

  assert.equal(pipeline.level, 'ERROR')
  assert.match(pipeline.message, /Request timeout/)
  assert.equal(daily.status, 'error')
  assert.match(daily.report, /timed out/)
})

test('Mac health monitor rejects non-2xx and malformed health payloads', async () => {
  await assert.rejects(
    checkBasicHealth({
      fetchImpl: fetchResponse({ error: 'unauthorized' }, 401),
      nowMs: NOW_MS,
    }),
    /HTTP 401/
  )
  await assert.rejects(
    checkBasicHealth({
      fetchImpl: fetchResponse({ status: 'healthy' }),
      nowMs: NOW_MS,
    }),
    /invalid checks/
  )
  await assert.rejects(
    checkPipelineHealthSnapshot({
      fetchImpl: fetchResponse({ error: 'unauthorized' }, 401),
      nowMs: NOW_MS,
    }),
    /HTTP 401/
  )
})

test('Telegram delivery fails closed on missing credentials, HTTP errors, and rejected payloads', async () => {
  await assert.rejects(sendTelegram('alert', { botToken: '', chatId: '' }), /credentials/)
  await assert.rejects(
    sendTelegram('alert', {
      botToken: 'test-token',
      chatId: 'test-chat',
      fetchImpl: fetchResponse({ ok: false }, 429),
    }),
    /HTTP 429/
  )
  await assert.rejects(
    sendTelegram('alert', {
      botToken: 'test-token',
      chatId: 'test-chat',
      fetchImpl: fetchResponse({ ok: false }),
    }),
    /rejected the alert/
  )
})

test('scheduled pipeline monitor is read-only and receives no database credentials', () => {
  const monitor = readFileSync(
    join(repoRoot, 'scripts/openclaw/pipeline-health-monitor.mjs'),
    'utf8'
  )
  const workflow = readFileSync(join(repoRoot, '.github/workflows/openclaw-sentinels.yml'), 'utf8')
  const stepStart = workflow.indexOf('- name: pipeline-health-monitor')
  const stepEnd = workflow.indexOf('\n      - name:', stepStart + 1)
  const monitorStep = workflow.slice(stepStart, stepEnd)
  const dailyStart = workflow.indexOf('- name: daily-pipeline-report')
  const dailyEnd = workflow.indexOf('\n\n', dailyStart)
  const dailyStep = workflow.slice(dailyStart, dailyEnd)

  assert.ok(stepStart >= 0, 'pipeline-health-monitor workflow step must exist')
  assert.doesNotMatch(monitor, /createClient|cleanupStuckLogs|AUTO_CLEANUP|pipeline_logs/)
  assert.match(monitorStep, /CRON_SECRET/)
  assert.doesNotMatch(
    monitorStep,
    /NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|TELEGRAM_BOT_TOKEN|TELEGRAM_ALERT_CHAT_ID/
  )
  assert.ok(dailyStart >= 0, 'daily-pipeline-report workflow step must exist')
  assert.match(dailyStep, /CRON_SECRET/)
  assert.doesNotMatch(dailyStep, /TELEGRAM_BOT_TOKEN|TELEGRAM_ALERT_CHAT_ID/)
})
