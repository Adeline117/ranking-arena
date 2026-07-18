import {
  buildFollowedDigestActivity,
  indexDigestActivities,
  indexDigestFollows,
  readAllPages,
  type DigestActivityRow,
} from '../personalization'

function activity(source: string, text: string, handle: string): DigestActivityRow {
  return {
    id: `${source}-${text}`,
    source_trader_id: 'shared-id',
    source,
    handle,
    activity_text: text,
    occurred_at: '2026-07-18T10:00:00.000Z',
  }
}

describe('weekly digest trader account personalization', () => {
  it('never crosses exchanges that reuse the same raw trader id', () => {
    const { followsByUser } = indexDigestFollows([
      { user_id: 'user-bybit', trader_id: 'shared-id', source: 'bybit' },
      { user_id: 'user-binance', trader_id: 'shared-id', source: 'binance' },
      { user_id: 'legacy', trader_id: 'shared-id', source: null },
    ])
    const activities = indexDigestActivities([
      activity('bybit', 'Bybit moved', 'Bybit Alpha'),
      activity('binance', 'Binance moved', 'Binance Alpha'),
    ])

    expect(buildFollowedDigestActivity('user-bybit', followsByUser, activities)).toEqual([
      {
        name: 'Bybit Alpha',
        summary: 'Bybit moved',
        link: '/trader/Bybit%20Alpha?platform=bybit',
      },
    ])
    expect(buildFollowedDigestActivity('user-binance', followsByUser, activities)).toEqual([
      {
        name: 'Binance Alpha',
        summary: 'Binance moved',
        link: '/trader/Binance%20Alpha?platform=binance',
      },
    ])
    expect(buildFollowedDigestActivity('legacy', followsByUser, activities)).toEqual([])
  })

  it('reads every page with stable inclusive ranges', async () => {
    const loadPage = jest
      .fn()
      .mockResolvedValueOnce({
        data: Array.from({ length: 1000 }, (_, index) => index),
        error: null,
      })
      .mockResolvedValueOnce({ data: [1000], error: null })

    const result = await readAllPages(loadPage)

    expect(result.data).toHaveLength(1001)
    expect(loadPage).toHaveBeenNthCalledWith(1, 0, 999)
    expect(loadPage).toHaveBeenNthCalledWith(2, 1000, 1999)
  })

  it('discards partial pagination when a later page fails', async () => {
    const loadPage = jest
      .fn()
      .mockResolvedValueOnce({
        data: Array.from({ length: 1000 }, (_, index) => index),
        error: null,
      })
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'page failed' },
      })

    await expect(readAllPages(loadPage)).resolves.toEqual({
      data: [],
      error: { message: 'page failed' },
    })
  })
})
