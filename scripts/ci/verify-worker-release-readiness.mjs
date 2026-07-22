#!/usr/bin/env node

import { readFileSync } from 'node:fs'

export const WORKER_RELEASE_READINESS_CONTRACT = 'arena.worker-release-readiness@1'
export const REQUIRED_RELEASE_REGIONS = ['local', 'vps_sg']

const READINESS_KEYS = [
  'contract',
  'expected_sha',
  'failover_regions',
  'healthy_workers',
  'invalid_nodes',
  'missing_regions',
  'ready',
  'required_regions',
  'stale_workers',
]
const WORKER_KEYS = ['age_seconds', 'attempt_bound_capture', 'node', 'regions', 'sha']
const COMMIT_SHA = /^[0-9a-f]{40}$/
const STALE_SECONDS = 5 * 60
const DECOMMISSION_SECONDS = 24 * 3600
const MAX_PAYLOAD_BYTES = 64 * 1024

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, keys) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys)
}

function isUniqueStringList(value) {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && item.length > 0 && item.trim() === item) &&
    new Set(value).size === value.length
  )
}

function validateWorkerList(value, { stale, nodes }) {
  if (!Array.isArray(value)) return false
  for (const worker of value) {
    if (
      !isRecord(worker) ||
      !exactKeys(worker, WORKER_KEYS) ||
      typeof worker.node !== 'string' ||
      worker.node.length === 0 ||
      worker.node.trim() !== worker.node ||
      nodes.has(worker.node) ||
      !Number.isSafeInteger(worker.age_seconds) ||
      worker.age_seconds < (stale ? STALE_SECONDS : 0) ||
      worker.age_seconds >= (stale ? DECOMMISSION_SECONDS : STALE_SECONDS) ||
      typeof worker.attempt_bound_capture !== 'boolean' ||
      !isUniqueStringList(worker.regions) ||
      !(worker.sha === 'unknown' || COMMIT_SHA.test(worker.sha))
    ) {
      return false
    }
    nodes.add(worker.node)
  }
  return true
}

export function validateWorkerReleaseReadiness(payload, expectedSha) {
  if (!COMMIT_SHA.test(expectedSha))
    return { ready: false, reason: 'expected worker SHA is invalid' }
  if (!isRecord(payload))
    return { ready: false, reason: 'worker readiness payload is not an object' }
  if (!exactKeys(payload, READINESS_KEYS)) {
    return { ready: false, reason: 'worker readiness payload keys are malformed' }
  }
  if (payload.contract !== WORKER_RELEASE_READINESS_CONTRACT) {
    return { ready: false, reason: 'worker readiness contract is missing or unsupported' }
  }
  if (payload.expected_sha !== expectedSha) {
    return { ready: false, reason: 'worker readiness response is bound to a different SHA' }
  }
  if (
    JSON.stringify(payload.required_regions) !== JSON.stringify(REQUIRED_RELEASE_REGIONS) ||
    !isUniqueStringList(payload.failover_regions) ||
    !isUniqueStringList(payload.missing_regions) ||
    payload.missing_regions.some((region) => !REQUIRED_RELEASE_REGIONS.includes(region)) ||
    !isUniqueStringList(payload.invalid_nodes)
  ) {
    return { ready: false, reason: 'worker readiness region or node evidence is malformed' }
  }

  const nodes = new Set()
  if (
    !validateWorkerList(payload.healthy_workers, { stale: false, nodes }) ||
    !validateWorkerList(payload.stale_workers, { stale: true, nodes })
  ) {
    return { ready: false, reason: 'worker readiness fleet evidence is malformed' }
  }

  const computedMissing = REQUIRED_RELEASE_REGIONS.filter(
    (region) =>
      !payload.healthy_workers.some(
        (worker) => worker.sha === expectedSha && worker.regions.includes(region)
      )
  )
  const exactOwners = REQUIRED_RELEASE_REGIONS.map((region) =>
    payload.healthy_workers.filter(
      (worker) => worker.sha === expectedSha && worker.regions.includes(region)
    )
  )
  const topologyIsExact =
    exactOwners.every((owners) => owners.length === 1) &&
    new Set(exactOwners.flat().map((worker) => worker.node)).size ===
      REQUIRED_RELEASE_REGIONS.length
  const hasMismatchedWorker = payload.healthy_workers.some(
    (worker) =>
      worker.regions.some((region) => REQUIRED_RELEASE_REGIONS.includes(region)) &&
      worker.sha !== expectedSha
  )
  const hasDisabledCapture = payload.healthy_workers.some((worker) => !worker.attempt_bound_capture)
  const computedReady =
    computedMissing.length === 0 &&
    payload.failover_regions.length === 0 &&
    payload.invalid_nodes.length === 0 &&
    payload.stale_workers.length === 0 &&
    !hasMismatchedWorker &&
    !hasDisabledCapture &&
    topologyIsExact
  if (
    JSON.stringify(payload.missing_regions) !== JSON.stringify(computedMissing) ||
    payload.ready !== computedReady
  ) {
    return { ready: false, reason: 'worker readiness flag is inconsistent with fleet evidence' }
  }
  if (!computedReady) {
    return {
      ready: false,
      reason:
        'required ingest workers have failover flags, stale owners, duplicates, invalid state, disabled v3, or another SHA',
    }
  }
  return {
    ready: true,
    reason: 'two region owners are fresh, v3-enabled, and on the exact release SHA',
  }
}

export function verifyWorkerReleaseReadinessPayload({
  env = process.env,
  readFileImpl = (path) => readFileSync(path, 'utf8'),
} = {}) {
  const expectedSha = env.HEAD_SHA?.trim() ?? ''
  const payloadFile = env.WORKER_READINESS_PAYLOAD_FILE?.trim() ?? ''
  if (!COMMIT_SHA.test(expectedSha)) throw new Error('expected worker SHA is invalid')
  if (!payloadFile) throw new Error('worker readiness payload file is unavailable')

  let rawPayload
  try {
    rawPayload = readFileImpl(payloadFile)
  } catch {
    throw new Error('worker readiness payload cannot be read')
  }
  if (typeof rawPayload !== 'string' || Buffer.byteLength(rawPayload) > MAX_PAYLOAD_BYTES) {
    throw new Error('worker readiness payload size is invalid')
  }

  let payload
  try {
    payload = JSON.parse(rawPayload)
  } catch {
    throw new Error('worker readiness payload is not valid JSON')
  }
  const result = validateWorkerReleaseReadiness(payload, expectedSha)
  if (!result.ready) throw new Error(result.reason)
  return result
}

try {
  if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    const result = verifyWorkerReleaseReadinessPayload()
    console.log(result.reason)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'worker readiness verification failed')
  process.exitCode = 1
}
