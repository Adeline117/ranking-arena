import type { SupabaseClient } from '@supabase/supabase-js'

jest.mock('@/lib/api/middleware', () => ({
  withPublic: (handler: unknown) => handler,
}))

import { computePlatformHealth } from '../route'

type QueryResult = {
  data: unknown[] | null
  error: { message: string } | null
}

function query(result: QueryResult) {
  const builder: Record<string, jest.Mock | ((...args: unknown[]) => Promise<unknown>)> = {}
  for (const method of ['select', 'eq', 'order', 'limit']) {
    builder[method] = jest.fn(() => builder)
  }
  builder.then = (
    resolve: (value: QueryResult) => unknown,
    reject?: (reason: unknown) => unknown
  ) => Promise.resolve(result).then(resolve, reject)
  return builder
}

describe('public platform health freshness', () => {
  it('fails closed to unknown when pipeline logs cannot prove freshness', async () => {
    const healthQuery = query({
      data: [
        {
          platform: 'binance_futures',
          status: 'healthy',
          last_success_at: '2026-08-17T00:00:00.000Z',
          error_count: 0,
        },
      ],
      error: null,
    })
    const pipelineQuery = query({ data: [], error: null })
    const from = jest.fn().mockReturnValueOnce(healthQuery).mockReturnValueOnce(pipelineQuery)

    const result = await computePlatformHealth({ from } as unknown as SupabaseClient)

    expect(result).toEqual({
      platforms: [expect.objectContaining({ platform: 'binance_futures' })],
      freshness: {},
      freshness_visibility: 'unknown',
      freshness_reason: 'pipeline_freshness_unavailable',
    })
    expect(from).not.toHaveBeenCalledWith('leaderboard_ranks')
  })

  it('uses pipeline logs only when they provide a platform timestamp', async () => {
    const healthQuery = query({ data: [], error: null })
    const pipelineQuery = query({
      data: [
        { job_name: 'fetch-binance_futures', ended_at: '2026-08-17T00:00:00.000Z' },
        { job_name: 'enrich-binance_futures', ended_at: '2026-08-16T00:00:00.000Z' },
      ],
      error: null,
    })
    const from = jest.fn().mockReturnValueOnce(healthQuery).mockReturnValueOnce(pipelineQuery)

    const result = await computePlatformHealth({ from } as unknown as SupabaseClient)

    expect(result).toEqual({
      platforms: [],
      freshness: { binance_futures: '2026-08-17T00:00:00.000Z' },
      freshness_visibility: 'verified',
      freshness_reason: null,
    })
    expect(from).not.toHaveBeenCalledWith('leaderboard_ranks')
  })

  it('marks a pipeline-log query failure unknown without a raw fallback', async () => {
    const healthQuery = query({ data: [], error: null })
    const pipelineQuery = query({ data: null, error: { message: 'pipeline logs unavailable' } })
    const from = jest.fn().mockReturnValueOnce(healthQuery).mockReturnValueOnce(pipelineQuery)

    const result = await computePlatformHealth({ from } as unknown as SupabaseClient)

    expect(result).toMatchObject({
      freshness: {},
      freshness_visibility: 'unknown',
      freshness_reason: 'pipeline_logs_unavailable',
    })
    expect(from).not.toHaveBeenCalledWith('leaderboard_ranks')
  })
})
