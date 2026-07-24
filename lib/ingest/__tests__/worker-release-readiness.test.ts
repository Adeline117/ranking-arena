import {
  evaluateWorkerReleaseReadiness,
  summarizeWorkerRuntimeDrift,
  WORKER_RELEASE_READINESS_CONTRACT,
} from '../worker-release-readiness'

const SHA = 'a'.repeat(40)
const OLD_SHA = 'b'.repeat(40)
const RELEASE_ID = 'c'.repeat(64)
const OLD_RELEASE_ID = 'd'.repeat(64)
const NOW = Date.parse('2026-07-21T08:00:00.000Z')

function beat(
  regions: string[],
  sha = SHA,
  ageMs = 30_000,
  attemptBoundCapture = true,
  releaseId = RELEASE_ID
) {
  return JSON.stringify({
    ts: NOW - ageMs,
    regions,
    sha,
    release_id: releaseId,
    attempt_bound_capture: attemptBoundCapture,
  })
}

describe('worker release readiness', () => {
  test('requires exact worker-release coverage for local and vps_sg', () => {
    expect(
      evaluateWorkerReleaseReadiness(
        {
          mac: beat(['local']),
          singapore: beat(['vps_sg']),
        },
        SHA,
        RELEASE_ID,
        NOW
      )
    ).toEqual({
      contract: WORKER_RELEASE_READINESS_CONTRACT,
      expected_release_id: RELEASE_ID,
      expected_sha: SHA,
      failover_regions: [],
      healthy_workers: [
        {
          age_seconds: 30,
          attempt_bound_capture: true,
          node: 'mac',
          release_id: RELEASE_ID,
          regions: ['local'],
          sha: SHA,
        },
        {
          age_seconds: 30,
          attempt_bound_capture: true,
          node: 'singapore',
          release_id: RELEASE_ID,
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

  test('rejects a covered region when any fresh consumer has another worker release', () => {
    const result = evaluateWorkerReleaseReadiness(
      {
        mac: beat(['local']),
        singapore: beat(['vps_sg']),
        staleSplitBrain: beat(['vps_sg'], OLD_SHA, 30_000, true, OLD_RELEASE_ID),
      },
      SHA,
      RELEASE_ID,
      NOW
    )

    expect(result.missing_regions).toEqual([])
    expect(result.healthy_workers.map((worker) => worker.sha)).toContain(OLD_SHA)
    expect(result.ready).toBe(false)
  })

  test('allows different audit SHAs when the worker runtime inputs are identical', () => {
    const result = evaluateWorkerReleaseReadiness(
      {
        mac: beat(['local']),
        singapore: beat(['vps_sg'], OLD_SHA),
      },
      SHA,
      RELEASE_ID,
      NOW
    )

    expect(result.healthy_workers.map((worker) => worker.sha)).toEqual([SHA, OLD_SHA])
    expect(result.ready).toBe(true)
  })

  test('rejects unknown SHA, missing regions, malformed beats, and future clocks', () => {
    const result = evaluateWorkerReleaseReadiness(
      {
        badJson: '{',
        future: beat(['vps_sg'], SHA, -61_000),
        local: beat(['local'], 'unknown', 30_000, true, 'unknown'),
      },
      SHA,
      RELEASE_ID,
      NOW
    )

    expect(result.invalid_nodes).toEqual(['badJson', 'future'])
    expect(result.missing_regions).toEqual(['local', 'vps_sg'])
    expect(result.healthy_workers).toEqual([
      {
        age_seconds: 30,
        attempt_bound_capture: true,
        node: 'local',
        release_id: 'unknown',
        regions: ['local'],
        sha: 'unknown',
      },
    ])
    expect(result.ready).toBe(false)
  })

  test('blocks recently stale owners but ignores decommissioned and unrelated nodes', () => {
    const result = evaluateWorkerReleaseReadiness(
      {
        old: beat(['local'], OLD_SHA, 5 * 60_000, true, OLD_RELEASE_ID),
        retired: beat(['vps_sg'], OLD_SHA, 24 * 3600_000, true, OLD_RELEASE_ID),
        japan: beat(['vps_jp'], OLD_SHA, 30_000, true, OLD_RELEASE_ID),
        current: beat(['local', 'vps_sg']),
      },
      SHA,
      RELEASE_ID,
      NOW
    )

    expect(result.ready).toBe(false)
    expect(result.healthy_workers).toHaveLength(1)
    expect(result.healthy_workers[0].node).toBe('current')
    expect(result.stale_workers.map((worker) => worker.node)).toEqual(['old'])
  })

  test('requires two unique owners and the attempt-bound capture flag', () => {
    expect(
      evaluateWorkerReleaseReadiness({ combined: beat(['local', 'vps_sg']) }, SHA, RELEASE_ID, NOW)
        .ready
    ).toBe(false)

    expect(
      evaluateWorkerReleaseReadiness(
        {
          mac: beat(['local']),
          sg: beat(['vps_sg']),
        },
        SHA,
        RELEASE_ID,
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
        RELEASE_ID,
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
        RELEASE_ID,
        NOW
      ).ready
    ).toBe(false)
  })
})

describe('worker runtime drift summary', () => {
  test('allows one release across different audit SHAs', () => {
    expect(
      summarizeWorkerRuntimeDrift([
        { node: 'mac', release_id: RELEASE_ID, sha: SHA },
        { node: 'sg', release_id: RELEASE_ID, sha: OLD_SHA },
      ])
    ).toEqual({
      distinct_release_ids: [RELEASE_ID],
      invalid_nodes: [],
      drift: false,
    })
  })

  test('flags different releases and never treats unknown identities as convergence', () => {
    expect(
      summarizeWorkerRuntimeDrift([
        { node: 'mac', release_id: RELEASE_ID, sha: SHA },
        { node: 'sg', release_id: OLD_RELEASE_ID, sha: OLD_SHA },
      ]).drift
    ).toBe(true)

    expect(
      summarizeWorkerRuntimeDrift([
        { node: 'mac', release_id: 'unknown', sha: SHA },
        { node: 'sg', release_id: 'unknown', sha: OLD_SHA },
      ])
    ).toEqual({
      distinct_release_ids: [],
      invalid_nodes: ['mac', 'sg'],
      drift: true,
    })
  })
})
