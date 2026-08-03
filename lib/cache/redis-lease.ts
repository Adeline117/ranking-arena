import { randomUUID } from 'node:crypto'

type RedisLeaseClient = {
  set: (key: string, value: string, options: { nx: true; ex: number }) => Promise<unknown>
  eval: (script: string, keys: string[], args: string[]) => Promise<unknown>
}

const RELEASE_OWNED_LEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`

export type RedisLease = {
  key: string
  token: string
  release: () => Promise<boolean>
}

/**
 * Acquire a Redis lease whose release is fenced by a unique owner token.
 *
 * A bare DEL is unsafe: once a lease expires, a newer invocation can acquire
 * the same key before the older invocation finishes. The older invocation
 * must never be able to delete that newer owner's lease.
 */
export async function tryAcquireRedisLease(
  redis: RedisLeaseClient,
  key: string,
  ttlSeconds: number
): Promise<RedisLease | null> {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('Redis lease TTL must be a positive integer')
  }

  const token = randomUUID()
  const result = await redis.set(key, token, { nx: true, ex: ttlSeconds })
  if (result !== 'OK') return null

  return {
    key,
    token,
    release: async () => {
      const released = await redis.eval(RELEASE_OWNED_LEASE_SCRIPT, [key], [token])
      return released === 1 || released === '1'
    },
  }
}
