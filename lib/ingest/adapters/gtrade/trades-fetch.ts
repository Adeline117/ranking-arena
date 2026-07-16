export const GTRADE_TRADES_PAGE_LIMIT = 1_000
export const GTRADE_TRADES_HORIZON_DAYS = 90

export type GtradeTradesStopReason = 'exhausted' | 'page_cap' | 'request_failed' | 'invalid_page'

export interface GtradeTradesRawPage {
  pageIndex: number
  requestCursor: number | null
  /** Inclusive lower bound shared by every page in this snapshot. */
  requestStartTimeMs: number
  /** Frozen upper bound shared by every page in this snapshot. */
  requestEndTimeMs: number
  url: string
  response: unknown
}

export interface GtradeTradesMeta {
  asOfTimeMs: number
  horizonStartTimeMs: number
  requestCount: number
  pageCount: number
  rawRowCount: number
  uniqueRowCount: number
  newestTimeMs: number | null
  oldestTimeMs: number | null
  exhausted: boolean
  horizonCovered: boolean
  capHit: boolean
  complete: boolean
  stopReason: GtradeTradesStopReason
}

export interface GtradeTradesSnapshot {
  schemaVersion: 3
  rawPages: GtradeTradesRawPage[]
  trades: Array<Record<string, unknown>>
  meta: GtradeTradesMeta
}

export interface GtradeTradesFetchOptions {
  maxPages: number
  pageLimit?: number
}

export type GtradeTradesReplayStopReason =
  | 'exhausted'
  | 'open_prefix'
  | 'invalid_snapshot'
  | 'invalid_page'

export interface GtradeTradesReplay {
  asOfTimeMs: number | null
  startTimeMs: number | null
  trades: Array<Record<string, unknown>>
  validPageCount: number
  rawPageCount: number
  duplicateRowCount: number
  newestTimeMs: number | null
  oldestTimeMs: number | null
  exhausted: boolean
  stopReason: GtradeTradesReplayStopReason
  error: string | null
}

export type GtradeTradesPageFetcher = (
  cursor: number | null,
  limit: number
) => Promise<{ payload: unknown; url: string }>

export class GtradeTradesFetchError extends Error {
  readonly reason: Extract<GtradeTradesStopReason, 'request_failed' | 'invalid_page'>
  readonly partial: GtradeTradesSnapshot

  constructor(
    reason: Extract<GtradeTradesStopReason, 'request_failed' | 'invalid_page'>,
    message: string,
    partial: GtradeTradesSnapshot
  ) {
    super(message)
    this.name = 'GtradeTradesFetchError'
    this.reason = reason
    this.partial = partial
  }
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

function tradeId(row: Record<string, unknown>): number {
  const id = row.id
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error('[gtrade] trade row is missing a valid numeric id')
  }
  return id
}

function tradeTime(row: Record<string, unknown>, asOfTimeMs: number): number {
  const time = typeof row.date === 'string' ? Date.parse(row.date) : Number.NaN
  if (!Number.isFinite(time) || time > asOfTimeMs) {
    throw new Error('[gtrade] trade row has an invalid or future date')
  }
  return time
}

/** Fetch a frozen newest→oldest event window with replayable page evidence. */
export async function fetchGtradeTradesWindow(
  fetchPage: GtradeTradesPageFetcher,
  asOfTimeMs: number,
  options: GtradeTradesFetchOptions
): Promise<GtradeTradesSnapshot> {
  const pageLimit = options.pageLimit ?? GTRADE_TRADES_PAGE_LIMIT
  if (
    !Number.isSafeInteger(asOfTimeMs) ||
    !Number.isSafeInteger(options.maxPages) ||
    options.maxPages < 1 ||
    !Number.isSafeInteger(pageLimit) ||
    pageLimit < 1 ||
    pageLimit > GTRADE_TRADES_PAGE_LIMIT
  ) {
    throw new Error('[gtrade] invalid trades fetch options')
  }

  const horizonStartTimeMs = asOfTimeMs - GTRADE_TRADES_HORIZON_DAYS * 86_400_000
  const rawPages: GtradeTradesRawPage[] = []
  const byId = new Map<number, Record<string, unknown>>()
  let requestCount = 0
  let rawRowCount = 0
  let cursor: number | null = null
  let newestTimeMs: number | null = null
  let oldestTimeMs: number | null = null
  let exhausted = false
  let horizonCovered = false
  let capHit = false

  const result = (stopReason: GtradeTradesStopReason): GtradeTradesSnapshot => ({
    schemaVersion: 3,
    rawPages: [...rawPages],
    trades: [...byId.values()],
    meta: {
      asOfTimeMs,
      horizonStartTimeMs,
      requestCount,
      pageCount: rawPages.length,
      rawRowCount,
      uniqueRowCount: byId.size,
      newestTimeMs,
      oldestTimeMs,
      exhausted,
      horizonCovered,
      capHit,
      complete: (exhausted || horizonCovered) && !capHit,
      stopReason,
    },
  })

  const invalidPage = (message: string): GtradeTradesFetchError =>
    new GtradeTradesFetchError('invalid_page', message, result('invalid_page'))

  while (rawPages.length < options.maxPages) {
    requestCount += 1
    let payload: unknown
    let url: string
    try {
      const fetched = await fetchPage(cursor, pageLimit)
      payload = fetched.payload
      url = fetched.url
    } catch {
      throw new GtradeTradesFetchError(
        'request_failed',
        '[gtrade] trades page request failed',
        result('request_failed')
      )
    }

    rawPages.push({
      pageIndex: rawPages.length + 1,
      requestCursor: cursor,
      requestStartTimeMs: horizonStartTimeMs,
      requestEndTimeMs: asOfTimeMs,
      url,
      response: payload,
    })
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw invalidPage('[gtrade] unexpected trades page response')
    }
    const response = payload as {
      data?: unknown
      pagination?: { hasMore?: unknown; nextCursor?: unknown }
    }
    if (!Array.isArray(response.data) || response.data.length > pageLimit) {
      throw invalidPage('[gtrade] trades page data is missing or exceeds the requested limit')
    }
    if (typeof response.pagination?.hasMore !== 'boolean') {
      throw invalidPage('[gtrade] trades page is missing a boolean hasMore')
    }

    const rows = response.data
    rawRowCount += rows.length
    if (rows.length === 0) {
      if (response.pagination.hasMore) {
        throw invalidPage('[gtrade] trades page is empty while hasMore is true')
      }
      exhausted = true
      horizonCovered = true
      return result('exhausted')
    }

    const validated = new Map<number, Record<string, unknown>>()
    let previousId = Number.POSITIVE_INFINITY
    let pageNewestTimeMs = Number.NEGATIVE_INFINITY
    let pageOldestTimeMs = Number.POSITIVE_INFINITY
    try {
      for (let index = 0; index < rows.length; index += 1) {
        const candidate = rows[index]
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
          throw new Error('[gtrade] trades page contains a non-object row')
        }
        const row = candidate as Record<string, unknown>
        const id = tradeId(row)
        const time = tradeTime(row, asOfTimeMs)
        if (id > previousId || (cursor !== null && id > cursor) || time < horizonStartTimeMs) {
          throw new Error('[gtrade] trades page is out of id order, cursor range, or date filter')
        }
        previousId = id
        pageNewestTimeMs = Math.max(pageNewestTimeMs, time)
        pageOldestTimeMs = Math.min(pageOldestTimeMs, time)

        const existing = validated.get(id) ?? byId.get(id)
        if (existing) {
          if (canonicalValue(existing) !== canonicalValue(row)) {
            throw new Error('[gtrade] duplicate trade id payload changed')
          }
        } else {
          validated.set(id, row)
        }
      }
    } catch (error) {
      throw invalidPage(error instanceof Error ? error.message : '[gtrade] trade validation failed')
    }

    const lastRow = rows[rows.length - 1] as Record<string, unknown>
    const lastId = tradeId(lastRow)
    for (const [id, row] of validated) byId.set(id, row)
    newestTimeMs =
      newestTimeMs === null ? pageNewestTimeMs : Math.max(newestTimeMs, pageNewestTimeMs)
    oldestTimeMs =
      oldestTimeMs === null ? pageOldestTimeMs : Math.min(oldestTimeMs, pageOldestTimeMs)

    if (!response.pagination.hasMore) {
      if (response.pagination.nextCursor !== null) {
        throw invalidPage('[gtrade] exhausted trades page has a non-null nextCursor')
      }
      exhausted = true
      horizonCovered = true
      return result('exhausted')
    }
    const nextCursor = response.pagination.nextCursor
    if (
      typeof nextCursor !== 'number' ||
      !Number.isSafeInteger(nextCursor) ||
      nextCursor !== lastId ||
      (cursor !== null && nextCursor >= cursor) ||
      validated.size === 0
    ) {
      throw invalidPage('[gtrade] trades page has an invalid or stalled nextCursor')
    }
    cursor = nextCursor
  }

  capHit = true
  return result('page_cap')
}

/**
 * Rebuild the longest valid continuous prefix from stored raw pages. Parsers
 * use this instead of trusting mutable summary metadata or flattened rows.
 */
export function replayGtradeTradesSnapshot(snapshot: unknown): GtradeTradesReplay {
  const invalidSnapshot = (error: string): GtradeTradesReplay => ({
    asOfTimeMs: null,
    startTimeMs: null,
    trades: [],
    validPageCount: 0,
    rawPageCount: 0,
    duplicateRowCount: 0,
    newestTimeMs: null,
    oldestTimeMs: null,
    exhausted: false,
    stopReason: 'invalid_snapshot',
    error,
  })

  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return invalidSnapshot('[gtrade] trades snapshot is missing')
  }
  const envelope = snapshot as { schemaVersion?: unknown; rawPages?: unknown; meta?: unknown }
  if (
    envelope.schemaVersion !== 3 ||
    !Array.isArray(envelope.rawPages) ||
    !envelope.meta ||
    typeof envelope.meta !== 'object' ||
    Array.isArray(envelope.meta)
  ) {
    return invalidSnapshot('[gtrade] trades snapshot envelope is invalid')
  }
  const asOfTimeMs = (envelope.meta as { asOfTimeMs?: unknown }).asOfTimeMs
  const startTimeMs = (envelope.meta as { horizonStartTimeMs?: unknown }).horizonStartTimeMs
  if (
    typeof asOfTimeMs !== 'number' ||
    !Number.isSafeInteger(asOfTimeMs) ||
    typeof startTimeMs !== 'number' ||
    !Number.isSafeInteger(startTimeMs) ||
    startTimeMs >= asOfTimeMs
  ) {
    return invalidSnapshot('[gtrade] trades snapshot as-of is invalid')
  }

  const rawPages = envelope.rawPages
  const byId = new Map<number, Record<string, unknown>>()
  let validPageCount = 0
  let duplicateRowCount = 0
  let newestTimeMs: number | null = null
  let oldestTimeMs: number | null = null
  let cursor: number | null = null

  const result = (
    stopReason: GtradeTradesReplayStopReason,
    error: string | null = null,
    exhausted = false
  ): GtradeTradesReplay => ({
    asOfTimeMs,
    startTimeMs,
    trades: [...byId.values()],
    validPageCount,
    rawPageCount: rawPages.length,
    duplicateRowCount,
    newestTimeMs,
    oldestTimeMs,
    exhausted,
    stopReason,
    error,
  })

  for (let pageOffset = 0; pageOffset < rawPages.length; pageOffset += 1) {
    const candidate = rawPages[pageOffset]
    try {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new Error('[gtrade] raw trades page is invalid')
      }
      const page = candidate as Partial<GtradeTradesRawPage>
      if (
        page.pageIndex !== pageOffset + 1 ||
        page.requestCursor !== cursor ||
        page.requestStartTimeMs !== startTimeMs ||
        page.requestEndTimeMs !== asOfTimeMs ||
        !page.response ||
        typeof page.response !== 'object' ||
        Array.isArray(page.response)
      ) {
        throw new Error('[gtrade] raw trades page request chain is invalid')
      }
      const response = page.response as {
        data?: unknown
        pagination?: { hasMore?: unknown; nextCursor?: unknown }
      }
      if (
        !Array.isArray(response.data) ||
        response.data.length > GTRADE_TRADES_PAGE_LIMIT ||
        typeof response.pagination?.hasMore !== 'boolean'
      ) {
        throw new Error('[gtrade] raw trades page response is invalid')
      }
      if (response.data.length === 0) {
        if (response.pagination.hasMore || response.pagination.nextCursor !== null) {
          throw new Error('[gtrade] empty raw trades page pagination is invalid')
        }
        if (pageOffset !== rawPages.length - 1) {
          throw new Error('[gtrade] raw trades pages continue after exhaustion')
        }
        validPageCount += 1
        return result('exhausted', null, true)
      }

      const validated = new Map<number, Record<string, unknown>>()
      let previousId = Number.POSITIVE_INFINITY
      let pageNewestTimeMs = Number.NEGATIVE_INFINITY
      let pageOldestTimeMs = Number.POSITIVE_INFINITY
      for (const rowCandidate of response.data) {
        if (!rowCandidate || typeof rowCandidate !== 'object' || Array.isArray(rowCandidate)) {
          throw new Error('[gtrade] raw trades page contains a non-object row')
        }
        const row = rowCandidate as Record<string, unknown>
        const id = tradeId(row)
        const time = tradeTime(row, asOfTimeMs)
        if (id > previousId || (cursor !== null && id > cursor) || time < startTimeMs) {
          throw new Error('[gtrade] raw trades page id, cursor, or date filter is invalid')
        }
        previousId = id
        pageNewestTimeMs = Math.max(pageNewestTimeMs, time)
        pageOldestTimeMs = Math.min(pageOldestTimeMs, time)

        const existing = validated.get(id) ?? byId.get(id)
        if (existing) {
          if (canonicalValue(existing) !== canonicalValue(row)) {
            throw new Error('[gtrade] raw duplicate trade id payload changed')
          }
          duplicateRowCount += 1
        } else {
          validated.set(id, row)
        }
      }

      const lastRow = response.data[response.data.length - 1] as Record<string, unknown>
      const lastId = tradeId(lastRow)

      if (!response.pagination.hasMore) {
        if (response.pagination.nextCursor !== null || pageOffset !== rawPages.length - 1) {
          throw new Error('[gtrade] exhausted raw trades page pagination is invalid')
        }
      } else {
        const nextCursor = response.pagination.nextCursor
        if (
          typeof nextCursor !== 'number' ||
          !Number.isSafeInteger(nextCursor) ||
          nextCursor <= 0 ||
          nextCursor !== lastId ||
          (cursor !== null && nextCursor >= cursor) ||
          validated.size === 0
        ) {
          throw new Error('[gtrade] raw trades page nextCursor is invalid or stalled')
        }
      }

      for (const [id, row] of validated) byId.set(id, row)
      newestTimeMs =
        newestTimeMs === null ? pageNewestTimeMs : Math.max(newestTimeMs, pageNewestTimeMs)
      oldestTimeMs =
        oldestTimeMs === null ? pageOldestTimeMs : Math.min(oldestTimeMs, pageOldestTimeMs)
      validPageCount += 1

      if (!response.pagination.hasMore) return result('exhausted', null, true)
      cursor = response.pagination.nextCursor as number
    } catch (error) {
      return result(
        'invalid_page',
        error instanceof Error ? error.message : '[gtrade] raw trades page validation failed'
      )
    }
  }

  return result('open_prefix')
}
