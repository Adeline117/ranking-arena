import {
  fetchGtradeTradesWindow,
  GtradeTradesFetchError,
  replayGtradeTradesSnapshot,
  type GtradeTradesPageFetcher,
} from '../trades-fetch'

const DAY = 86_400_000
const AS_OF = Date.parse('2026-07-15T00:00:00.000Z')

function trade(id: number, daysAgo: number, extra: Record<string, unknown> = {}) {
  return { id, date: new Date(AS_OF - daysAgo * DAY).toISOString(), ...extra }
}

function page(
  data: Array<Record<string, unknown>>,
  hasMore: boolean,
  nextCursor: number | null | undefined = hasMore ? (data.at(-1)?.id as number | undefined) : null
) {
  return { data, pagination: { hasMore, nextCursor, limit: 3 } }
}

function fetcher(responses: unknown[]): GtradeTradesPageFetcher {
  let index = 0
  return async (cursor) => ({
    payload: responses[index++],
    url: `https://gtrade.test/history${cursor === null ? '' : `?cursor=${cursor}`}`,
  })
}

describe('fetchGtradeTradesWindow', () => {
  it('freezes a filtered range, advances cursors, and proves it only by exhaustion', async () => {
    const result = await fetchGtradeTradesWindow(
      fetcher([
        page([trade(10, 1), trade(9, 2), trade(8, 3)], true),
        page([trade(7, 30), trade(6, 90)], false),
      ]),
      AS_OF,
      { maxPages: 5, pageLimit: 3 }
    )

    expect(result.trades.map((row) => row.id)).toEqual([10, 9, 8, 7, 6])
    expect(result.rawPages.map((raw) => raw.requestCursor)).toEqual([null, 8])
    expect(result.rawPages.map((raw) => raw.requestStartTimeMs)).toEqual([
      AS_OF - 90 * DAY,
      AS_OF - 90 * DAY,
    ])
    expect(result.rawPages.map((raw) => raw.requestEndTimeMs)).toEqual([AS_OF, AS_OF])
    expect(result.rawPages[1].url).toContain('cursor=8')
    expect(result.meta).toMatchObject({
      requestCount: 2,
      pageCount: 2,
      rawRowCount: 5,
      uniqueRowCount: 5,
      exhausted: true,
      horizonCovered: true,
      capHit: false,
      complete: true,
      stopReason: 'exhausted',
    })
  })

  it('treats a confirmed empty first page as exhausted complete history', async () => {
    const result = await fetchGtradeTradesWindow(fetcher([page([], false)]), AS_OF, {
      maxPages: 5,
      pageLimit: 3,
    })
    expect(result.trades).toEqual([])
    expect(result.meta).toMatchObject({
      exhausted: true,
      horizonCovered: true,
      complete: true,
      stopReason: 'exhausted',
    })
  })

  it('marks a local page cap incomplete when neither exhaustion nor horizon is proven', async () => {
    const result = await fetchGtradeTradesWindow(
      fetcher([page([trade(10, 1), trade(9, 2), trade(8, 3)], true)]),
      AS_OF,
      { maxPages: 1, pageLimit: 3 }
    )
    expect(result.meta).toMatchObject({ capHit: true, complete: false, stopReason: 'page_cap' })
  })

  it('deduplicates an identical inclusive boundary row', async () => {
    const boundary = trade(8, 3, { action: 'TradeClosedMarket' })
    const result = await fetchGtradeTradesWindow(
      fetcher([
        page([trade(10, 1), trade(9, 2), boundary], true),
        page([boundary, trade(7, 4)], false),
      ]),
      AS_OF,
      { maxPages: 5, pageLimit: 3 }
    )
    expect(result.meta).toMatchObject({ rawRowCount: 5, uniqueRowCount: 4, exhausted: true })
    expect(result.trades.map((row) => row.id)).toEqual([10, 9, 8, 7])
  })

  it('rejects empty hasMore, malformed order, stalled cursor, and conflicting ids', async () => {
    const cases: unknown[] = [
      page([], true, 1),
      page([trade(9, 2), trade(10, 1)], false),
      page([trade(10, 1)], true, 11),
      page([trade(10, 1), trade(10, 1, { action: 'changed' })], false),
      page([trade(10, 1)], false, 10),
    ]
    for (const response of cases) {
      await expect(
        fetchGtradeTradesWindow(fetcher([response]), AS_OF, { maxPages: 1, pageLimit: 3 })
      ).rejects.toBeInstanceOf(GtradeTradesFetchError)
    }
  })

  it('accepts local event-time inversions while preserving id cursor order', async () => {
    const result = await fetchGtradeTradesWindow(
      fetcher([page([trade(10, 2), trade(9, 1)], false)]),
      AS_OF,
      { maxPages: 1, pageLimit: 3 }
    )
    expect(result.meta).toMatchObject({ exhausted: true, complete: true })
  })

  it('rejects a row outside the frozen startDate filter', async () => {
    await expect(
      fetchGtradeTradesWindow(fetcher([page([trade(10, 91)], false)]), AS_OF, {
        maxPages: 1,
        pageLimit: 3,
      })
    ).rejects.toBeInstanceOf(GtradeTradesFetchError)
  })

  it('retains successful page evidence when a later request fails', async () => {
    let call = 0
    const fetchPage: GtradeTradesPageFetcher = async (cursor) => {
      call += 1
      if (call === 2) throw new Error('network down')
      return {
        payload: page([trade(10, 1), trade(9, 2), trade(8, 3)], true),
        url: `https://gtrade.test/history?cursor=${cursor ?? ''}`,
      }
    }

    try {
      await fetchGtradeTradesWindow(fetchPage, AS_OF, { maxPages: 5, pageLimit: 3 })
      throw new Error('expected request failure')
    } catch (error) {
      expect(error).toMatchObject({
        name: 'GtradeTradesFetchError',
        reason: 'request_failed',
        partial: {
          rawPages: [expect.objectContaining({ requestCursor: null })],
          meta: {
            requestCount: 2,
            pageCount: 1,
            uniqueRowCount: 3,
            complete: false,
            stopReason: 'request_failed',
          },
        },
      })
    }
  })

  it('rejects invalid maxPages and page limits before requesting', async () => {
    const request = jest.fn(fetcher([]))
    await expect(fetchGtradeTradesWindow(request, AS_OF, { maxPages: 0 })).rejects.toThrow(
      'invalid trades fetch options'
    )
    await expect(
      fetchGtradeTradesWindow(request, AS_OF, { maxPages: 1, pageLimit: 1_001 })
    ).rejects.toThrow('invalid trades fetch options')
    expect(request).not.toHaveBeenCalled()
  })

  it('replays raw pages instead of trusting flattened rows or summary flags', async () => {
    const snapshot = await fetchGtradeTradesWindow(
      fetcher([page([trade(10, 1), trade(9, 2)], true), page([trade(8, 89)], true)]),
      AS_OF,
      { maxPages: 2, pageLimit: 3 }
    )
    snapshot.trades = [{ id: 999, date: new Date(AS_OF).toISOString() }]
    snapshot.meta.complete = false
    snapshot.meta.exhausted = true

    expect(replayGtradeTradesSnapshot(snapshot)).toMatchObject({
      asOfTimeMs: AS_OF,
      trades: [{ id: 10 }, { id: 9 }, { id: 8 }],
      validPageCount: 2,
      exhausted: false,
      stopReason: 'open_prefix',
      error: null,
    })
  })

  it('retains only the valid prefix when a later stored page is corrupt', async () => {
    const snapshot = await fetchGtradeTradesWindow(
      fetcher([page([trade(10, 1), trade(9, 8)], true)]),
      AS_OF,
      { maxPages: 1, pageLimit: 3 }
    )
    snapshot.rawPages.push({
      pageIndex: 2,
      requestCursor: 999,
      requestStartTimeMs: AS_OF - 90 * DAY,
      requestEndTimeMs: AS_OF,
      url: 'https://gtrade.test/history?cursor=999',
      response: page([trade(8, 9)], false),
    })

    expect(replayGtradeTradesSnapshot(snapshot)).toMatchObject({
      trades: [{ id: 10 }, { id: 9 }],
      validPageCount: 1,
      rawPageCount: 2,
      oldestTimeMs: AS_OF - 8 * DAY,
      exhausted: false,
      stopReason: 'invalid_page',
    })
  })

  it('replays an identical page-boundary row once and proves exhaustion', async () => {
    const boundary = trade(8, 3)
    const snapshot = await fetchGtradeTradesWindow(
      fetcher([
        page([trade(10, 1), trade(9, 2), boundary], true),
        page([boundary, trade(7, 4)], false),
      ]),
      AS_OF,
      { maxPages: 5, pageLimit: 3 }
    )

    expect(replayGtradeTradesSnapshot(snapshot)).toMatchObject({
      trades: [{ id: 10 }, { id: 9 }, { id: 8 }, { id: 7 }],
      validPageCount: 2,
      duplicateRowCount: 1,
      exhausted: true,
      stopReason: 'exhausted',
    })
  })

  it('fails closed on an invalid snapshot envelope', () => {
    expect(replayGtradeTradesSnapshot({ schemaVersion: 1 })).toMatchObject({
      asOfTimeMs: null,
      trades: [],
      stopReason: 'invalid_snapshot',
    })
  })
})
