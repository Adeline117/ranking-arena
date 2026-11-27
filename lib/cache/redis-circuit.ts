/**
 * Process-local circuit breaker for Upstash Redis.
 *
 * Incident 2026-11-27: Upstash was unavailable and every Redis call took about
 * one second to fail. One /api/traders request made five of them (proxy IP
 * floor, route rate limit, write-fence read, lock, write-fence re-read), none
 * of which fed the old "three consecutive errors" health counter, so every
 * request paid about five seconds for a cache that could not answer.
 *
 * One failure opens the circuit: callers skip Redis and take the path they
 * already have for "Redis unavailable". After the cooldown exactly one call
 * is let through as a probe; its outcome closes the circuit or restarts the
 * cooldown.
 *
 * Deliberately dependency-free: it is imported by proxy.ts as well as the
 * route bundles. State is per bundle instance.
 */

export const REDIS_CIRCUIT_COOLDOWN_MS = 60_000
/** How long one probe may stay unanswered before another call may probe. */
export const REDIS_CIRCUIT_PROBE_WINDOW_MS = 10_000

let tripped = false
let openUntil = 0
let probeUntil = 0

/**
 * Gate for one Redis round trip. Returns false while the circuit is open.
 * After the cooldown it returns true for a single caller (the probe) and
 * false for everyone else until that probe reports back or its window ends.
 */
export function redisCircuitAllowsRequest(now: number = Date.now()): boolean {
  if (!tripped) return true
  if (now < openUntil || now < probeUntil) return false
  probeUntil = now + REDIS_CIRCUIT_PROBE_WINDOW_MS
  return true
}

/** Pure check: true during the cooldown, when no probe is due yet. */
export function redisCircuitCoolingDown(now: number = Date.now()): boolean {
  return tripped && now < openUntil
}

/** Pure check: true from the first failure until a call succeeds again. */
export function redisCircuitTripped(): boolean {
  return tripped
}

/** Returns true when this failure opened a previously closed circuit. */
export function recordRedisFailure(now: number = Date.now()): boolean {
  const newlyOpened = !tripped
  tripped = true
  openUntil = now + REDIS_CIRCUIT_COOLDOWN_MS
  probeUntil = 0
  return newlyOpened
}

export function recordRedisSuccess(): void {
  tripped = false
  openUntil = 0
  probeUntil = 0
}

/** Thrown instead of a network call while the circuit is open. */
export class RedisCircuitOpenError extends Error {
  constructor() {
    super('Redis circuit is open; request was not sent')
    this.name = 'RedisCircuitOpenError'
  }
}

export function resetRedisCircuitForTests(): void {
  recordRedisSuccess()
}
