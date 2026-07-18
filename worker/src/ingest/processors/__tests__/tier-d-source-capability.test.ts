import type { Job } from 'bullmq'
import type { SourceRow } from '@/lib/ingest/core/types'
import type { TierJobData } from '../../queues'

const mockGetSourceBySlug = jest.fn()
const mockGetAdapter = jest.fn()
const mockOpenSession = jest.fn()
const mockDbQuery = jest.fn()

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
jest.mock('@/lib/ingest/serving/publish', () => ({ publishPositions: jest.fn() }))

import { processTierD } from '../tier-d-positions'

const spotSource = {
  id: 35,
  slug: 'okx_spot',
  adapter_slug: 'okx',
  product_type: 'spot',
  status: 'active',
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
})
