import { logger } from '@/lib/logger'
/**
 * Request Deduplication
 *
 * Prevents cache stampede by coalescing concurrent requests for the same key.
 * When multiple requests come in for the same key simultaneously:
 * - Only the first request actually fetches the data
 * - Subsequent requests wait for and share the same result
 *
 * Features:
 * - Request coalescing (deduplication)
 * - Automatic cleanup after completion
 * - Timeout protection
 * - Error propagation to all waiters
 * - Statistics tracking
 */

// ============================================
// Types
// ============================================

interface PendingRequest<T> {
  promise: Promise<T>
  startTime: number
  waiterCount: number
}

interface DedupStats {
  totalRequests: number
  deduplicatedRequests: number
  savedRequests: number
  averageWaiters: number
  errors: number
}

interface DedupOptions {
  /** Request timeout in ms (default: 30000) */
  timeout?: number
  /** Key for the request */
  key: string
}

// ============================================
// Configuration
// ============================================

const CONFIG = {
  DEFAULT_TIMEOUT_MS: 30000,    // 30 seconds
  CLEANUP_DELAY_MS: 100,        // Delay before removing from pending map
  MAX_PENDING_REQUESTS: 1000,   // Maximum concurrent pending requests
}

// ============================================
// Request Deduplicator Class
// ============================================

class RequestDeduplicator {
  private pending: Map<string, PendingRequest<unknown>> = new Map()

  // Statistics
  private stats: DedupStats = {
    totalRequests: 0,
    deduplicatedRequests: 0,
    savedRequests: 0,
    averageWaiters: 0,
    errors: 0,
  }

  private totalWaiters = 0
  private completedRequests = 0

  /**
   * Execute a request with deduplication
   *
   * @param options - Dedup options including the key
   * @param fetcher - The function that performs the actual request
   * @returns Promise with the result
   *
   * @example
   * ```ts
   * const data = await requestDedup.execute(
   *   { key: `rankings:${window}:${platform}` },
   *   () => fetchRankingsFromDB(window, platform)
   * )
   * ```
   */
  async execute<T>(
    options: DedupOptions,
    fetcher: () => Promise<T>
  ): Promise<T> {
    const { key, timeout = CONFIG.DEFAULT_TIMEOUT_MS } = options

    this.stats.totalRequests++

    // Check if there's already a pending request for this key
    const existing = this.pending.get(key) as PendingRequest<T> | undefined

    if (existing) {
      // Request is already in flight - wait for it
      this.stats.deduplicatedRequests++
      this.stats.savedRequests++
      existing.waiterCount++

      return existing.promise
    }

    // Check if we're at capacity
    if (this.pending.size >= CONFIG.MAX_PENDING_REQUESTS) {
      // Clean up old requests
      this.cleanupStaleRequests()

      // If still at capacity, just execute without dedup
      if (this.pending.size >= CONFIG.MAX_PENDING_REQUESTS) {
        logger.warn('[RequestDedup] At capacity, executing without dedup')
        return await fetcher()
      }
    }

    // Create a new request
    const requestPromise = this.executeWithTimeout(fetcher, timeout, key)

    const pendingRequest: PendingRequest<T> = {
      promise: requestPromise,
      startTime: Date.now(),
      waiterCount: 1,
    }

    this.pending.set(key, pendingRequest as PendingRequest<unknown>)

    try {
      const result = await requestPromise

      // Update statistics
      this.totalWaiters += pendingRequest.waiterCount
      this.completedRequests++
      this.stats.averageWaiters = this.totalWaiters / this.completedRequests

      return result
    } catch (error) {
      this.stats.errors++
      throw error
    } finally {
      // Clean up after a short delay to handle race conditions
      setTimeout(() => {
        this.pending.delete(key)
      }, CONFIG.CLEANUP_DELAY_MS)
    }
  }

  /**
   * Execute fetcher with timeout protection
   */
  private async executeWithTimeout<T>(
    fetcher: () => Promise<T>,
    timeoutMs: number,
    key: string
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let timeoutId: NodeJS.Timeout | null = null
      let isResolved = false

      // Set up timeout
      timeoutId = setTimeout(() => {
        if (!isResolved) {
          isResolved = true
          reject(new Error(`Request timeout for key: ${key}`))
        }
      }, timeoutMs)

      // Execute the fetcher
      fetcher()
        .then((result) => {
          if (!isResolved) {
            isResolved = true
            if (timeoutId) clearTimeout(timeoutId)
            resolve(result)
          }
        })
        .catch((error) => {
          if (!isResolved) {
            isResolved = true
            if (timeoutId) clearTimeout(timeoutId)
            reject(error)
          }
        })
    })
  }

  /**
   * Clean up stale requests (requests that have been pending too long)
   */
  private cleanupStaleRequests(): void {
    const now = Date.now()
    const staleThreshold = CONFIG.DEFAULT_TIMEOUT_MS * 2 // Double the timeout

    for (const [key, request] of this.pending.entries()) {
      if (now - request.startTime > staleThreshold) {
        this.pending.delete(key)
      }
    }
  }

  /**
   * Get current statistics
   */
  getStats(): DedupStats & {
    pendingCount: number
    deduplicationRate: number
  } {
    const total = this.stats.totalRequests
    const deduped = this.stats.deduplicatedRequests

    return {
      ...this.stats,
      pendingCount: this.pending.size,
      deduplicationRate: total > 0 ? Math.round((deduped / total) * 100) : 0,
    }
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      totalRequests: 0,
      deduplicatedRequests: 0,
      savedRequests: 0,
      averageWaiters: 0,
      errors: 0,
    }
    this.totalWaiters = 0
    this.completedRequests = 0
  }

  /**
   * Check if a request is currently pending for a key
   */
  isPending(key: string): boolean {
    return this.pending.has(key)
  }

  /**
   * Get the number of waiters for a pending request
   */
  getWaiterCount(key: string): number {
    return this.pending.get(key)?.waiterCount || 0
  }

  /**
   * Clear all pending requests (use with caution)
   */
  clear(): void {
    this.pending.clear()
  }
}

// ============================================
// Singleton Instance
// ============================================

export const requestDedup = new RequestDeduplicator()

// ============================================
// Helper Functions
// ============================================

/**
 * Deduplicated fetch with automatic key generation
 *
 * @example
 * ```ts
 * const rankings = await deduplicatedFetch(
 *   'rankings',
 *   { window: '7d', platform: 'binance' },
 *   () => fetchRankings('7d', 'binance')
 * )
 * ```
 */
export async function deduplicatedFetch<T>(
  prefix: string,
  params: Record<string, string | number | undefined>,
  fetcher: () => Promise<T>,
  options?: { timeout?: number }
): Promise<T> {
  // Generate a stable key from params
  const paramParts = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(':')

  const key = `${prefix}:${paramParts}`

  return requestDedup.execute({ key, timeout: options?.timeout }, fetcher)
}

/**
 * Create a scoped deduplicator for a specific namespace
 *
 * @example
 * ```ts
 * const rankingsDedup = createScopedDedup('rankings')
 * const data = await rankingsDedup({ window: '7d' }, () => fetchRankings('7d'))
 * ```
 */
export function createScopedDedup(namespace: string) {
  return async function <T>(
    params: Record<string, string | number | undefined>,
    fetcher: () => Promise<T>,
    options?: { timeout?: number }
  ): Promise<T> {
    return deduplicatedFetch(namespace, params, fetcher, options)
  }
}

// ============================================
// Integration with Cache
// ============================================

/**
 * Get or set with deduplication
 * Combines cache lookup with deduplicated fetch
 *
 * @example
 * ```ts
 * const rankings = await getOrSetDedup(
 *   'rankings:7d:all',
 *   async () => {
 *     const data = await fetchRankings('7d')
 *     await cache.set('rankings:7d:all', data, { ttl: 300 })
 *     return data
 *   },
 *   () => cache.get('rankings:7d:all')
 * )
 * ```
 */
export async function getOrSetDedup<T>(
  key: string,
  fetcher: () => Promise<T>,
  getCached: () => Promise<T | null> | T | null,
  options?: { timeout?: number }
): Promise<T> {
  // First check cache (without dedup)
  const cached = await getCached()
  if (cached !== null) {
    return cached
  }

  // Cache miss - use dedup for the fetch
  return requestDedup.execute({ key, timeout: options?.timeout }, fetcher)
}

// Export class for testing
export { RequestDeduplicator }
export type { DedupStats, DedupOptions }
