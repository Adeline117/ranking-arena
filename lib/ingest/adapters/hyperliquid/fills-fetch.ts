import type { HlFill } from './fills'

/** Official userFillsByTime response and retained-history limits. */
export const HYPERLIQUID_FILLS_PAGE_LIMIT = 2_000
export const HYPERLIQUID_FILLS_ACCESSIBLE_LIMIT = 10_000

export type HyperliquidFillsFailureReason =
  | 'request_failed'
  | 'invalid_page'
  | 'stalled'
  | 'page_limit'

export interface HyperliquidFillsMeta {
  requestedStartTimeMs: number
  requestedEndTimeMs: number
  coveredStartTimeMs: number | null
  coveredEndTimeMs: number | null
  requestCount: number
  pageCount: number
  fillCount: number
  exhausted: boolean
  limitHit: boolean
  stalled: boolean
  /** True when the successful pages reach the frozen end of the request. */
  completeThroughEnd: boolean
  failureReason: HyperliquidFillsFailureReason | null
  /** Complete for the full requested window, not necessarily every shorter TF. */
  complete: boolean
}

export interface HyperliquidFillsRawPage {
  requestStartTimeMs: number
  requestEndTimeMs: number
  /** Exact decoded API response, before validation or boundary de-duplication. */
  response: unknown
}

export interface HyperliquidFillsFetch {
  schemaVersion: 2
  rawPages: HyperliquidFillsRawPage[]
  fills: HlFill[]
  meta: HyperliquidFillsMeta
}

/** Carries every successful response even when a later page fails. */
export class HyperliquidFillsFetchError extends Error {
  readonly reason: Extract<HyperliquidFillsFailureReason, 'request_failed' | 'invalid_page'>
  readonly partial: HyperliquidFillsFetch

  constructor(
    reason: Extract<HyperliquidFillsFailureReason, 'request_failed' | 'invalid_page'>,
    message: string,
    partial: HyperliquidFillsFetch
  ) {
    super(message)
    this.name = 'HyperliquidFillsFetchError'
    this.reason = reason
    this.partial = partial
  }
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
  const rawPages: HyperliquidFillsRawPage[] = []
  let cursor = requestedStartTimeMs
  let requestCount = 0
  let exhausted = false
  let stalled = false
  let failureReason: HyperliquidFillsFailureReason | null = null

  const result = (reason: HyperliquidFillsFailureReason | null): HyperliquidFillsFetch => {
    // Map insertion order preserves the upstream order for same-millisecond
    // fills. Re-sorting tids lexicographically would turn tid 2/10 around and
    // corrupt startPosition-based round-trip reconstruction.
    const fills = [...byKey.values()]
    const coveredStartTimeMs = fills.length > 0 ? fillTime(fills[0]) : null
    const coveredEndTimeMs = fills.length > 0 ? fillTime(fills[fills.length - 1]) : null
    const limitHit = fills.length >= HYPERLIQUID_FILLS_ACCESSIBLE_LIMIT
    const completeThroughEnd = exhausted && !stalled && reason === null
    return {
      schemaVersion: 2,
      rawPages: [...rawPages],
      fills,
      meta: {
        requestedStartTimeMs,
        requestedEndTimeMs,
        coveredStartTimeMs,
        coveredEndTimeMs,
        requestCount,
        pageCount: rawPages.length,
        fillCount: fills.length,
        exhausted,
        limitHit,
        stalled,
        completeThroughEnd,
        failureReason: reason,
        complete: completeThroughEnd && !limitHit,
      },
    }
  }

  const invalidPage = (message: string): HyperliquidFillsFetchError =>
    new HyperliquidFillsFetchError('invalid_page', message, result('invalid_page'))

  while (rawPages.length < maxPages) {
    requestCount += 1
    let raw: unknown
    try {
      raw = await fetchPage(cursor, requestedEndTimeMs)
    } catch {
      throw new HyperliquidFillsFetchError(
        'request_failed',
        '[hyperliquid] userFillsByTime request failed',
        result('request_failed')
      )
    }
    rawPages.push({
      requestStartTimeMs: cursor,
      requestEndTimeMs: requestedEndTimeMs,
      response: raw,
    })
    if (!Array.isArray(raw)) {
      throw invalidPage('[hyperliquid] unexpected userFillsByTime response')
    }
    if (raw.length > HYPERLIQUID_FILLS_PAGE_LIMIT) {
      throw invalidPage(
        `[hyperliquid] userFillsByTime page exceeded ${HYPERLIQUID_FILLS_PAGE_LIMIT}`
      )
    }
    if (raw.length === 0) {
      exhausted = true
      break
    }

    const page = raw as HlFill[]
    const validated = new Map<string, HlFill>()
    let previousTime = -Infinity
    let pageMaxTime = -Infinity
    let newFillCount = 0
    try {
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
        const existing = validated.get(key) ?? byKey.get(key)
        if (existing) {
          if (canonicalValue(existing) !== canonicalValue(fill)) {
            throw new Error('[hyperliquid] userFillsByTime duplicate tid payload changed')
          }
        } else {
          validated.set(key, fill)
          newFillCount += 1
        }
      }
    } catch (error) {
      throw invalidPage(
        error instanceof Error
          ? error.message
          : '[hyperliquid] userFillsByTime page validation failed'
      )
    }
    for (const [key, fill] of validated) byKey.set(key, fill)

    if (page.length < HYPERLIQUID_FILLS_PAGE_LIMIT) {
      exhausted = true
      break
    }
    if (pageMaxTime <= cursor || newFillCount === 0) {
      stalled = true
      failureReason = 'stalled'
      break
    }
    // Inclusive by contract. The next page repeats the boundary timestamp;
    // de-duplication preserves every fill without assuming +1ms is safe.
    cursor = pageMaxTime
    if (rawPages.length < maxPages) {
      await options.beforeNextPage?.(page.length)
    }
  }

  if (!exhausted && !stalled && rawPages.length >= maxPages) {
    failureReason = 'page_limit'
  }
  return result(failureReason)
}
