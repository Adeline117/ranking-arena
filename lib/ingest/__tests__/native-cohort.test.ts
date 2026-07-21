jest.mock('../db', () => ({ getIngestPool: jest.fn() }))

import { getIngestPool } from '../db'
import { getLatestPassedNativeCohort } from '../native-cohort'

const mockQuery = jest.fn()
const mockGetIngestPool = jest.mocked(getIngestPool)

const hyperliquid = {
  id: 20,
  timeframes_native: [7, 30],
  deep_profile_topn: 500,
}

beforeEach(() => {
  mockQuery.mockReset()
  mockGetIngestPool.mockReturnValue({ query: mockQuery } as never)
})

describe('latest PASSED native top-N cohort', () => {
  it('uses Hyperliquid top-500 per native board and de-duplicates the 7d/30d union', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { snapshot_id: 700, timeframe: 7 },
          { snapshot_id: 3000, timeframe: 30 },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            exchange_trader_id: '0x01',
            meta: null,
            timeframe: 7,
            headline_roi: 7.1,
          },
          {
            id: 1,
            exchange_trader_id: '0x01',
            meta: null,
            timeframe: 30,
            headline_roi: 30.1,
          },
          {
            id: 2,
            exchange_trader_id: '0x02',
            meta: { label: 'second' },
            timeframe: 30,
            headline_roi: 12,
          },
        ],
      })

    await expect(getLatestPassedNativeCohort(hyperliquid)).resolves.toEqual({
      nativeTimeframes: [7, 30],
      foundTimeframes: [7, 30],
      missingTimeframes: [],
      traders: [
        {
          id: 1,
          exchange_trader_id: '0x01',
          meta: null,
          headline_rois: { '7': 7.1, '30': 30.1 },
        },
        {
          id: 2,
          exchange_trader_id: '0x02',
          meta: { label: 'second' },
          headline_rois: { '30': 12 },
        },
      ],
    })

    const [snapshotSql, snapshotParams] = mockQuery.mock.calls[0]
    expect(String(snapshotSql)).toContain('timeframe = ANY($2::int[])')
    expect(String(snapshotSql)).toContain('AND count_check_passed')
    expect(String(snapshotSql)).toContain('AND NOT is_derived')
    expect(String(snapshotSql)).toContain('ORDER BY timeframe, scraped_at DESC, id DESC')
    expect(snapshotParams).toEqual([hyperliquid.id, [7, 30]])

    const [membershipSql, membershipParams] = mockQuery.mock.calls[1]
    expect(String(membershipSql)).toContain('e.snapshot_id = ANY($1::bigint[])')
    expect(String(membershipSql)).toContain('e.rank <= $2')
    expect(membershipParams).toEqual([[700, 3000], 500, null, false, null])
    expect(membershipParams[0]).not.toContain(9000) // a derived 90d snapshot can never enter
  })

  it('reports every missing declared native timeframe', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ snapshot_id: 700, timeframe: 7 }] })
      .mockResolvedValueOnce({ rows: [] })

    const result = await getLatestPassedNativeCohort({
      ...hyperliquid,
      timeframes_native: [30, 7, 30],
    })

    expect(result.nativeTimeframes).toEqual([7, 30])
    expect(result.foundTimeframes).toEqual([7])
    expect(result.missingTimeframes).toEqual([30])
  })

  it('applies Tier-B claimed and profile-cursor filters after native snapshot selection', async () => {
    const stalerThan = new Date('2026-07-21T12:00:00.000Z')
    mockQuery
      .mockResolvedValueOnce({ rows: [{ snapshot_id: 700, timeframe: 7 }] })
      .mockResolvedValueOnce({ rows: [] })

    await getLatestPassedNativeCohort(
      { id: 19, timeframes_native: [7], deep_profile_topn: 300 },
      {
        excludeClaimed: true,
        profileCursor: { kind: 'tierb_profiled', stalerThan },
      }
    )

    const [membershipSql, membershipParams] = mockQuery.mock.calls[1]
    expect(String(membershipSql)).toContain("(t.meta->>'claimed') IS DISTINCT FROM 'true'")
    expect(String(membershipSql)).toContain('pc.updated_at < $5::timestamptz')
    expect(membershipParams).toEqual([[700], 300, 'tierb_profiled', true, stalerThan.toISOString()])
  })
})
