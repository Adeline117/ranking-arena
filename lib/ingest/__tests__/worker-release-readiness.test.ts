import {
  evaluateWorkerReleaseReadiness,
  WORKER_RELEASE_READINESS_CONTRACT,
} from '../worker-release-readiness'

const SHA = 'a'.repeat(40)
const OLD_SHA = 'b'.repeat(40)
const NOW = Date.parse('2026-07-21T08:00:00.000Z')

function beat(regions: string[], sha = SHA, ageMs = 30_000, attemptBoundCapture = true) {
  return JSON.stringify({
    ts: NOW - ageMs,
    regions,
    sha,
    attempt_bound_capture: attemptBoundCapture,
  })
}

describe('worker release readiness', () => {
  test('requires exact-SHA coverage for local and vps_sg', () => {
    expect(
      evaluateWorkerReleaseReadiness(
        {
          mac: beat(['local']),
          singapore: beat(['vps_sg']),
        },
        SHA,
        NOW
      )
    ).toEqual({
      contract: WORKER_RELEASE_READINESS_CONTRACT,
      expected_sha: SHA,
      failover_regions: [],
      healthy_workers: [
        {
          age_seconds: 30,
          attempt_bound_capture: true,
          node: 'mac',
          regions: ['local'],
          sha: SHA,
        },
        {
          age_seconds: 30,
          attempt_bound_capture: true,
          node: 'singapore',
          regions: ['vps_sg'],
          sha: SHA,
        },
      ],
      invalid_nodes: [],
      missing_regions: [],
      ready: true,
      required_regions: ['local', 'vps_sg'],
      stale_workers: [],
    })
  })

  test('rejects a covered region when any fresh consumer is stale code', () => {
    const result = evaluateWorkerReleaseReadiness(
      {
        mac: beat(['local']),
        singapore: beat(['vps_sg']),
        staleSplitBrain: beat(['vps_sg'], OLD_SHA),
      },
      SHA,
      NOW
    )

    expect(result.missing_regions).toEqual([])
    expect(result.healthy_workers.map((worker) => worker.sha)).toContain(OLD_SHA)
    expect(result.ready).toBe(false)
  })

  test('rejects unknown SHA, missing regions, malformed beats, and future clocks', () => {
    const result = evaluateWorkerReleaseReadiness(
      {
        badJson: '{',
        future: beat(['vps_sg'], SHA, -61_000),
        local: beat(['local'], 'unknown'),
      },
      SHA,
      NOW
    )

    expect(result.invalid_nodes).toEqual(['badJson', 'future'])
    expect(result.missing_regions).toEqual(['local', 'vps_sg'])
    expect(result.healthy_workers).toEqual([
      {
        age_seconds: 30,
        attempt_bound_capture: true,
        node: 'local',
        regions: ['local'],
        sha: 'unknown',
      },
    ])
    expect(result.ready).toBe(false)
  })

  test('blocks recently stale owners but ignores decommissioned and unrelated nodes', () => {
    const result = evaluateWorkerReleaseReadiness(
      {
        old: beat(['local'], OLD_SHA, 5 * 60_000),
        retired: beat(['vps_sg'], OLD_SHA, 24 * 3600_000),
        japan: beat(['vps_jp'], OLD_SHA),
        current: beat(['local', 'vps_sg']),
      },
      SHA,
      NOW
    )

    expect(result.ready).toBe(false)
    expect(result.healthy_workers).toHaveLength(1)
    expect(result.healthy_workers[0].node).toBe('current')
    expect(result.stale_workers.map((worker) => worker.node)).toEqual(['old'])
  })

  test('requires two unique owners and the attempt-bound capture flag', () => {
    expect(
      evaluateWorkerReleaseReadiness({ combined: beat(['local', 'vps_sg']) }, SHA, NOW).ready
    ).toBe(false)

    expect(
      evaluateWorkerReleaseReadiness(
        {
          mac: beat(['local']),
          sg: beat(['vps_sg']),
        },
        SHA,
        NOW,
        'local'
      ).ready
    ).toBe(false)

    expect(
      evaluateWorkerReleaseReadiness(
        {
          mac: beat(['local'], SHA, 30_000, false),
          sg: beat(['vps_sg']),
        },
        SHA,
        NOW
      ).ready
    ).toBe(false)

    expect(
      evaluateWorkerReleaseReadiness(
        {
          mac: beat(['local']),
          macDuplicate: beat(['local']),
          sg: beat(['vps_sg']),
        },
        SHA,
        NOW
      ).ready
    ).toBe(false)
  })
})
