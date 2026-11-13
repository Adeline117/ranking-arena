import type { Job } from 'bullmq'
import type { SourceRow } from '@/lib/ingest/core/types'
import type { TierJobData } from '../../queues'
import { parseBitgetPositions } from '@/lib/ingest/adapters/bitget/parsers'

const mockGetSourceBySlug = jest.fn()
const mockGetAdapter = jest.fn()
const mockOpenSession = jest.fn()
const mockDbQuery = jest.fn()
const mockPublishPositions = jest.fn()

jest.mock('@/lib/ingest/sources', () => ({
  getSourceBySlug: (...args: unknown[]) => mockGetSourceBySlug(...args),
}))
jest.mock('@/lib/ingest/core/adapter', () => ({
  getAdapter: (...args: unknown[]) => mockGetAdapter(...args),
}))
jest.mock('@/lib/ingest/fetch/fetcher', () => ({
  openSession: (...args: unknown[]) => mockOpenSession(...args),
}))
jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: jest.fn(() => ({ query: (...args: unknown[]) => mockDbQuery(...args) })),
}))
jest.mock('@/lib/ingest/raw', () => ({ writeRawObject: jest.fn() }))
const mockQueueAdd = jest.fn()
const mockCloseCircuitCycle = jest.fn(async () => ({ alerted: false, failureRate: 0, samples: 0 }))
jest.mock('../../circuit-cycle', () => ({
  closeCircuitCycle: (...args: unknown[]) => mockCloseCircuitCycle(...(args as [])),
}))
jest.mock('../../../connection', () => ({ getConnection: jest.fn() }))
jest.mock('../../queues', () => ({
  getRegionQueue: jest.fn(() => ({ add: (...args: unknown[]) => mockQueueAdd(...args) })),
  INGEST_JOB: { TIER_D: 'tier-d' },
}))
jest.mock('@/lib/ingest/serving/publish', () => ({
  publishPositions: (...args: unknown[]) => mockPublishPositions(...args),
}))

import { processTierD as processTierDInRegion } from '../tier-d-positions'
import { createConsumedRegionContext } from '../../consumed-region-context'

const processTierD = (job: Parameters<typeof processTierDInRegion>[0]) =>
  processTierDInRegion(job, createConsumedRegionContext('local', 'local'))

const bitgetSource = {
  id: 1,
  slug: 'bitget_futures',
  adapter_slug: 'bitget',
  product_type: 'futures',
  status: 'active',
  fetch_region: 'local',
  positions_topn: 10,
  currency: 'USDT',
  tf_label_map: {},
  meta: {},
} as unknown as SourceRow

const job = { data: { sourceSlug: 'bitget_futures' } } as Job<TierJobData>

function adapterReturning(payload: unknown, pages = true) {
  return {
    capabilities: { positions: true },
    getPositions: jest.fn(async () => ({
      pages: pages
        ? [
            {
              pageIndex: 1,
              payload,
              url: 'https://example.invalid',
              fetchedAt: '2026-11-12T00:00:00.000Z',
            },
          ]
        : [],
      fetchedAt: '2026-11-12T00:00:00.000Z',
    })),
    parsePositions: parseBitgetPositions,
  }
}

describe('Tier-D fails closed on unusable position captures', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    mockGetSourceBySlug.mockResolvedValue(bitgetSource)
    mockDbQuery.mockResolvedValue({ rows: [{ id: 7, exchange_trader_id: 'u-1', meta: null }] })
    mockOpenSession.mockResolvedValue({ close: jest.fn() })
  })

  it.each([
    ['business error envelope', { code: '30066', msg: '仓位保护' }],
    ['data:null on success code', { code: '200', data: null }],
  ])('does not replace positions on %s', async (_label, payload) => {
    mockGetAdapter.mockReturnValue(adapterReturning(payload))
    await expect(processTierD(job)).resolves.toEqual({
      tradersCrawled: 0,
      positionsWritten: 0,
      errors: 1,
    })
    expect(mockPublishPositions).not.toHaveBeenCalled()
  })

  it('does not replace positions when the capture has no pages', async () => {
    mockGetAdapter.mockReturnValue(adapterReturning(null, false))
    await expect(processTierD(job)).resolves.toMatchObject({ errors: 1 })
    expect(mockPublishPositions).not.toHaveBeenCalled()
  })

  it('publishes a genuine empty book from a success envelope', async () => {
    mockGetAdapter.mockReturnValue(adapterReturning({ code: '200', data: [] }))
    await expect(processTierD(job)).resolves.toEqual({
      tradersCrawled: 1,
      positionsWritten: 0,
      errors: 0,
    })
    expect(mockPublishPositions).toHaveBeenCalledWith(bitgetSource, 7, [], expect.any(String))
  })

  it('selects targets only from fresh, native, deterministically ordered PASSED snapshots', async () => {
    mockGetAdapter.mockReturnValue(adapterReturning({ code: '200', data: [] }))
    await processTierD(job)
    const [sql, params] = mockDbQuery.mock.calls[0]
    expect(String(sql)).toContain('AND NOT is_derived')
    expect(String(sql)).toContain('scraped_at > now() - make_interval(secs => $3::int)')
    expect(String(sql)).toContain('ORDER BY timeframe, scraped_at DESC, id DESC')
    expect(params).toEqual([1, 10, 72 * 3600])
  })

  it('yields at the deadline and enqueues a continuation with exactly the uncrawled traders', async () => {
    mockGetSourceBySlug.mockResolvedValue({ ...bitgetSource, meta: { tier_d_deadline_ms: 60_000 } })
    mockDbQuery.mockResolvedValue({
      rows: [
        { id: 7, exchange_trader_id: 'u-1', meta: null },
        { id: 8, exchange_trader_id: 'u-2', meta: null },
        { id: 9, exchange_trader_id: 'u-3', meta: null },
      ],
    })
    const adapter = adapterReturning({ code: '200', data: [] })
    const realNow = Date.now
    let calls = 0
    // first trader within budget, then the clock passes the deadline
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + (calls++ >= 2 ? 120_000 : 0))
    mockGetAdapter.mockReturnValue(adapter)

    const result = await processTierD(job)
    jest.spyOn(Date, 'now').mockRestore()

    expect(result.tradersCrawled).toBe(1)
    expect(result.remaining).toBe(2)
    expect(mockQueueAdd).toHaveBeenCalledTimes(1)
    const [name, data, opts] = mockQueueAdd.mock.calls[0]
    expect(name).toBe('tier-d')
    expect(data).toMatchObject({ sourceSlug: 'bitget_futures', contDepth: 1 })
    expect((data.tierDRemainingTraderIds as number[]).sort()).toHaveLength(2)
    expect(opts).toMatchObject({ priority: 3, jobId: 'tierd-cont-bitget_futures-1' })
    // The circuit-breaker cycle still closes exactly once for this hop (#417).
    expect(mockCloseCircuitCycle).toHaveBeenCalledTimes(1)
    expect(mockCloseCircuitCycle.mock.calls[0]).toEqual(
      expect.arrayContaining([expect.objectContaining({ slug: 'bitget_futures' }), 'D'])
    )
  })

  it('a continuation crawls only the carried traders that are still in the top-N', async () => {
    mockDbQuery.mockResolvedValue({
      rows: [
        { id: 7, exchange_trader_id: 'u-1', meta: null },
        { id: 8, exchange_trader_id: 'u-2', meta: null },
      ],
    })
    const adapter = adapterReturning({ code: '200', data: [] })
    mockGetAdapter.mockReturnValue(adapter)

    const result = await processTierD({
      data: { sourceSlug: 'bitget_futures', contDepth: 1, tierDRemainingTraderIds: [8, 99] },
    } as Job<TierJobData>)

    expect(result.tradersCrawled).toBe(1)
    expect(adapter.getPositions).toHaveBeenCalledTimes(1)
    expect(adapter.getPositions.mock.calls[0][2]).toBe('u-2')
    expect(mockQueueAdd).not.toHaveBeenCalled()
  })
})
