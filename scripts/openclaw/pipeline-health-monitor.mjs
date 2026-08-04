#!/usr/bin/env node
/**
 * Arena Pipeline Health Monitor (OpenClaw)
 *
 * The authenticated health API owns the health verdict. `platformHealth`
 * carries the active source-registry detail; `jobs` is historical cron
 * diagnostics and must never override the authoritative top-level status.
 *
 * Usage:
 *   node scripts/openclaw/pipeline-health-monitor.mjs
 *   node scripts/openclaw/pipeline-health-monitor.mjs --verbose
 */

import path from 'path'
import { fileURLToPath } from 'url'
import { config as dotenvConfig } from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenvConfig({ path: path.resolve(__dirname, '../../.env'), quiet: true })

const CRON_SECRET = process.env.CRON_SECRET
const API_URL = process.env.ARENA_URL
  ? `${process.env.ARENA_URL}/api/health/pipeline`
  : 'https://www.arenafi.org/api/health/pipeline'
const VERBOSE = process.argv.includes('--verbose')
const VALID_STATUSES = new Set(['healthy', 'degraded', 'critical'])
const MAX_SNAPSHOT_AGE_MS = 5 * 60 * 1000
const MAX_FUTURE_SKEW_MS = 60 * 1000

export async function fetchJsonWithDeadline({ fetchImpl, url, init = {}, timeoutMs, label }) {
  if (typeof fetchImpl !== 'function') throw new Error(`${label} fetch is unavailable`)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`${label} timeout is invalid`)
  }

  const controller = new AbortController()
  let timeoutId
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms`)
      error.name = 'AbortError'
      controller.abort(error)
      reject(error)
    }, timeoutMs)
  })

  try {
    return await Promise.race([
      Promise.resolve().then(async () => {
        const response = await fetchImpl(url, { ...init, signal: controller.signal })
        if (!response || typeof response.ok !== 'boolean') {
          throw new Error(`${label} returned an invalid HTTP response`)
        }
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText || 'request failed'}`)
        }
        return response.json()
      }),
      timeout,
    ])
  } finally {
    clearTimeout(timeoutId)
  }
}

export function parsePipelineHealthResponse(
  data,
  { nowMs = Date.now(), maxSnapshotAgeMs = MAX_SNAPSHOT_AGE_MS } = {}
) {
  if (!data || typeof data !== 'object') {
    throw new Error('Pipeline health API returned a non-object payload')
  }
  if (!VALID_STATUSES.has(data.status)) {
    throw new Error(`Pipeline health API returned unsupported status: ${String(data.status)}`)
  }

  if (!Array.isArray(data.authority?.unavailable)) {
    throw new Error('Pipeline health API returned an invalid authority payload')
  }
  const unavailable = data.authority.unavailable.filter((value) => typeof value === 'string')
  if (unavailable.length !== data.authority.unavailable.length) {
    throw new Error('Pipeline health API returned an invalid authority payload')
  }
  if (data.authority?.status !== 'available') {
    const suffix = unavailable.length > 0 ? ` (${unavailable.join(', ')})` : ''
    throw new Error(`Pipeline health authority is unavailable${suffix}`)
  }
  if (unavailable.length > 0) {
    throw new Error('Pipeline health API returned a contradictory authority verdict')
  }

  const timestampMs = typeof data.timestamp === 'string' ? Date.parse(data.timestamp) : Number.NaN
  if (!Number.isFinite(timestampMs)) {
    throw new Error('Pipeline health API returned an invalid timestamp')
  }
  if (timestampMs - nowMs > MAX_FUTURE_SKEW_MS) {
    throw new Error('Pipeline health API returned a future-dated snapshot')
  }
  if (nowMs - timestampMs > maxSnapshotAgeMs) {
    throw new Error('Pipeline health API returned a stale snapshot')
  }
  if (!Array.isArray(data.platformHealth) || data.platformHealth.length === 0) {
    throw new Error('Pipeline health API returned no active platform health rows')
  }
  for (const platform of data.platformHealth) {
    const platformName = platform?.platform || platform?.displayName
    const validAge =
      platform?.ageHours === null ||
      (typeof platform?.ageHours === 'number' &&
        Number.isFinite(platform.ageHours) &&
        platform.ageHours >= 0)
    if (
      !platform ||
      typeof platformName !== 'string' ||
      platformName.trim() === '' ||
      !['healthy', 'warning', 'critical'].includes(platform.status) ||
      !validAge
    ) {
      throw new Error('Pipeline health API returned an invalid platform health row')
    }
  }
  if (
    data.status === 'healthy' &&
    data.platformHealth.some((platform) => platform.status !== 'healthy')
  ) {
    throw new Error('Pipeline health API returned a contradictory healthy verdict')
  }
  if (
    !Array.isArray(data.recentFailures) ||
    data.recentFailures.some(
      (failure) =>
        !failure ||
        typeof failure.job_name !== 'string' ||
        failure.job_name.trim() === '' ||
        (failure.error_message !== null && typeof failure.error_message !== 'string')
    )
  ) {
    throw new Error('Pipeline health API returned invalid recent failures')
  }
  if (
    !Array.isArray(data.backgroundFailures) ||
    data.backgroundFailures.some(
      (failure) =>
        !failure ||
        typeof failure.label !== 'string' ||
        failure.label.trim() === '' ||
        !Number.isInteger(failure.count) ||
        failure.count < 0 ||
        (failure.lastError !== null && typeof failure.lastError !== 'string')
    )
  ) {
    throw new Error('Pipeline health API returned invalid background failures')
  }

  return {
    status: data.status,
    timestamp: data.timestamp,
    summary: data.summary && typeof data.summary === 'object' ? data.summary : {},
    platformHealth: data.platformHealth,
    jobs: Array.isArray(data.jobs) ? data.jobs : [],
    stats: Array.isArray(data.stats) ? data.stats : [],
    recentFailures: data.recentFailures,
    backgroundFailures: data.backgroundFailures,
  }
}

function jobDiagnostics(jobs) {
  return {
    failed: jobs.filter((job) => job?.health_status === 'failed'),
    stuck: jobs.filter((job) => job?.health_status === 'stuck'),
    stale: jobs.filter((job) => job?.health_status === 'stale'),
  }
}

function platformDiagnostics(platformHealth) {
  return {
    critical: platformHealth.filter((platform) => platform?.status === 'critical'),
    warning: platformHealth.filter((platform) => platform?.status === 'warning'),
  }
}

function formatAge(platform) {
  const age = platform?.ageHours
  return typeof age === 'number' && Number.isFinite(age) ? `${age.toFixed(1)}h old` : 'no data'
}

function buildAlertMessage(status, platforms, jobs) {
  const statusText = status.toUpperCase()
  const lines = [`${getStatusEmoji(status)} Arena Pipeline ${statusText}`]

  const sourceIssues = [...platforms.critical, ...platforms.warning]
  if (sourceIssues.length > 0) {
    lines.push('', 'Source freshness:')
    for (const source of sourceIssues.slice(0, 10)) {
      lines.push(
        `  ${source.status === 'critical' ? '🚨' : '⚠️'} ${source.platform || source.displayName || 'unknown'}: ${source.status} (${formatAge(source)})`
      )
    }
  }

  const jobIssueCount = jobs.failed.length + jobs.stuck.length + jobs.stale.length
  if (jobIssueCount > 0) {
    lines.push('', 'Cron diagnostics:')
    for (const job of jobs.stuck.slice(0, 5)) {
      lines.push(`  ⏱️ ${job.job_name || 'unknown'}: stuck`)
    }
    for (const job of jobs.failed.slice(0, 5)) {
      lines.push(
        `  ❌ ${job.job_name || 'unknown'}: ${(job.error_message || 'Unknown error').slice(0, 80)}`
      )
    }
    for (const job of jobs.stale.slice(0, 5)) {
      lines.push(`  🕒 ${job.job_name || 'unknown'}: stale`)
    }
  }

  return lines.join('\n')
}

function logSummary(logger, health, platforms, jobs) {
  const { summary } = health
  logger.log('🏟 Arena Pipeline Health Check')
  logger.log(`\nStatus: ${getStatusEmoji(health.status)} ${health.status}`)
  if (health.timestamp) logger.log(`Timestamp: ${new Date(health.timestamp).toLocaleString()}`)
  logger.log('\nAuthoritative source health:')
  logger.log(`  Critical: ${platforms.critical.length}`)
  logger.log(`  Warning: ${platforms.warning.length}`)
  logger.log(`  Total: ${health.platformHealth.length}`)
  logger.log('\nCron diagnostics:')
  logger.log(`  Healthy: ${summary.healthyJobs ?? 0}/${summary.totalJobs ?? 0}`)
  logger.log(`  Failed: ${jobs.failed.length}`)
  logger.log(`  Stuck: ${jobs.stuck.length}`)
  logger.log(`  Stale: ${jobs.stale.length}`)
  logger.log(`  Success Rate (7d): ${summary.avgSuccessRate7d ?? 0}%`)
}

export async function checkPipelineHealth({
  fetchImpl = globalThis.fetch,
  apiUrl = API_URL,
  cronSecret = CRON_SECRET,
  verbose = VERBOSE,
  logger = console,
  timeoutMs = 15000,
  nowMs = Date.now(),
} = {}) {
  try {
    const payload = await fetchJsonWithDeadline({
      fetchImpl,
      url: apiUrl,
      init: {
        headers: { Authorization: `Bearer ${cronSecret || ''}` },
      },
      timeoutMs,
      label: 'Pipeline health request',
    })
    const health = parsePipelineHealthResponse(payload, { nowMs })
    const platforms = platformDiagnostics(health.platformHealth)
    const jobs = jobDiagnostics(health.jobs)

    if (verbose || health.status !== 'healthy') {
      logSummary(logger, health, platforms, jobs)
    }

    if (health.status === 'critical' || health.status === 'degraded') {
      const level = health.status.toUpperCase()
      const message = buildAlertMessage(health.status, platforms, jobs)
      logger.log(`\n${message}`)
      return {
        alert: true,
        level,
        message,
        data: health.summary,
      }
    }

    if (verbose) logger.log('\n✅ All authoritative health checks passed')
    return {
      alert: false,
      level: 'HEALTHY',
      message: `✅ Pipeline healthy: ${health.platformHealth.length} active sources`,
      data: health.summary,
    }
  } catch (error) {
    const isTimeout = error?.name === 'AbortError'
    const errorMsg = isTimeout
      ? `Request timeout (>${timeoutMs}ms)`
      : error?.message || String(error)
    logger.error('❌ Error checking pipeline health:', errorMsg)
    return {
      alert: true,
      level: 'ERROR',
      message: `❌ Pipeline health check failed: ${errorMsg}`,
      data: null,
    }
  }
}

function getStatusEmoji(status) {
  switch (status) {
    case 'healthy':
      return '✅'
    case 'degraded':
      return '⚠️'
    case 'critical':
      return '🚨'
    default:
      return '❓'
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await checkPipelineHealth()
  if (result.level === 'CRITICAL' || result.level === 'ERROR') {
    process.exit(2)
  } else if (result.level === 'DEGRADED') {
    process.exit(1)
  } else {
    process.exit(0)
  }
}
