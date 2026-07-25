import assert from 'node:assert/strict'
import test from 'node:test'
import 'tsx/esm'

const { discoverExistingLocalNode, validateLocalHeartbeatPayload } =
  await import('../../worker/verify-local-heartbeat.ts')

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
