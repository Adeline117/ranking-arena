import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_WAIT_TIMEOUT_MS,
  waitForVercelDeployment,
} from '../ci/wait-for-vercel-deployment.mjs'

const candidateUrl = 'https://ranking-arena-candidate.vercel.app'
const token = 'vercel-token-that-must-not-leak'
const teamId = 'team_example'

function response(status, payload = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }
}

function harness(sequence, { timeoutMs = 100, pollIntervalMs = 10, cancelStatus = 200 } = {}) {
  let clock = 0
  let index = 0
  const calls = []
  const logs = []
  const warnings = []
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET'
    calls.push({ url: String(url), method, headers: init.headers })
    if (method === 'PATCH') return response(cancelStatus)

    const item = sequence[Math.min(index, sequence.length - 1)]
    index += 1
    if (item instanceof Error) throw item
    if (item?.malformed) {
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('bad json')
        },
      }
    }
    if (item?.http) return response(item.http)
    return response(200, item)
  }

  return {
    calls,
    logs,
    warnings,
    options: {
      deploymentUrl: candidateUrl,
      token,
      teamId,
      timeoutMs,
      pollIntervalMs,
      requestTimeoutMs: 100,
      fetchImpl,
      now: () => clock,
      sleep: async (durationMs) => {
        clock += durationMs
      },
      log: (message) => logs.push(message),
      warn: (message) => warnings.push(message),
    },
  }
}

test('waits through Vercel non-terminal states and returns only on READY', async () => {
  const subject = harness([
    { id: 'dpl_123', readyState: 'INITIALIZING' },
    { id: 'dpl_123', readyState: 'QUEUED' },
    { id: 'dpl_123', readyState: 'BUILDING' },
    { id: 'dpl_123', readyState: 'READY' },
  ])

  const result = await waitForVercelDeployment(subject.options)
  assert.deepEqual(result, { id: 'dpl_123', state: 'READY' })
  assert.equal(subject.calls.length, 4)
  assert.equal(
    subject.calls.some((call) => call.method === 'PATCH'),
    false
  )

  const statusUrl = new URL(subject.calls[0].url)
  assert.equal(statusUrl.pathname, '/v13/deployments/ranking-arena-candidate.vercel.app')
  assert.equal(statusUrl.searchParams.get('teamId'), teamId)
  assert.equal(subject.calls[0].headers.Authorization, `Bearer ${token}`)
  assert.doesNotMatch(`${subject.logs.join('\n')}${subject.warnings.join('\n')}`, /vercel-token/)
})

test('fails immediately for Vercel terminal failure states without cancelling twice', async () => {
  for (const state of ['ERROR', 'CANCELED']) {
    const subject = harness([{ id: 'dpl_failed', readyState: state }])
    await assert.rejects(
      waitForVercelDeployment(subject.options),
      new RegExp(`terminal state ${state}`)
    )
    assert.equal(subject.calls.length, 1)
    assert.equal(subject.calls[0].method, 'GET')
  }
})

test('bounds a stuck build, cancels it once, and still fails closed', async () => {
  const subject = harness([{ id: 'dpl_stuck', readyState: 'BUILDING' }], {
    timeoutMs: 20,
    pollIntervalMs: 10,
  })

  await assert.rejects(waitForVercelDeployment(subject.options), /did not reach READY/)
  assert.equal(subject.calls.filter((call) => call.method === 'GET').length, 3)
  const cancelCalls = subject.calls.filter((call) => call.method === 'PATCH')
  assert.equal(cancelCalls.length, 1)
  const cancelUrl = new URL(cancelCalls[0].url)
  assert.equal(cancelUrl.pathname, '/v12/deployments/dpl_stuck/cancel')
  assert.equal(cancelUrl.searchParams.get('teamId'), teamId)
})

test('retries transient status failures but rejects authorization and malformed responses', async () => {
  const transient = harness([
    { http: 404 },
    { http: 429 },
    new Error('network unavailable'),
    { id: 'dpl_recovered', readyState: 'READY' },
  ])
  await assert.doesNotReject(waitForVercelDeployment(transient.options))
  assert.equal(transient.warnings.length, 3)

  const unauthorized = harness([{ http: 401 }])
  await assert.rejects(
    waitForVercelDeployment(unauthorized.options),
    /authorization failed \(HTTP 401\)/
  )
  assert.equal(unauthorized.calls.length, 1)

  const malformed = harness([{ malformed: true }])
  await assert.rejects(waitForVercelDeployment(malformed.options), /status response was malformed/)
  assert.equal(malformed.calls.length, 1)
})

test('never promotes an unknown state and reports a failed best-effort cancellation', async () => {
  const subject = harness([{ id: 'dpl_unknown', readyState: 'PAUSED' }], {
    timeoutMs: 10,
    pollIntervalMs: 10,
    cancelStatus: 400,
  })
  await assert.rejects(waitForVercelDeployment(subject.options), /last state PAUSED/)
  assert.equal(subject.calls.filter((call) => call.method === 'PATCH').length, 1)
  assert.match(subject.warnings.at(-1), /cancellation returned HTTP 400/)
})

test('rejects unsafe deployment URLs and caps the production wait below the job timeout', async () => {
  assert.equal(DEFAULT_WAIT_TIMEOUT_MS, 20 * 60 * 1000)
  const subject = harness([{ id: 'dpl_bad', readyState: 'READY' }])
  await assert.rejects(
    waitForVercelDeployment({
      ...subject.options,
      deploymentUrl: 'https://vercel.app.evil.example',
    }),
    /invalid deployment URL/
  )
  assert.equal(subject.calls.length, 0)
})
