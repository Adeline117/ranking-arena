import assert from 'node:assert/strict'
import test from 'node:test'

import {
  METRIC_TRUST_READINESS_CONTRACT,
  PRODUCTION_SUPABASE_ORIGIN,
  validateMetricTrustReadiness,
  verifyMetricTrustReleaseReadiness,
} from '../ci/verify-metric-trust-release-readiness.mjs'

const readyPayload = (overrides = {}) => ({
  contract: METRIC_TRUST_READINESS_CONTRACT,
  ready: true,
  missing: [],
  legacy_complete_verified_count: 0,
  source_page_lineage_column: true,
  ...overrides,
})

test('metric-trust readiness requires the exact complete contract', () => {
  assert.equal(validateMetricTrustReadiness(readyPayload()).ready, true)
  for (const payload of [
    null,
    readyPayload({ contract: 'wrong' }),
    readyPayload({ ready: false }),
    readyPayload({ missing: ['arena.metric_trust_observations'] }),
    readyPayload({ missing: 'none' }),
    readyPayload({ legacy_complete_verified_count: 1 }),
    readyPayload({ source_page_lineage_column: false }),
  ]) {
    assert.equal(validateMetricTrustReadiness(payload).ready, false)
  }
})

test('release verification is project-bound and sends credentials only as headers', async () => {
  const calls = []
  const result = await verifyMetricTrustReleaseReadiness({
    env: {
      NEXT_PUBLIC_SUPABASE_URL: PRODUCTION_SUPABASE_ORIGIN,
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    },
    fetchImpl: async (...args) => {
      calls.push(args)
      return { ok: true, status: 200, json: async () => readyPayload() }
    },
  })

  assert.equal(result.ready, true)
  assert.equal(calls.length, 1)
  assert.equal(
    calls[0][0],
    `${PRODUCTION_SUPABASE_ORIGIN}/rest/v1/rpc/arena_metric_trust_release_readiness`
  )
  assert.equal(calls[0][1].method, 'POST')
  assert.equal(calls[0][1].body, '{}')
  assert.equal(calls[0][1].headers.Authorization, 'Bearer test-service-role-key')
  assert.doesNotMatch(calls[0][0], /test-service-role-key/)
})

test('release verification fails closed on missing credentials, wrong project, or missing RPC', async () => {
  let fetchCalls = 0
  const fetchImpl = async () => {
    fetchCalls += 1
    return { ok: false, status: 404 }
  }

  await assert.rejects(
    verifyMetricTrustReleaseReadiness({ env: {}, fetchImpl }),
    /credentials are unavailable/
  )
  await assert.rejects(
    verifyMetricTrustReleaseReadiness({
      env: {
        NEXT_PUBLIC_SUPABASE_URL: 'https://other.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'secret',
      },
      fetchImpl,
    }),
    /not bound to the Arena project/
  )
  await assert.rejects(
    verifyMetricTrustReleaseReadiness({
      env: {
        NEXT_PUBLIC_SUPABASE_URL: PRODUCTION_SUPABASE_ORIGIN,
        SUPABASE_SERVICE_ROLE_KEY: 'secret',
      },
      fetchImpl,
      sleep: async () => {},
    }),
    /HTTP 404/
  )
  assert.equal(fetchCalls, 1)
})

test('release verification retries transient responses without accepting malformed success', async () => {
  let attempts = 0
  const env = {
    NEXT_PUBLIC_SUPABASE_URL: PRODUCTION_SUPABASE_ORIGIN,
    SUPABASE_SERVICE_ROLE_KEY: 'secret',
  }
  const result = await verifyMetricTrustReleaseReadiness({
    env,
    fetchImpl: async () => {
      attempts += 1
      if (attempts < 3) return { ok: false, status: 503 }
      return { ok: true, status: 200, json: async () => readyPayload() }
    },
    sleep: async () => {},
  })
  assert.equal(result.ready, true)
  assert.equal(attempts, 3)

  await assert.rejects(
    verifyMetricTrustReleaseReadiness({
      env,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ready: true }) }),
      sleep: async () => {},
    }),
    /contract is missing or unsupported/
  )
})
