/**
 * Per-trader API response cache with in-flight dedup and bounded FIFO eviction.
 *
 * Use when an enrichment fetcher calls the same API endpoint multiple times per
 * trader (once for equityCurve, once for statsDetail, etc.) and you want to
 * collapse those to a single API call per cycle. Many DEX APIs (Hyperliquid,
 * Jupiter, Copin, Drift) rate-limit aggressively and the 3x fan-out per trader
 * × concurrency=10 was the dominant cause of enrichment failures.
 *
 * Behavior:
 * - `getOrFetch(key, fetcher)` returns cached value if within TTL, otherwise
 *   awaits any in-flight promise for the same key, otherwise invokes `fetcher`
 *   and caches + dedupes the result.
 * - `clear()` nukes the entire cache (for tests).
 * - Bounded at `maxEntries` with FIFO eviction on write.
 *
 * The caller chooses the cache key (normalized trader id / wallet address /
 * `${address}:${days}` etc.). Keep keys canonical across call sites.
 */
import { logger } from '@/lib/logger'

export interface TraderResponseCacheOptions {
  /** Short identifier used for debug logging (e.g. "hyperliquid-fills"). */
  name: string
  /** Cached value TTL in milliseconds. Defaults to 2 minutes. */
  ttlMs?: number
  /** Max simultaneous entries before FIFO eviction kicks in. Defaults to 2000. */
  maxEntries?: number
}

export interface TraderResponseCache<T> {
  /**
   * Return cached value for `key` if still within TTL, otherwise fetch it via
   * `fetcher`. Concurrent callers for the same key share a single in-flight
   * promise so the fetcher runs at most once per key per cycle.
   */
  getOrFetch: (key: string, fetcher: () => Promise<T>) => Promise<T>
  /** Peek at the cached value for `key` without triggering a fetch. */
  get: (key: string) => T | undefined
  /** Drop all cached entries (intended for tests). */
  clear: () => void
  /** Current entry count (observability). */
  size: () => number
}

interface CacheEntry<T> {
  value: T
  cachedAt: number
}

const DEFAULT_TTL_MS = 2 * 60 * 1000
const DEFAULT_MAX_ENTRIES = 2000

export function createTraderResponseCache<T>(
  options: TraderResponseCacheOptions
): TraderResponseCache<T> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const name = options.name

  const store = new Map<string, CacheEntry<T>>()
  const inflight = new Map<string, Promise<T>>()

  function get(key: string): T | undefined {
    const entry = store.get(key)
    if (!entry) return undefined
    if (Date.now() - entry.cachedAt >= ttlMs) {
      store.delete(key)
      return undefined
    }
    return entry.value
  }

  async function getOrFetch(key: string, fetcher: () => Promise<T>): Promise<T> {
    const cached = get(key)
    if (cached !== undefined) return cached

    const existing = inflight.get(key)
    if (existing) return existing

    const promise = (async () => {
      try {
        const value = await fetcher()
        store.set(key, { value, cachedAt: Date.now() })
        // Bounded FIFO eviction — Map preserves insertion order so the first
        // key is the oldest. Drop a single entry on overflow to keep writes O(1).
        if (store.size > maxEntries) {
          const firstKey = store.keys().next().value
          if (firstKey !== undefined) store.delete(firstKey)
        }
        return value
      } catch (err) {
        // Don't cache failures — let the next caller retry. But log so repeat
        // failures aren't silent.
        logger.warn(
          `[trader-response-cache:${name}] fetch failed for ${key}: ${err instanceof Error ? err.message : String(err)}`
        )
        throw err
      } finally {
        inflight.delete(key)
      }
    })()

    inflight.set(key, promise)
    return promise
  }

  function clear(): void {
    store.clear()
    inflight.clear()
  }

  function size(): number {
    return store.size
  }

  return { getOrFetch, get, clear, size }
}
