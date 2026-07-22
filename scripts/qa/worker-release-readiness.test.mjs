import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WORKER_RELEASE_READINESS_CONTRACT,
  validateWorkerReleaseReadiness,
  verifyWorkerReleaseReadinessPayload,
} from '../ci/verify-worker-release-readiness.mjs'

const SHA = 'a'.repeat(40)
const OLD_SHA = 'b'.repeat(40)

const worker = (overrides = {}) => ({
  age_seconds: 20,
  attempt_bound_capture: true,
  node: 'mac',
  regions: ['local'],
  sha: SHA,
  ...overrides,
})

const readyPayload = (overrides = {}) => ({
  contract: WORKER_RELEASE_READINESS_CONTRACT,
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
  assert.equal(validateWorkerReleaseReadiness(readyPayload(), SHA).ready, true)

  for (const payload of [
    null,
    readyPayload({ contract: 'wrong' }),
    readyPayload({ expected_sha: OLD_SHA }),
    readyPayload({ invalid_nodes: ['bad-node'], ready: false }),
    readyPayload({ missing_regions: ['vps_sg'], ready: false }),
    readyPayload({
      healthy_workers: [worker({ age_seconds: 300 })],
      missing_regions: ['vps_sg'],
      ready: false,
    }),
    readyPayload({ extra: true }),
  ]) {
    assert.equal(validateWorkerReleaseReadiness(payload, SHA).ready, false)
  }
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
        worker({ age_seconds: 10, node: 'old-sg', regions: ['vps_sg'], sha: OLD_SHA }),
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
      validateWorkerReleaseReadiness(payload, SHA).reason,
      /failover flags, stale owners, duplicates, invalid state, disabled v3, or another SHA/
    )
  }
})

test('worker release validator recomputes evidence instead of trusting ready', () => {
  const dishonest = readyPayload({
    healthy_workers: [worker()],
  })
  assert.match(validateWorkerReleaseReadiness(dishonest, SHA).reason, /inconsistent/)
})

test('payload verification reads one bounded file and binds it to HEAD_SHA', () => {
  const paths = []
  const result = verifyWorkerReleaseReadinessPayload({
    env: { HEAD_SHA: SHA, WORKER_READINESS_PAYLOAD_FILE: '/tmp/readiness.json' },
    readFileImpl: (path) => {
      paths.push(path)
      return JSON.stringify(readyPayload())
    },
  })

  assert.equal(result.ready, true)
  assert.deepEqual(paths, ['/tmp/readiness.json'])
})

test('payload verification rejects missing, malformed, and oversized evidence', () => {
  assert.throws(() => verifyWorkerReleaseReadinessPayload({ env: {} }), /expected worker SHA/)
  assert.throws(
    () => verifyWorkerReleaseReadinessPayload({ env: { HEAD_SHA: SHA } }),
    /payload file is unavailable/
  )
  assert.throws(
    () =>
      verifyWorkerReleaseReadinessPayload({
        env: { HEAD_SHA: SHA, WORKER_READINESS_PAYLOAD_FILE: '/tmp/readiness.json' },
        readFileImpl: () => '<html>login</html>',
      }),
    /not valid JSON/
  )
  assert.throws(
    () =>
      verifyWorkerReleaseReadinessPayload({
        env: { HEAD_SHA: SHA, WORKER_READINESS_PAYLOAD_FILE: '/tmp/readiness.json' },
        readFileImpl: () => 'x'.repeat(64 * 1024 + 1),
      }),
    /payload size is invalid/
  )
})
