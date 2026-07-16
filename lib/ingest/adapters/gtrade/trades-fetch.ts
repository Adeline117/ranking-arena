export const GTRADE_TRADES_PAGE_LIMIT = 1_000
export const GTRADE_TRADES_HORIZON_DAYS = 90

export type GtradeTradesStopReason =
  | 'horizon_covered'
  | 'exhausted'
  | 'page_cap'
  | 'request_failed'
  | 'invalid_page'

export interface GtradeTradesRawPage {
  pageIndex: number
  requestCursor: number | null
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
  schemaVersion: 2
  rawPages: GtradeTradesRawPage[]
  trades: Array<Record<string, unknown>>
  meta: GtradeTradesMeta
}

export interface GtradeTradesFetchOptions {
  maxPages: number
  pageLimit?: number
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
  if (typeof id !== 'number' || !Number.isSafeInteger(id)) {
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
    schemaVersion: 2,
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
      return result('exhausted')
    }

    const validated = new Map<number, Record<string, unknown>>()
    let previousId = Number.POSITIVE_INFINITY
    let previousTime = Number.POSITIVE_INFINITY
    try {
      for (let index = 0; index < rows.length; index += 1) {
        const candidate = rows[index]
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
          throw new Error('[gtrade] trades page contains a non-object row')
        }
        const row = candidate as Record<string, unknown>
        const id = tradeId(row)
        const time = tradeTime(row, asOfTimeMs)
        if (
          id > previousId ||
          time > previousTime ||
          (cursor !== null && id > cursor) ||
          (id === previousId && index > 0)
        ) {
          throw new Error('[gtrade] trades page is out of id/date order or cursor range')
        }
        previousId = id
        previousTime = time

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

    const firstTime = tradeTime(rows[0] as Record<string, unknown>, asOfTimeMs)
    const lastRow = rows[rows.length - 1] as Record<string, unknown>
    const lastId = tradeId(lastRow)
    const lastTime = tradeTime(lastRow, asOfTimeMs)
    for (const [id, row] of validated) byId.set(id, row)
    newestTimeMs = newestTimeMs === null ? firstTime : Math.max(newestTimeMs, firstTime)
    oldestTimeMs = oldestTimeMs === null ? lastTime : Math.min(oldestTimeMs, lastTime)

    if (!response.pagination.hasMore) {
      if (response.pagination.nextCursor !== null) {
        throw invalidPage('[gtrade] exhausted trades page has a non-null nextCursor')
      }
      exhausted = true
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
    // Dates have second-level precision while the id cursor orders events
    // within a second. Equality does not prove that every lower-id boundary
    // event was fetched, so coverage requires one event strictly before it.
    if (oldestTimeMs < horizonStartTimeMs) {
      horizonCovered = true
      return result('horizon_covered')
    }
    cursor = nextCursor
  }

  capHit = true
  return result('page_cap')
}
