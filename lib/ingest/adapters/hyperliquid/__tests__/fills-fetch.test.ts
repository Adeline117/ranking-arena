import { fetchHyperliquidFillsWindow, HYPERLIQUID_FILLS_PAGE_LIMIT } from '../fills-fetch'
import type { HlFill } from '../fills'

function fill(time: number, tid: number): HlFill {
  return { time, tid, coin: 'BTC', side: 'B', sz: '1', px: '1', startPosition: '0' }
}

describe('fetchHyperliquidFillsWindow', () => {
  it('freezes endTime, advances the inclusive cursor, and deduplicates its boundary', async () => {
    const first = Array.from({ length: HYPERLIQUID_FILLS_PAGE_LIMIT }, (_, i) =>
      fill(1_000 + i, i + 1)
    )
    const requests: Array<[number, number]> = []
    const fetchPage = jest.fn(async (start: number, end: number) => {
      requests.push([start, end])
      return requests.length === 1 ? first : [first.at(-1), fill(3_000, 2_001)]
    })

    const beforeNextPage = jest.fn(async () => undefined)
    const result = await fetchHyperliquidFillsWindow(fetchPage, 1_000, 9_000, {
      beforeNextPage,
    })

    expect(requests).toEqual([
      [1_000, 9_000],
      [2_999, 9_000],
    ])
    expect(beforeNextPage).toHaveBeenCalledTimes(1)
    expect(beforeNextPage).toHaveBeenCalledWith(HYPERLIQUID_FILLS_PAGE_LIMIT)
    expect(result.schemaVersion).toBe(2)
    expect(result.rawPages).toEqual([
      { requestStartTimeMs: 1_000, requestEndTimeMs: 9_000, response: first },
      {
        requestStartTimeMs: 2_999,
        requestEndTimeMs: 9_000,
        response: [first.at(-1), fill(3_000, 2_001)],
      },
    ])
    expect(result.fills).toHaveLength(2_001)
    expect(result.meta).toMatchObject({
      requestCount: 2,
      pageCount: 2,
      fillCount: 2_001,
      exhausted: true,
      limitHit: false,
      stalled: false,
      completeThroughEnd: true,
      failureReason: null,
      complete: true,
    })
  })

  it('treats a successful empty response as a complete zero-activity window', async () => {
    const result = await fetchHyperliquidFillsWindow(async () => [], 1_000, 9_000)
    expect(result.fills).toEqual([])
    expect(result.meta).toMatchObject({
      pageCount: 1,
      fillCount: 0,
      exhausted: true,
      complete: true,
    })
  })

  it('marks 10,000 accessible fills as limit-hit even after an exhaustion probe', async () => {
    let page = 0
    const result = await fetchHyperliquidFillsWindow(
      async () => {
        if (page === 5) return []
        const start = page * HYPERLIQUID_FILLS_PAGE_LIMIT
        page += 1
        return Array.from({ length: HYPERLIQUID_FILLS_PAGE_LIMIT }, (_, i) =>
          fill(1_000 + start + i, start + i + 1)
        )
      },
      1_000,
      20_000
    )

    expect(result.fills).toHaveLength(10_000)
    expect(result.meta).toMatchObject({
      pageCount: 6,
      exhausted: true,
      limitHit: true,
      complete: false,
    })
  })

  it('fails closed when an inclusive full page cannot advance', async () => {
    const repeated = Array.from({ length: HYPERLIQUID_FILLS_PAGE_LIMIT }, (_, i) =>
      fill(1_000, i + 1)
    )
    const result = await fetchHyperliquidFillsWindow(async () => repeated, 1_000, 9_000)
    expect(result.meta).toMatchObject({
      exhausted: false,
      stalled: true,
      completeThroughEnd: false,
      failureReason: 'stalled',
      complete: false,
    })
  })

  it('preserves upstream order for same-millisecond tids', async () => {
    const result = await fetchHyperliquidFillsWindow(
      async () => [fill(1_000, 2), fill(1_000, 10)],
      1_000,
      9_000
    )
    expect(result.fills.map((row) => row.tid)).toEqual([2, 10])
  })

  it('rejects a page that returns rows before its inclusive cursor', async () => {
    const first = Array.from({ length: HYPERLIQUID_FILLS_PAGE_LIMIT }, (_, i) =>
      fill(1_000 + i, i + 1)
    )
    let page = 0
    await expect(
      fetchHyperliquidFillsWindow(
        async () => {
          page += 1
          return page === 1 ? first : [fill(2_998, 2_001)]
        },
        1_000,
        9_000
      )
    ).rejects.toThrow('out of range or order')
  })

  it('rejects missing tids and conflicting duplicate payloads', async () => {
    await expect(
      fetchHyperliquidFillsWindow(async () => [{ ...fill(1_000, 1), tid: undefined }], 1_000, 9_000)
    ).rejects.toThrow('missing a valid tid')

    const first = Array.from({ length: HYPERLIQUID_FILLS_PAGE_LIMIT }, (_, i) =>
      fill(1_000 + i, i + 1)
    )
    let page = 0
    await expect(
      fetchHyperliquidFillsWindow(
        async () => {
          page += 1
          return page === 1 ? first : [{ ...first.at(-1), px: '2' }]
        },
        1_000,
        9_000
      )
    ).rejects.toThrow('duplicate tid payload changed')
  })

  it('retains successful pages and the failed request count on a later network error', async () => {
    const first = Array.from({ length: HYPERLIQUID_FILLS_PAGE_LIMIT }, (_, i) =>
      fill(1_000 + i, i + 1)
    )
    let request = 0
    try {
      await fetchHyperliquidFillsWindow(
        async () => {
          request += 1
          if (request === 1) return first
          throw new Error('socket closed')
        },
        1_000,
        9_000
      )
      throw new Error('expected request failure')
    } catch (error) {
      expect(error).toMatchObject({
        name: 'HyperliquidFillsFetchError',
        reason: 'request_failed',
        partial: {
          schemaVersion: 2,
          rawPages: [{ requestStartTimeMs: 1_000, requestEndTimeMs: 9_000, response: first }],
          meta: {
            requestCount: 2,
            pageCount: 1,
            fillCount: HYPERLIQUID_FILLS_PAGE_LIMIT,
            completeThroughEnd: false,
            failureReason: 'request_failed',
            complete: false,
          },
        },
      })
    }
  })

  it('marks a local page cap as incomplete without calling the throttle again', async () => {
    const page = Array.from({ length: HYPERLIQUID_FILLS_PAGE_LIMIT }, (_, i) =>
      fill(1_000 + i, i + 1)
    )
    const beforeNextPage = jest.fn(async () => undefined)
    const result = await fetchHyperliquidFillsWindow(async () => page, 1_000, 9_000, {
      maxPages: 1,
      beforeNextPage,
    })
    expect(beforeNextPage).not.toHaveBeenCalled()
    expect(result.meta).toMatchObject({
      completeThroughEnd: false,
      failureReason: 'page_limit',
      complete: false,
    })
  })

  it('rejects malformed, out-of-order, and out-of-range pages', async () => {
    await expect(fetchHyperliquidFillsWindow(async () => ({}), 1_000, 9_000)).rejects.toThrow(
      'unexpected userFillsByTime response'
    )
    await expect(
      fetchHyperliquidFillsWindow(async () => [fill(2_000, 1), fill(1_999, 2)], 1_000, 9_000)
    ).rejects.toThrow('out of range or order')
    await expect(
      fetchHyperliquidFillsWindow(async () => [fill(9_001, 1)], 1_000, 9_000)
    ).rejects.toThrow('out of range or order')
  })
})
