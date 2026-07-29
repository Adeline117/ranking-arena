import type { Job } from 'bullmq'
import type { SourceRow } from '@/lib/ingest/core/types'
import type { TierJobData } from '../../queues'

const mockGetSourceBySlug = jest.fn()
const mockGetAdapter = jest.fn()
const mockOpenSession = jest.fn()
const mockDbQuery = jest.fn()
const mockWriteRawObject = jest.fn()
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
jest.mock('@/lib/ingest/raw', () => ({
  writeRawObject: (...args: unknown[]) => mockWriteRawObject(...args),
}))
jest.mock('@/lib/ingest/serving/publish', () => ({
  publishPositions: (...args: unknown[]) => mockPublishPositions(...args),
}))

import { processTierD as processTierDInRegion } from '../tier-d-positions'
import { createConsumedRegionContext } from '../../consumed-region-context'

const processTierD = (job: Parameters<typeof processTierDInRegion>[0]) =>
  processTierDInRegion(job, createConsumedRegionContext('local', 'local'))

const spotSource = {
  id: 35,
  slug: 'okx_spot',
  adapter_slug: 'okx',
  product_type: 'spot',
  status: 'active',
  fetch_region: 'local',
  positions_topn: 100,
  meta: { inst_type: 'SPOT' },
} as SourceRow

describe('Tier-D source-specific capabilities', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSourceBySlug.mockResolvedValue(spotSource)
    mockGetAdapter.mockReturnValue({
      capabilities: { positions: true },
      supportsSurface: (_src: SourceRow, surface: string) => surface !== 'positions',
    })
    mockWriteRawObject.mockResolvedValue({ id: 1 })
    mockPublishPositions.mockResolvedValue(undefined)
  })

  it('rejects a moved source before capability checks or external work', async () => {
    mockGetSourceBySlug.mockResolvedValue({ ...spotSource, fetch_region: 'vps_sg' })
    const job = { data: { sourceSlug: 'okx_spot' } } as Job<TierJobData>

    await expect(processTierD(job)).rejects.toThrow(
      'belongs to vps_sg, not consumed queue region local'
    )
    expect(mockGetAdapter).not.toHaveBeenCalled()
    expect(mockDbQuery).not.toHaveBeenCalled()
    expect(mockOpenSession).not.toHaveBeenCalled()
  })

  it('does not query targets or open a session for a known unsupported source', async () => {
    const job = { data: { sourceSlug: 'okx_spot' } } as Job<TierJobData>

    await expect(processTierD(job)).resolves.toEqual({
      tradersCrawled: 0,
      positionsWritten: 0,
      errors: 0,
    })
    expect(mockDbQuery).not.toHaveBeenCalled()
    expect(mockOpenSession).not.toHaveBeenCalled()
  })

  it('preserves last-good positions when acquisition returns no source page', async () => {
    const close = jest.fn().mockResolvedValue(undefined)
    mockGetAdapter.mockReturnValue({
      capabilities: { positions: true },
      supportsSurface: () => true,
      getPositions: jest.fn().mockResolvedValue({
        pages: [],
        fetchedAt: '2026-07-29T12:00:00.000Z',
      }),
      parsePositions: jest.fn(),
    })
    mockDbQuery.mockResolvedValue({
      rows: [{ id: 42, exchange_trader_id: 'trader-1', meta: null }],
    })
    mockOpenSession.mockResolvedValue({ close })
    const job = { data: { sourceSlug: 'okx_spot' } } as Job<TierJobData>

    await expect(processTierD(job)).resolves.toEqual({
      tradersCrawled: 0,
      positionsWritten: 0,
      errors: 1,
    })

    expect(mockWriteRawObject).toHaveBeenCalledWith(expect.objectContaining({ payload: [] }))
    expect(mockPublishPositions).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('allows an evidenced successful empty snapshot to clear positions', async () => {
    const close = jest.fn().mockResolvedValue(undefined)
    const parsePositions = jest.fn().mockReturnValue([])
    const page = {
      pageIndex: 1,
      payload: { code: '200', data: [] },
      url: 'https://example.test/positions',
      fetchedAt: '2026-07-29T12:00:00.000Z',
    }
    mockGetAdapter.mockReturnValue({
      capabilities: { positions: true },
      supportsSurface: () => true,
      getPositions: jest.fn().mockResolvedValue({ pages: [page], fetchedAt: page.fetchedAt }),
      parsePositions,
    })
    mockDbQuery.mockResolvedValue({
      rows: [{ id: 42, exchange_trader_id: 'trader-1', meta: null }],
    })
    mockOpenSession.mockResolvedValue({ close })
    const job = { data: { sourceSlug: 'okx_spot' } } as Job<TierJobData>

    await expect(processTierD(job)).resolves.toEqual({
      tradersCrawled: 1,
      positionsWritten: 0,
      errors: 0,
    })

    expect(parsePositions).toHaveBeenCalledTimes(1)
    expect(mockPublishPositions).toHaveBeenCalledWith(spotSource, 42, [], expect.any(String))
    expect(close).toHaveBeenCalledTimes(1)
  })
})
