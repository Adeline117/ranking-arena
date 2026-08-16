import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'tsx/esm/api'

const unregister = register()
const heartbeatProof = await (async () => {
  try {
    return await import('../../worker/verify-local-heartbeat.ts')
  } finally {
    await unregister()
  }
})()

const {
  discoverExistingLocalNode,
  discoveryRequestTimeoutMs,
  validateLocalHeartbeatPayload,
  waitForExpectedLocalHeartbeat,
} = heartbeatProof

const NOW = 1_800_000_000_000
const SHA = 'a'.repeat(40)
const RELEASE = 'b'.repeat(64)
const NODE = 'AdelinedeMac-mini.local'
const EXPECTED = {
  pid: 42,
  sha: SHA,
  releaseId: RELEASE,
  nodeId: NODE,
  notBeforeMs: NOW - 10_000,
}

function modernPayload(overrides = {}) {
  return {
    attempt_bound_capture: true,
    disk: 74,
    node: NODE,
    pid: 42,
    regions: ['local'],
    release_id: RELEASE,
    sha: SHA,
    ts: NOW - 1_000,
    ...overrides,
  }
}

test('accepts only the exact fresh post-start local roster identity', () => {
  assert.doesNotThrow(() =>
    validateLocalHeartbeatPayload(JSON.stringify(modernPayload()), EXPECTED, NOW)
  )

  const invalidPayloads = [
    modernPayload({ pid: 43 }),
    modernPayload({ node: `${NODE}-forged` }),
    modernPayload({ sha: 'c'.repeat(40) }),
    modernPayload({ release_id: 'd'.repeat(64) }),
    modernPayload({ attempt_bound_capture: false }),
    modernPayload({ regions: ['local', 'vps_jp'] }),
    modernPayload({ ts: EXPECTED.notBeforeMs - 1 }),
    modernPayload({ ts: NOW + 5_001 }),
    modernPayload({ disk: 101 }),
    { ...modernPayload(), forged: true },
  ]

  for (const payload of invalidPayloads) {
    assert.throws(() => validateLocalHeartbeatPayload(JSON.stringify(payload), EXPECTED, NOW))
  }
  assert.throws(() => validateLocalHeartbeatPayload(null, EXPECTED, NOW))
  assert.throws(() => validateLocalHeartbeatPayload('{', EXPECTED, NOW))
})

test('polls past a stale post-boundary heartbeat until an exact fresh payload arrives', async () => {
  let now = NOW
  let reads = 0
  const expected = { ...EXPECTED, notBeforeMs: NOW }
  const payloads = [
    JSON.stringify(modernPayload({ ts: NOW - 1 })),
    JSON.stringify(modernPayload({ ts: NOW + 500 })),
  ]

  await waitForExpectedLocalHeartbeat(
    async () => payloads[Math.min(reads++, payloads.length - 1)],
    expected,
    {
      timeoutMs: 3_000,
      pollIntervalMs: 1_000,
      now: () => now,
      delay: async (milliseconds) => {
        now += milliseconds
      },
    }
  )

  assert.equal(reads, 2)
})

test('times out when every post-boundary heartbeat remains stale', async () => {
  let now = NOW
  let reads = 0
  const expected = { ...EXPECTED, notBeforeMs: NOW }

  await assert.rejects(
    waitForExpectedLocalHeartbeat(
      async () => {
        reads += 1
        return JSON.stringify(modernPayload({ ts: NOW - 1 }))
      },
      expected,
      {
        timeoutMs: 2_500,
        pollIntervalMs: 1_000,
        now: () => now,
        delay: async (milliseconds) => {
          now += milliseconds
        },
      }
    ),
    /roster identity or freshness is not exact/
  )

  assert.equal(reads, 3)
})

test('caps each legacy HGETALL to the remaining global deadline budget', () => {
  assert.equal(discoveryRequestTimeoutMs(undefined), 5_000)
  assert.equal(discoveryRequestTimeoutMs('90000'), 5_000)
  assert.equal(discoveryRequestTimeoutMs('2400'), 2_400)
  assert.equal(discoveryRequestTimeoutMs('1'), 1)
  assert.throws(() => discoveryRequestTimeoutMs('0'), /request timeout.*malformed/)
  assert.throws(() => discoveryRequestTimeoutMs('not-a-number'), /request timeout.*malformed/)
})

test('discovers one stamped local owner from the modern roster schema', () => {
  assert.deepEqual(
    discoverExistingLocalNode(
      {
        unrelated: JSON.stringify(
          modernPayload({ node: 'unrelated', pid: 90, sha: 'c'.repeat(40) })
        ),
        [NODE]: JSON.stringify(modernPayload()),
      },
      { sha: SHA, releaseId: RELEASE },
      NOW
    ),
    { nodeId: NODE, heartbeatPid: 42 }
  )

  assert.throws(() =>
    discoverExistingLocalNode(
      { [NODE]: JSON.stringify(modernPayload()) },
      { sha: SHA, releaseId: RELEASE, notBeforeMs: NOW },
      NOW
    )
  )
})

test('allows only the exact legacy Mac schema during first migration', () => {
  const legacy = {
    disk: 74,
    node: NODE,
    pid: 84,
    regions: ['local', 'vps_jp'],
    sha: SHA,
    ts: NOW - 1_000,
  }
  assert.deepEqual(
    discoverExistingLocalNode(
      { [NODE]: JSON.stringify(legacy) },
      { sha: SHA, releaseId: 'unknown' },
      NOW
    ),
    { nodeId: NODE, heartbeatPid: 84 }
  )
  assert.throws(() =>
    discoverExistingLocalNode(
      { [NODE]: JSON.stringify(legacy) },
      { sha: SHA, releaseId: 'unknown', notBeforeMs: NOW },
      NOW
    )
  )

  assert.deepEqual(
    discoverExistingLocalNode(
      { [NODE]: JSON.stringify({ ...legacy, regions: ['local'] }) },
      { sha: SHA, releaseId: 'unknown' },
      NOW
    ),
    { nodeId: NODE, heartbeatPid: 84 }
  )
  assert.throws(() =>
    discoverExistingLocalNode(
      {
        [NODE]: JSON.stringify(legacy),
        'duplicate-local': JSON.stringify({ ...legacy, node: 'duplicate-local', pid: 85 }),
      },
      { sha: SHA, releaseId: 'unknown' },
      NOW
    )
  )
})
