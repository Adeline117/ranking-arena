import type { HlFill } from './fills'

/** Official userFillsByTime response and retained-history limits. */
export const HYPERLIQUID_FILLS_PAGE_LIMIT = 2_000
export const HYPERLIQUID_FILLS_ACCESSIBLE_LIMIT = 10_000

export interface HyperliquidFillsMeta {
  requestedStartTimeMs: number
  requestedEndTimeMs: number
  coveredStartTimeMs: number | null
  coveredEndTimeMs: number | null
  pageCount: number
  fillCount: number
  exhausted: boolean
  limitHit: boolean
  stalled: boolean
  /** Complete for the full requested window, not necessarily every shorter TF. */
  complete: boolean
}

export interface HyperliquidFillsFetch {
  fills: HlFill[]
  meta: HyperliquidFillsMeta
}

export type HyperliquidFillsPageFetcher = (
  startTimeMs: number,
  endTimeMs: number
) => Promise<unknown>

export interface HyperliquidFillsFetchOptions {
  maxPages?: number
  /** Called after a full advancing page and before the next API request. */
  beforeNextPage?: (pageLength: number) => Promise<void>
}

function fillTime(fill: HlFill): number {
  const time = Number(fill.time)
  if (!Number.isSafeInteger(time)) {
    throw new Error(`[hyperliquid] userFillsByTime returned an invalid fill time`)
  }
  return time
}

function fillKey(fill: HlFill, time: number): string {
  const tid = fill.tid
  if (
    !(
      (typeof tid === 'number' && Number.isSafeInteger(tid)) ||
      (typeof tid === 'string' && tid.trim() !== '')
    )
  ) {
    throw new Error('[hyperliquid] userFillsByTime fill is missing a valid tid')
  }
  return `${time}|${String(tid)}`
}

function canonicalValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalValue(child)}`)
      .join(',')}}`
  }
  if (value === undefined) return 'undefined'
  return JSON.stringify(value)
}

/**
 * Fetch one frozen time window using Hyperliquid's documented inclusive
 * startTime cursor. Boundary fills repeat on the next page, so `tid` is
 * de-duplicated. A full non-advancing page is partial, never skipped with +1ms.
 */
export async function fetchHyperliquidFillsWindow(
  fetchPage: HyperliquidFillsPageFetcher,
  requestedStartTimeMs: number,
  requestedEndTimeMs: number,
  options: HyperliquidFillsFetchOptions = {}
): Promise<HyperliquidFillsFetch> {
  const maxPages = options.maxPages ?? 20
  if (
    !Number.isSafeInteger(requestedStartTimeMs) ||
    !Number.isSafeInteger(requestedEndTimeMs) ||
    requestedStartTimeMs > requestedEndTimeMs ||
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1
  ) {
    throw new Error('[hyperliquid] invalid fills window')
  }

  const byKey = new Map<string, HlFill>()
  let cursor = requestedStartTimeMs
  let pageCount = 0
  let exhausted = false
  let stalled = false

  while (pageCount < maxPages) {
    const raw = await fetchPage(cursor, requestedEndTimeMs)
    if (!Array.isArray(raw)) {
      throw new Error('[hyperliquid] unexpected userFillsByTime response')
    }
    if (raw.length > HYPERLIQUID_FILLS_PAGE_LIMIT) {
      throw new Error(`[hyperliquid] userFillsByTime page exceeded ${HYPERLIQUID_FILLS_PAGE_LIMIT}`)
    }
    pageCount += 1
    if (raw.length === 0) {
      exhausted = true
      break
    }

    const page = raw as HlFill[]
    let previousTime = -Infinity
    let pageMaxTime = -Infinity
    let newFillCount = 0
    for (const candidate of page) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new Error('[hyperliquid] userFillsByTime returned an invalid fill')
      }
      const fill = candidate as HlFill
      const time = fillTime(fill)
      if (time < cursor || time > requestedEndTimeMs || time < previousTime) {
        throw new Error('[hyperliquid] userFillsByTime page is out of range or order')
      }
      previousTime = time
      pageMaxTime = time
      const key = fillKey(fill, time)
      const existing = byKey.get(key)
      if (existing) {
        if (canonicalValue(existing) !== canonicalValue(fill)) {
          throw new Error('[hyperliquid] userFillsByTime duplicate tid payload changed')
        }
      } else {
        byKey.set(key, fill)
        newFillCount += 1
      }
    }

    if (page.length < HYPERLIQUID_FILLS_PAGE_LIMIT) {
      exhausted = true
      break
    }
    if (pageMaxTime <= cursor || newFillCount === 0) {
      stalled = true
      break
    }
    // Inclusive by contract. The next page repeats the boundary timestamp;
    // de-duplication preserves every fill without assuming +1ms is safe.
    cursor = pageMaxTime
    if (pageCount < maxPages) {
      await options.beforeNextPage?.(page.length)
    }
  }

  if (!exhausted && !stalled && pageCount >= maxPages) stalled = true

  // Map insertion order preserves the upstream order for same-millisecond
  // fills. Re-sorting tids lexicographically would turn tid 2/10 around and
  // corrupt startPosition-based round-trip reconstruction.
  const fills = [...byKey.values()]
  const coveredStartTimeMs = fills.length > 0 ? fillTime(fills[0]) : null
  const coveredEndTimeMs = fills.length > 0 ? fillTime(fills[fills.length - 1]) : null
  const limitHit = fills.length >= HYPERLIQUID_FILLS_ACCESSIBLE_LIMIT

  return {
    fills,
    meta: {
      requestedStartTimeMs,
      requestedEndTimeMs,
      coveredStartTimeMs,
      coveredEndTimeMs,
      pageCount,
      fillCount: fills.length,
      exhausted,
      limitHit,
      stalled,
      complete: exhausted && !stalled && !limitHit,
    },
  }
}
