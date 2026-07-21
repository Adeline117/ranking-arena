#!/usr/bin/env node

/**
 * Decide whether /api/health proves that a release is safe to keep serving.
 *
 * Source-data staleness is an operational incident, but rolling application
 * code back cannot make upstream snapshots newer. A degraded response is
 * therefore release-safe only when every core runtime check still passes and
 * freshness supplies a complete, internally consistent source-count summary.
 * Authority failures, Redis failures, malformed payloads and unhealthy
 * responses remain fail-closed.
 */

const FRESHNESS_MESSAGE = /^(\d+)\/(\d+) sources fresh; (\d+) stale; (\d+) critical; (\d+) unknown$/

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function checkStatus(checks, name) {
  const check = checks[name]
  return isRecord(check) && typeof check.status === 'string' ? check.status : null
}

export function validateReleaseHealth(payload) {
  if (!isRecord(payload)) {
    return { safe: false, status: 'invalid', reason: 'health payload is not an object' }
  }

  const status = typeof payload.status === 'string' ? payload.status : 'invalid'
  if (!isRecord(payload.checks)) {
    return { safe: false, status, reason: 'health checks are missing or malformed' }
  }

  const checks = payload.checks
  const api = checkStatus(checks, 'api')
  const database = checkStatus(checks, 'database')
  const redis = checkStatus(checks, 'redis')
  const freshness = checkStatus(checks, 'freshness')

  if (api !== 'pass' || database !== 'pass') {
    return { safe: false, status, reason: 'core API or database check did not pass' }
  }
  if (redis !== 'pass' && redis !== 'skip') {
    return { safe: false, status, reason: 'Redis check did not pass or explicitly skip' }
  }

  if (status === 'healthy') {
    if (freshness !== 'pass') {
      return { safe: false, status, reason: 'healthy response has a non-passing freshness check' }
    }
    return { safe: true, status, reason: 'all core release checks pass' }
  }

  if (status !== 'degraded' || freshness !== 'fail') {
    return { safe: false, status, reason: 'release is neither healthy nor freshness-degraded' }
  }

  const freshnessCheck = checks.freshness
  const message = typeof freshnessCheck.message === 'string' ? freshnessCheck.message : ''
  const match = FRESHNESS_MESSAGE.exec(message)
  if (!match) {
    return {
      safe: false,
      status,
      reason: 'freshness degradation lacks a complete source-count summary',
    }
  }

  const [fresh, total, stale, critical, unknown] = match.slice(1).map(Number)
  if (total <= 0 || fresh + stale + critical + unknown !== total) {
    return { safe: false, status, reason: 'freshness source counts are inconsistent' }
  }
  if (stale + critical + unknown === 0) {
    return { safe: false, status, reason: 'degraded freshness reports no non-fresh sources' }
  }

  return {
    safe: true,
    status,
    reason: `core release checks pass; ${message}`,
  }
}

async function main() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk

  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    console.error('health payload is not valid JSON')
    process.exitCode = 1
    return
  }

  const result = validateReleaseHealth(payload)
  if (!result.safe) {
    console.error(`${result.status}: ${result.reason}`)
    process.exitCode = 1
    return
  }
  console.log(`${result.status}: ${result.reason}`)
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main()
}
