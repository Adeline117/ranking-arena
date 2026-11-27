/** @jest-environment node */

import {
  REDIS_CIRCUIT_COOLDOWN_MS,
  REDIS_CIRCUIT_PROBE_WINDOW_MS,
  recordRedisFailure,
  recordRedisSuccess,
  redisCircuitAllowsRequest,
  redisCircuitCoolingDown,
  resetRedisCircuitForTests,
} from '../redis-circuit'

describe('Redis circuit breaker', () => {
  const t0 = 1_000_000

  beforeEach(() => resetRedisCircuitForTests())

  it('opens on the first failure and refuses every request during the cooldown', () => {
    expect(redisCircuitAllowsRequest(t0)).toBe(true)
    expect(recordRedisFailure(t0)).toBe(true)

    expect(redisCircuitAllowsRequest(t0 + 1)).toBe(false)
    expect(redisCircuitAllowsRequest(t0 + REDIS_CIRCUIT_COOLDOWN_MS - 1)).toBe(false)
    expect(redisCircuitCoolingDown(t0 + REDIS_CIRCUIT_COOLDOWN_MS - 1)).toBe(true)
  })

  it('lets exactly one probe through after the cooldown', () => {
    recordRedisFailure(t0)
    const after = t0 + REDIS_CIRCUIT_COOLDOWN_MS

    expect(redisCircuitCoolingDown(after)).toBe(false)
    expect(redisCircuitAllowsRequest(after)).toBe(true)
    expect(redisCircuitAllowsRequest(after + 1)).toBe(false)
    expect(redisCircuitAllowsRequest(after + REDIS_CIRCUIT_PROBE_WINDOW_MS - 1)).toBe(false)
    // A probe that never reports back does not wedge the circuit open.
    expect(redisCircuitAllowsRequest(after + REDIS_CIRCUIT_PROBE_WINDOW_MS)).toBe(true)
  })

  it('restarts the cooldown when the probe fails and closes when it succeeds', () => {
    recordRedisFailure(t0)
    const probeAt = t0 + REDIS_CIRCUIT_COOLDOWN_MS
    expect(redisCircuitAllowsRequest(probeAt)).toBe(true)

    expect(recordRedisFailure(probeAt + 900)).toBe(false)
    expect(redisCircuitAllowsRequest(probeAt + 900 + REDIS_CIRCUIT_COOLDOWN_MS - 1)).toBe(false)

    const secondProbeAt = probeAt + 900 + REDIS_CIRCUIT_COOLDOWN_MS
    expect(redisCircuitAllowsRequest(secondProbeAt)).toBe(true)
    recordRedisSuccess()
    expect(redisCircuitAllowsRequest(secondProbeAt + 1)).toBe(true)
    expect(redisCircuitAllowsRequest(secondProbeAt + 2)).toBe(true)
  })
})
