import { tieredGet, tieredSet } from '@/lib/cache/redis-layer'

/**
 * Increment API call count for a user.
 * Called internally by API routes that count towards the daily limit.
 */
export async function incrementApiCalls(userId: string): Promise<number> {
  const today = new Date().toISOString().slice(0, 10)
  const key = `api_calls:${userId}:${today}`

  const { data: current } = await tieredGet<number>(key, 'hot')
  const newCount = (current ?? 0) + 1

  // Cache in hot tier (short TTL, frequently accessed)
  await tieredSet(key, newCount, 'hot')

  return newCount
}
