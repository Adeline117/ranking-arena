#!/usr/bin/env node

/**
 * Fail closed before a Vercel candidate is built when the production database
 * has not completed the metric-trust dependency chain. The service-role RPC is
 * installed by the final forward migration and returns only release-readiness
 * facts; credentials and database connection strings are never printed.
 */

export const METRIC_TRUST_READINESS_CONTRACT = 'arena.metric-trust-release-readiness@1'
export const PRODUCTION_SUPABASE_ORIGIN = 'https://iknktzifjdyujdccyhsv.supabase.co'

const TRANSIENT_STATUS = new Set([429, 502, 503, 504])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function validateMetricTrustReadiness(payload) {
  if (!isRecord(payload)) return { ready: false, reason: 'readiness payload is not an object' }
  if (payload.contract !== METRIC_TRUST_READINESS_CONTRACT) {
    return { ready: false, reason: 'readiness contract is missing or unsupported' }
  }
  if (!Array.isArray(payload.missing) || payload.missing.some((item) => typeof item !== 'string')) {
    return { ready: false, reason: 'readiness missing-object list is malformed' }
  }
  if (!Number.isSafeInteger(payload.legacy_complete_verified_count)) {
    return { ready: false, reason: 'legacy observation count is malformed' }
  }
  if (payload.source_page_lineage_column !== true) {
    return { ready: false, reason: 'source-page lineage is not durably available' }
  }
  if (payload.ready !== true || payload.missing.length !== 0) {
    return { ready: false, reason: 'required metric-trust database objects are missing' }
  }
  if (payload.legacy_complete_verified_count !== 0) {
    return { ready: false, reason: 'legacy complete observations require quarantine' }
  }
  return { ready: true, reason: 'metric-trust database release contract is ready' }
}

export async function verifyMetricTrustReleaseReadiness({
  env = process.env,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const rawOrigin = env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!rawOrigin || !serviceRoleKey) {
    throw new Error('production database readiness credentials are unavailable')
  }

  let origin
  try {
    origin = new URL(rawOrigin).origin
  } catch {
    throw new Error('production Supabase origin is invalid')
  }
  if (origin !== PRODUCTION_SUPABASE_ORIGIN || rawOrigin.replace(/\/$/, '') !== origin) {
    throw new Error('production Supabase origin is not bound to the Arena project')
  }
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable')

  const endpoint = `${origin}/rest/v1/rpc/arena_metric_trust_release_readiness`
  let lastFailure = 'readiness endpoint did not respond'
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
        signal: AbortSignal.timeout(10_000),
      })
      if (response.ok) {
        const result = validateMetricTrustReadiness(await response.json())
        if (!result.ready) throw new Error(result.reason)
        return result
      }
      lastFailure = `readiness endpoint returned HTTP ${response.status}`
      if (!TRANSIENT_STATUS.has(response.status)) break
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : 'readiness request failed'
      if (
        /contract|malformed|missing|lineage|quarantine|credentials|origin|project/.test(lastFailure)
      ) {
        break
      }
    }
    if (attempt < 4) await sleep(attempt * 1_000)
  }
  throw new Error(lastFailure)
}

async function main() {
  try {
    const result = await verifyMetricTrustReleaseReadiness()
    console.log(result.reason)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'database readiness verification failed')
    process.exitCode = 1
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main()
}
