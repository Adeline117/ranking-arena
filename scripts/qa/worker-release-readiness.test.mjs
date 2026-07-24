import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WORKER_RELEASE_READINESS_CONTRACT,
  validateWorkerReleaseReadiness,
  verifyWorkerReleaseReadinessPayload,
} from '../ci/verify-worker-release-readiness.mjs'

const SHA = 'a'.repeat(40)
const OLD_SHA = 'b'.repeat(40)
const RELEASE_ID = 'c'.repeat(64)
const OLD_RELEASE_ID = 'd'.repeat(64)

const worker = (overrides = {}) => ({
  age_seconds: 20,
  attempt_bound_capture: true,
  node: 'mac',
  release_id: RELEASE_ID,
  regions: ['local'],
  sha: SHA,
  ...overrides,
})

const readyPayload = (overrides = {}) => ({
  contract: WORKER_RELEASE_READINESS_CONTRACT,
  expected_release_id: RELEASE_ID,
  expected_sha: SHA,
  failover_regions: [],
  healthy_workers: [worker(), worker({ age_seconds: 30, node: 'sg', regions: ['vps_sg'] })],
  invalid_nodes: [],
  missing_regions: [],
  ready: true,
  required_regions: ['local', 'vps_sg'],
  stale_workers: [],
  ...overrides,
})

test('worker release validator accepts only the exact two-owner v3 fleet', () => {
  assert.equal(validateWorkerReleaseReadiness(readyPayload(), SHA, RELEASE_ID).ready, true)

  for (const payload of [
    null,
    readyPayload({ contract: 'wrong' }),
    readyPayload({ expected_sha: OLD_SHA }),
    readyPayload({ expected_release_id: OLD_RELEASE_ID }),
    readyPayload({ invalid_nodes: ['bad-node'], ready: false }),
    readyPayload({ missing_regions: ['vps_sg'], ready: false }),
    readyPayload({
      healthy_workers: [worker({ age_seconds: 300 })],
      missing_regions: ['vps_sg'],
      ready: false,
    }),
    readyPayload({ extra: true }),
  ]) {
    assert.equal(validateWorkerReleaseReadiness(payload, SHA, RELEASE_ID).ready, false)
  }
})

test('worker release validator permits different audit SHAs for one runtime release', () => {
  const payload = readyPayload({
    healthy_workers: [
      worker(),
      worker({ age_seconds: 30, node: 'sg', regions: ['vps_sg'], sha: OLD_SHA }),
    ],
  })
  assert.equal(validateWorkerReleaseReadiness(payload, SHA, RELEASE_ID).ready, true)
})

test('worker release validator rejects failover, stale, split-brain, disabled, and duplicate owners', () => {
  const cases = [
    readyPayload({ failover_regions: ['local'], ready: false }),
    readyPayload({
      stale_workers: [worker({ age_seconds: 301, node: 'old-local', sha: OLD_SHA })],
      ready: false,
    }),
    readyPayload({
      healthy_workers: [
        ...readyPayload().healthy_workers,
        worker({
          age_seconds: 10,
          node: 'old-sg',
          regions: ['vps_sg'],
          release_id: OLD_RELEASE_ID,
          sha: OLD_SHA,
        }),
      ],
      ready: false,
    }),
    readyPayload({
      healthy_workers: [
        worker({ attempt_bound_capture: false }),
        worker({ node: 'sg', regions: ['vps_sg'] }),
      ],
      ready: false,
    }),
    readyPayload({
      healthy_workers: [
        worker(),
        worker({ node: 'local-duplicate' }),
        worker({ node: 'sg', regions: ['vps_sg'] }),
      ],
      ready: false,
    }),
    readyPayload({
      healthy_workers: [worker({ regions: ['local', 'vps_sg'] })],
      ready: false,
    }),
  ]

  for (const payload of cases) {
    assert.match(
      validateWorkerReleaseReadiness(payload, SHA, RELEASE_ID).reason,
      /failover flags, stale owners, duplicates, invalid state, disabled v3, or another release ID/
    )
  }
})

test('worker release validator recomputes evidence instead of trusting ready', () => {
  const dishonest = readyPayload({
    healthy_workers: [worker()],
  })
  assert.match(validateWorkerReleaseReadiness(dishonest, SHA, RELEASE_ID).reason, /inconsistent/)
})

test('payload verification reads one bounded file and binds it to HEAD_SHA', () => {
  const paths = []
  const computeCalls = []
  const env = {
    GITHUB_WORKSPACE: '/workspace/repository',
    HEAD_SHA: SHA,
    WORKER_RELEASE_ID: RELEASE_ID,
    WORKER_READINESS_PAYLOAD_FILE: '/tmp/readiness.json',
  }
  const result = verifyWorkerReleaseReadinessPayload({
    env,
    readFileImpl: (path) => {
      paths.push(path)
      return JSON.stringify(readyPayload())
    },
    computeReleaseIdImpl: (...args) => {
      computeCalls.push(args)
      return RELEASE_ID
    },
  })

  assert.equal(result.ready, true)
  assert.deepEqual(paths, ['/tmp/readiness.json'])
  assert.deepEqual(computeCalls, [[SHA, { cwd: '/workspace/repository', env }]])
})

test('payload verification rejects missing, malformed, and oversized evidence', () => {
  assert.throws(() => verifyWorkerReleaseReadinessPayload({ env: {} }), /expected worker SHA/)
  assert.throws(
    () => verifyWorkerReleaseReadinessPayload({ env: { HEAD_SHA: SHA } }),
    /expected worker release ID/
  )
  assert.throws(
    () =>
      verifyWorkerReleaseReadinessPayload({
        env: { HEAD_SHA: SHA, WORKER_RELEASE_ID: RELEASE_ID },
        computeReleaseIdImpl: () => RELEASE_ID,
      }),
    /payload file is unavailable/
  )
  assert.throws(
    () =>
      verifyWorkerReleaseReadinessPayload({
        env: {
          HEAD_SHA: SHA,
          WORKER_RELEASE_ID: RELEASE_ID,
          WORKER_READINESS_PAYLOAD_FILE: '/tmp/readiness.json',
        },
        readFileImpl: () => '<html>login</html>',
        computeReleaseIdImpl: () => RELEASE_ID,
      }),
    /not valid JSON/
  )
  assert.throws(
    () =>
      verifyWorkerReleaseReadinessPayload({
        env: {
          HEAD_SHA: SHA,
          WORKER_RELEASE_ID: RELEASE_ID,
          WORKER_READINESS_PAYLOAD_FILE: '/tmp/readiness.json',
        },
        readFileImpl: () => 'x'.repeat(64 * 1024 + 1),
        computeReleaseIdImpl: () => RELEASE_ID,
      }),
    /payload size is invalid/
  )
  assert.throws(
    () =>
      verifyWorkerReleaseReadinessPayload({
        env: {
          HEAD_SHA: SHA,
          WORKER_RELEASE_ID: RELEASE_ID,
          WORKER_READINESS_PAYLOAD_FILE: '/tmp/readiness.json',
        },
        computeReleaseIdImpl: () => OLD_RELEASE_ID,
      }),
    /not exact HEAD/
  )
  assert.throws(
    () =>
      verifyWorkerReleaseReadinessPayload({
        env: {
          HEAD_SHA: SHA,
          WORKER_RELEASE_ID: RELEASE_ID,
          WORKER_READINESS_PAYLOAD_FILE: '/tmp/readiness.json',
        },
        computeReleaseIdImpl: () => {
          throw new Error('git unavailable')
        },
      }),
    /git unavailable/
  )
})
