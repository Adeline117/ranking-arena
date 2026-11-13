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
})
