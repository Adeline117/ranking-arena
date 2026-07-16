import assert from 'node:assert/strict'
import test from 'node:test'
import {
  installReadOnlyNetworkGuard,
  readOnlyViolation,
  telemetryStubFor,
} from './read-only-network-guard.mjs'

const base = 'https://www.arenafi.org'
const supabase = 'https://project.supabase.co'

test('allows read-only app requests', () => {
  assert.equal(
    readOnlyViolation({ method: 'GET', url: `${base}/api/traders`, baseUrl: base }),
    null
  )
})

test('blocks app mutations without retaining query data', () => {
  assert.deepEqual(
    readOnlyViolation({
      method: 'POST',
      url: `${base}/api/feedback?token=sensitive`,
      baseUrl: base,
    }),
    { method: 'POST', scope: 'app', target: `${base}/api/feedback` }
  )
})

test('allows only explicitly read-only same-origin POST endpoints', () => {
  for (const path of [
    '/api/posts/bookmarks/status',
    '/api/profile/handle-availability',
    '/api/rankings/rank-history',
    '/api/traders/sparklines',
  ]) {
    assert.equal(readOnlyViolation({ method: 'POST', url: `${base}${path}`, baseUrl: base }), null)
  }

  assert.equal(
    readOnlyViolation({
      method: 'POST',
      url: `${base}/api/traders/sparklines/delete`,
      baseUrl: base,
    })?.scope,
    'app'
  )
})

test('stubs production telemetry instead of sending or aborting it', () => {
  assert.equal(
    telemetryStubFor({ method: 'POST', url: `${base}/api/analytics/events`, baseUrl: base })
      ?.status,
    202
  )
  assert.equal(
    telemetryStubFor({ method: 'POST', url: `${base}/cdn-cgi/rum`, baseUrl: base })?.status,
    204
  )
  assert.equal(
    readOnlyViolation({ method: 'POST', url: `${base}/api/analytics/events`, baseUrl: base }),
    null
  )
  assert.equal(
    telemetryStubFor({ method: 'POST', url: 'https://cloudflare.com/cdn-cgi/rum', baseUrl: base }),
    null
  )
})

test('blocks direct Supabase data and auth mutations', () => {
  assert.deepEqual(
    readOnlyViolation({
      method: 'PATCH',
      url: `${supabase}/rest/v1/user_profiles?id=eq.qa`,
      baseUrl: base,
      supabaseUrl: supabase,
    }),
    {
      method: 'PATCH',
      scope: 'supabase',
      target: `${supabase}/rest/v1/user_profiles`,
    }
  )
  assert.equal(
    readOnlyViolation({
      method: 'POST',
      url: `${supabase}/auth/v1/logout`,
      baseUrl: base,
      supabaseUrl: supabase,
    })?.scope,
    'supabase'
  )
})

test('allows only the Supabase refresh-token maintenance mutation', () => {
  assert.equal(
    readOnlyViolation({
      method: 'POST',
      url: `${supabase}/auth/v1/token?grant_type=refresh_token`,
      baseUrl: base,
      supabaseUrl: supabase,
    }),
    null
  )
})

test('does not block external POST-based read APIs', () => {
  assert.equal(
    readOnlyViolation({
      method: 'POST',
      url: 'https://api.thegraph.com/graphql',
      baseUrl: base,
      supabaseUrl: supabase,
    }),
    null
  )
})

test('installed guard aborts a product mutation before dispatch', async () => {
  let handler
  const context = {
    async route(pattern, callback) {
      assert.equal(pattern, '**/*')
      handler = callback
    },
  }
  const blocked = []
  await installReadOnlyNetworkGuard(context, {
    baseUrl: base,
    supabaseUrl: supabase,
    onBlocked: (violation) => blocked.push(violation),
  })

  let abortReason = null
  let continued = false
  await handler({
    request: () => ({ method: () => 'DELETE', url: () => `${base}/api/watchlist?id=1` }),
    abort: async (reason) => {
      abortReason = reason
    },
    continue: async () => {
      continued = true
    },
  })

  assert.equal(abortReason, 'blockedbyclient')
  assert.equal(continued, false)
  assert.equal(blocked.length, 1)
  assert.equal(blocked[0].target, `${base}/api/watchlist`)
})

test('installed guard fulfils telemetry locally without reporting a violation', async () => {
  let handler
  const context = {
    async route(_pattern, callback) {
      handler = callback
    },
  }
  const blocked = []
  await installReadOnlyNetworkGuard(context, {
    baseUrl: base,
    supabaseUrl: supabase,
    onBlocked: (violation) => blocked.push(violation),
  })

  let fulfilled = null
  let continued = false
  await handler({
    request: () => ({ method: () => 'POST', url: () => `${base}/api/analytics/events` }),
    fulfill: async (response) => {
      fulfilled = response
    },
    abort: async () => {
      throw new Error('telemetry must not be aborted')
    },
    continue: async () => {
      continued = true
    },
  })

  assert.equal(fulfilled.status, 202)
  assert.equal(continued, false)
  assert.deepEqual(blocked, [])
})
