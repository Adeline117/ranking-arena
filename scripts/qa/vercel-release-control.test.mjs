import assert from 'node:assert/strict'
import test from 'node:test'

import { enforceVercelReleaseControl } from '../ci/enforce-vercel-release-control.mjs'

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('disables auto-assignment and independently verifies the exact project', async () => {
  const requests = []
  const logs = []
  const result = await enforceVercelReleaseControl({
    token: 'secret-token',
    orgId: 'team_expected',
    projectId: 'prj_expected',
    attempts: 1,
    retryDelayMs: 0,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init })
      return jsonResponse({
        id: 'prj_expected',
        autoAssignCustomDomains: false,
      })
    },
    logger: {
      log: (message) => logs.push(message),
      warn: () => assert.fail('successful enforcement must not retry'),
    },
  })

  assert.equal(result.id, 'prj_expected')
  assert.equal(requests.length, 2)
  assert.deepEqual(
    requests.map(({ init }) => init.method),
    ['PATCH', 'GET']
  )
  assert.equal(
    requests[0].url,
    'https://api.vercel.com/v9/projects/prj_expected?teamId=team_expected'
  )
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    autoAssignCustomDomains: false,
  })
  assert.equal(requests[0].init.headers.Authorization, 'Bearer secret-token')
  assert.equal(requests[1].init.body, undefined)
  assert.match(logs[0], /Deploy Gate is the sole production writer/)
})

test('retries a transient API failure before proving the independent GET', async () => {
  let calls = 0
  const warnings = []
  await enforceVercelReleaseControl({
    token: 'secret-token',
    orgId: 'team_expected',
    projectId: 'prj_expected',
    attempts: 2,
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1
      if (calls === 1) return jsonResponse({ error: { message: 'temporary outage' } }, 503)
      return jsonResponse({ id: 'prj_expected', autoAssignCustomDomains: false })
    },
    logger: {
      log: () => {},
      warn: (message) => warnings.push(message),
    },
  })

  assert.equal(calls, 3)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /attempt 1\/2 failed/)
})

test('fails closed on a mismatched project or enabled auto-assignment', async () => {
  for (const payload of [
    { id: 'prj_other', autoAssignCustomDomains: false },
    { id: 'prj_expected', autoAssignCustomDomains: true },
  ]) {
    await assert.rejects(
      enforceVercelReleaseControl({
        token: 'secret-token',
        orgId: 'team_expected',
        projectId: 'prj_expected',
        attempts: 1,
        retryDelayMs: 0,
        fetchImpl: async () => jsonResponse(payload),
        logger: { log: () => {}, warn: () => {} },
      }),
      /Unable to enforce Vercel release control/
    )
  }
})

test('requires every credential before making a control-plane request', async () => {
  let called = false
  await assert.rejects(
    enforceVercelReleaseControl({
      token: '',
      orgId: 'team_expected',
      projectId: 'prj_expected',
      fetchImpl: async () => {
        called = true
        return jsonResponse({})
      },
    }),
    /VERCEL_TOKEN is required/
  )
  assert.equal(called, false)
})
