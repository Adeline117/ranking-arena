import { evaluateWorkerHeartbeatTopology } from '../worker-heartbeat-topology'

const NOW = Date.parse('2026-07-24T08:00:00.000Z')
const RELEASE_ID = 'a'.repeat(64)
const OTHER_RELEASE_ID = 'b'.repeat(64)
const SHA = 'c'.repeat(40)
const OTHER_SHA = 'd'.repeat(40)

function beat(
  regions: unknown,
  options: {
    attemptBoundCapture?: boolean
    releaseId?: string
    sha?: string
    ts?: unknown
  } = {}
) {
  return JSON.stringify({
    attempt_bound_capture: options.attemptBoundCapture ?? true,
    regions,
    release_id: options.releaseId ?? RELEASE_ID,
    sha: options.sha ?? SHA,
    ts: options.ts ?? NOW - 30_000,
  })
}

describe('worker heartbeat topology', () => {
  test('accepts one distinct owner per region on one release with different audit SHAs', () => {
    const result = evaluateWorkerHeartbeatTopology(
      {
        mac: beat(['local']),
        sg: beat(['vps_sg'], { sha: OTHER_SHA }),
      },
      NOW
    )

    expect(result.ready).toBe(true)
    expect(result.distinct_release_ids).toEqual([RELEASE_ID])
    expect(result.owners.local[0].sha).toBe(SHA)
    expect(result.owners.vps_sg[0].sha).toBe(OTHER_SHA)
  })

  test('isolates malformed timestamps and regions and returns alert evidence', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const result = evaluateWorkerHeartbeatTopology(
      {
        badJson: '{',
        badRegions: beat({ local: true }),
        badTs: beat(['local'], { ts: Number.NaN }),
        future: beat(['vps_sg'], { ts: NOW + 61_000 }),
        primitive: 7,
        circular,
        mac: beat(['local']),
        sg: beat(['vps_sg']),
      },
      NOW
    )

    expect(result.ready).toBe(false)
    expect(result.invalid_nodes).toEqual([
      { node: 'badJson', reason: 'invalid_payload' },
      { node: 'badRegions', reason: 'invalid_regions' },
      { node: 'badTs', reason: 'invalid_ts' },
      { node: 'circular', reason: 'invalid_ts' },
      { node: 'future', reason: 'future_ts' },
      { node: 'primitive', reason: 'invalid_payload' },
    ])
    expect(result.owners.local.map((owner) => owner.node)).toEqual(['mac'])
    expect(result.owners.vps_sg.map((owner) => owner.node)).toEqual(['sg'])
  })

  test.each([
    {
      evidence: 'invalid_release_nodes',
      roster: {
        mac: beat(['local'], { releaseId: 'unknown' }),
        sg: beat(['vps_sg']),
      },
      value: ['mac'],
    },
    {
      evidence: 'duplicate_regions',
      roster: {
        mac: beat(['local']),
        macDuplicate: beat(['local']),
        sg: beat(['vps_sg']),
      },
      value: ['local'],
    },
    {
      evidence: 'combined_owner_nodes',
      roster: { combined: beat(['local', 'vps_sg']) },
      value: ['combined'],
    },
    {
      evidence: 'capture_disabled_nodes',
      roster: {
        mac: beat(['local'], { attemptBoundCapture: false }),
        sg: beat(['vps_sg']),
      },
      value: ['mac'],
    },
  ] as const)('rejects invalid topology with $evidence evidence', ({ evidence, roster, value }) => {
    const result = evaluateWorkerHeartbeatTopology(roster, NOW)

    expect(result.ready).toBe(false)
    expect(result[evidence]).toEqual(value)
  })

  test('rejects required owners running different worker releases', () => {
    const result = evaluateWorkerHeartbeatTopology(
      {
        mac: beat(['local']),
        sg: beat(['vps_sg'], { releaseId: OTHER_RELEASE_ID }),
      },
      NOW
    )

    expect(result.ready).toBe(false)
    expect(result.distinct_release_ids).toEqual([RELEASE_ID, OTHER_RELEASE_ID])
  })
})
