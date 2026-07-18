const mockRpc = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ rpc: mockRpc }),
}))

jest.mock('@/lib/services/pipeline-state', () => ({
  PipelineState: {
    get: jest.fn(),
    set: jest.fn(),
  },
}))

import { checkDataFreshness } from '../data-checks'

describe('pipeline evaluator data freshness', () => {
  beforeEach(() => {
    mockRpc.mockReset()
  })

  it('reads the current source/latest RPC contract', async () => {
    mockRpc.mockResolvedValue({
      data: [
        { source: 'binance_futures', latest: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
        { source: 'gmx', latest: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
      ],
      error: null,
    })

    const result = await checkDataFreshness()

    expect(result.check).toMatchObject({
      name: 'data_freshness',
      passed: true,
      score: 100,
      details: '2/2 platforms fresh',
    })
    expect(result.issues).toEqual([])
  })

  it('reports an active source without a snapshot as critical', async () => {
    mockRpc.mockResolvedValue({
      data: [{ source: 'new_active_source', latest: null }],
      error: null,
    })

    const result = await checkDataFreshness()

    expect(result.check).toMatchObject({ passed: false, score: 0 })
    expect(result.issues).toEqual([
      expect.objectContaining({
        platform: 'new_active_source',
        type: 'missing_active_source_snapshot',
        severity: 'critical',
      }),
    ])
  })

  it.each([
    ['RPC error', { data: null, error: { message: 'down' } }],
    ['empty result', { data: [], error: null }],
    [
      'duplicate alias',
      {
        data: [
          { source: 'bybit', latest: new Date().toISOString() },
          { source: 'bybit', latest: new Date().toISOString() },
        ],
        error: null,
      },
    ],
  ])('fails closed when the freshness authority has %s', async (_case, response) => {
    mockRpc.mockResolvedValue(response)

    const result = await checkDataFreshness()

    expect(result.check).toMatchObject({ passed: false, score: 0 })
    expect(result.issues).toEqual([
      expect.objectContaining({
        type: 'freshness_authority_unavailable',
        severity: 'critical',
      }),
    ])
  })
})
