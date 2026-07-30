import { getSharedRedis } from './redis-client'
import { getMemoryCache } from './memory-fallback'

type SharedRedis = NonNullable<Awaited<ReturnType<typeof getSharedRedis>>>

export interface SharedCacheWriteFence {
  key: string
  token: string
}

export interface SharedCacheWriteLock {
  key: string
  ownerToken: string
}

const FENCED_SET_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if ARGV[1] ~= '' and (not current or current ~= ARGV[1]) then
  return 0
end

if ARGV[5] ~= '' and redis.call('GET', KEYS[3]) ~= ARGV[5] then
  return 0
end

-- Lua command errors do not roll back earlier writes. Validate every tag type
-- before SET so a corrupt tag cannot leave an unindexed orphan cache entry.
for index = 4, #KEYS do
  local tag_type = redis.call('TYPE', KEYS[index]).ok
  if tag_type ~= 'none' and tag_type ~= 'set' then
    return -3
  end
end

redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
for index = 4, #KEYS do
  redis.call('SADD', KEYS[index], KEYS[2])
  local current_ttl = redis.call('TTL', KEYS[index])
  if current_ttl < tonumber(ARGV[4]) then
    redis.call('EXPIRE', KEYS[index], ARGV[4])
  end
end
return 1
`

const ADVANCE_FENCE_AND_DELETE_TAG_SCRIPT = `
for index = 3, #KEYS do
  if redis.call('GET', KEYS[index]) ~= ARGV[1] then
    return {-1, {}}
  end
end

local members = redis.call('SMEMBERS', KEYS[2])
-- GET is intentionally before every write so a corrupt WRONGTYPE fence fails
-- without partially deleting the old publication surface.
redis.call('GET', KEYS[1])

-- Every operation that can fail on key type/format has completed. SET and DEL
-- cannot leave a half-rotated generation, and no client command can interleave.
redis.call('SET', KEYS[1], ARGV[2])
for _, cache_key in ipairs(members) do
  redis.call('DEL', cache_key)
end
redis.call('DEL', KEYS[2])
return {1, members}
`

const COMPARE_AND_DELETE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`

function validKey(key: string): boolean {
  return key.length > 0 && key === key.trim()
}

/**
 * Capture the shared publication generation before a cache-backed read starts.
 * A missing Redis connection returns null so ordinary requests can still read
 * the database, but callers must treat that value as "do not write a cache".
 */
export async function readSharedCacheWriteFence(
  key: string
): Promise<SharedCacheWriteFence | null> {
  if (!validKey(key)) throw new Error('Shared cache write fence key is invalid')

  const redis = await getSharedRedis()
  if (!redis) return null

  try {
    // Bootstrap exactly once. Concurrent readers either create generation 1 or
    // observe the value created by the winner.
    await redis.set(key, createSharedCacheLockToken(), { nx: true })
    const current = await redis.get<string>(key)
    if (typeof current !== 'string') return null
    const token = current
    return token.length > 0 ? { key, token } : null
  } catch {
    return null
  }
}

/**
 * Atomically rotate the publication generation and remove the complete tagged
 * Redis surface. No old/new writer can interleave between SMEMBERS and DEL.
 */
export async function advanceSharedCacheWriteFenceAndDeleteTag(
  key: string,
  tag: string,
  lease: { keys: readonly string[]; ownerToken: string }
): Promise<{ fence: SharedCacheWriteFence; deletedKeys: string[] }> {
  if (!validKey(key) || !validKey(tag)) {
    throw new Error('Shared cache write fence invalidation input is invalid')
  }

  const redis = await getSharedRedis()
  if (!redis) throw new Error(`Required Redis cache write fence unavailable for ${key}`)

  const leaseKeys = [...new Set(lease.keys)]
  if (
    !validKey(lease.ownerToken) ||
    leaseKeys.length === 0 ||
    leaseKeys.some((leaseKey) => !validKey(leaseKey))
  ) {
    throw new Error('Shared cache write fence lease guard is invalid')
  }

  const nextToken = createSharedCacheLockToken()
  const result = await redis.eval<string[], [number, string[]]>(
    ADVANCE_FENCE_AND_DELETE_TAG_SCRIPT,
    [key, `tag:${tag}`, ...leaseKeys],
    [lease.ownerToken, nextToken]
  )
  if (Array.isArray(result) && result[0] === -1) {
    throw new Error('Shared cache write fence lease ownership was lost')
  }
  if (
    !Array.isArray(result) ||
    result.length !== 2 ||
    result[0] !== 1 ||
    !Array.isArray(result[1]) ||
    result[1].some((cacheKey) => typeof cacheKey !== 'string')
  ) {
    throw new Error(`Shared cache write fence returned an invalid invalidation for ${key}`)
  }

  const deletedKeys = result[1]
  const memoryCache = getMemoryCache()
  for (const cacheKey of deletedKeys) memoryCache.delete(cacheKey)
  return { fence: { key, token: nextToken }, deletedKeys }
}

/**
 * Atomically verify a captured generation, write its cache envelope, and index
 * every tag. A request that began before publication advanced the fence gets 0
 * and can never overwrite the newly warmed generation after invalidation.
 */
export async function setSharedCacheEntryIfFenceMatches(
  redis: SharedRedis,
  cacheKey: string,
  serializedEntry: string,
  ttlSeconds: number,
  tags: readonly string[],
  fence?: SharedCacheWriteFence,
  lock?: SharedCacheWriteLock
): Promise<boolean> {
  if (!fence && !lock) throw new Error('A shared cache write guard is required')
  const uniqueTags = [...new Set(tags.filter(validKey))]
  const result = await redis.eval<string[], number>(
    FENCED_SET_SCRIPT,
    [
      fence?.key ?? cacheKey,
      cacheKey,
      lock?.key ?? cacheKey,
      ...uniqueTags.map((tag) => `tag:${tag}`),
    ],
    [
      fence?.token ?? '',
      serializedEntry,
      String(ttlSeconds),
      String(ttlSeconds * 2),
      lock?.ownerToken ?? '',
    ]
  )
  return result === 1
}

/** A lock owner may only release the exact token it acquired. */
export async function compareAndDeleteSharedCacheLock(
  redis: SharedRedis,
  lockKey: string,
  ownerToken: string
): Promise<boolean> {
  const result = await redis.eval<string[], number>(
    COMPARE_AND_DELETE_SCRIPT,
    [lockKey],
    [ownerToken]
  )
  return result === 1
}

export function createSharedCacheLockToken(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}
