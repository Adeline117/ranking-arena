const mockFrom = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({
    from: mockFrom,
  }),
}))

jest.mock('@/lib/logger', () => ({
  logger: {
    warn: jest.fn(),
  },
}))

import { PipelineState } from '../pipeline-state'

function readResult(result: { data: unknown; error: unknown }) {
  return {
    select: jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        maybeSingle: jest.fn().mockResolvedValue(result),
      }),
    }),
  }
}

describe('PipelineState storage authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('get distinguishes a missing key from a resolved PostgREST error', async () => {
    mockFrom.mockReturnValueOnce(readResult({ data: null, error: null }))
    await expect(PipelineState.get('missing')).resolves.toBeNull()

    mockFrom.mockReturnValueOnce(
      readResult({ data: null, error: { message: 'pipeline_state read failed' } })
    )
    await expect(PipelineState.get('broken')).rejects.toThrow('pipeline_state read failed')
  })

  test('set rejects when PostgREST resolves with a write error', async () => {
    mockFrom.mockReturnValue({
      upsert: jest.fn().mockResolvedValue({
        data: null,
        error: { message: 'pipeline_state upsert failed' },
      }),
    })

    await expect(PipelineState.set('key', 1)).rejects.toThrow('pipeline_state upsert failed')
  })

  test('set forwards a caller deadline to the durable write', async () => {
    const abortSignal = jest.fn().mockResolvedValue({ data: null, error: null })
    mockFrom.mockReturnValue({
      upsert: jest.fn().mockReturnValue({ abortSignal }),
    })
    const signal = new AbortController().signal

    await expect(PipelineState.set('key', 1, { signal })).resolves.toBeUndefined()
    expect(abortSignal).toHaveBeenCalledWith(signal)
  })

  test('del rejects when PostgREST resolves with a delete error', async () => {
    mockFrom.mockReturnValue({
      delete: jest.fn().mockReturnValue({
        eq: jest.fn().mockResolvedValue({
          data: null,
          error: { message: 'pipeline_state delete failed' },
        }),
      }),
    })

    await expect(PipelineState.del('key')).rejects.toThrow('pipeline_state delete failed')
  })

  test('incr rejects instead of fabricating success after a failed read or write', async () => {
    mockFrom.mockReturnValueOnce(
      readResult({ data: null, error: { message: 'counter read failed' } })
    )
    await expect(PipelineState.incr('counter')).rejects.toThrow('counter read failed')

    mockFrom
      .mockReturnValueOnce(readResult({ data: { value: 2 }, error: null }))
      .mockReturnValueOnce({
        upsert: jest.fn().mockResolvedValue({
          data: null,
          error: { message: 'counter write failed' },
        }),
      })
    await expect(PipelineState.incr('counter')).rejects.toThrow('counter write failed')
  })

  test('getByPrefix rejects instead of converting query failure into an empty result', async () => {
    mockFrom.mockReturnValue({
      select: jest.fn().mockReturnValue({
        like: jest.fn().mockResolvedValue({
          data: null,
          error: { message: 'prefix scan failed' },
        }),
      }),
    })

    await expect(PipelineState.getByPrefix('enrich:dead:')).rejects.toThrow('prefix scan failed')
  })
})
