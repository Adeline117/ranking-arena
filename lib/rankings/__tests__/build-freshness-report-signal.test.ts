const mockRpc = jest.fn()
const mockFrom = jest.fn()
const mockBuildRegistrySourceFreshnessStatuses = jest.fn()
const observedSignals: AbortSignal[] = []

function abortableResult<T>(value: T) {
  return {
    abortSignal(signal: AbortSignal) {
      observedSignals.push(signal)
      return Promise.resolve(value)
    },
  }
}

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
  }),
}))

jest.mock('@/lib/data/visible-leaderboard-sources', () => ({
  parseVisibleLeaderboardSources: () => [],
}))

jest.mock('@/lib/rankings/source-freshness', () => ({
  parseExpectedSourceWindows: () => [],
  buildRegistrySourceFreshnessStatuses: (...args: unknown[]) =>
    mockBuildRegistrySourceFreshnessStatuses(...args),
}))

describe('buildFreshnessReport abort propagation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    observedSignals.length = 0
    mockBuildRegistrySourceFreshnessStatuses.mockReturnValue([])
    mockRpc.mockImplementation(() => abortableResult({ data: [], error: null }))
    mockFrom.mockReturnValue({
      select: () => ({
        in: () => abortableResult({ data: [], error: null }),
      }),
    })
  })

  it('passes the request signal to all five freshness authority queries', async () => {
    const { buildFreshnessReport } = await import('../build-freshness-report')
    const signal = new AbortController().signal

    await expect(buildFreshnessReport(signal)).resolves.toMatchObject({
      ok: true,
      summary: { total: 0 },
    })

    expect(observedSignals).toHaveLength(5)
    expect(observedSignals.every((observed) => observed === signal)).toBe(true)
  })

  it('runtime-parses publication fields that are ahead of the generated schema', async () => {
    const runtimeRow = {
      season_id: '90D',
      source: 'binance',
      source_as_of: '2026-08-03T15:00:00.000Z',
      recorded_at: '2026-08-03T16:00:00.000Z',
      score_cohort_id: 'cohort-1',
      published_rank_count: 10,
    }
    mockFrom.mockReturnValueOnce({
      select: () => ({
        in: () => abortableResult({ data: [runtimeRow], error: null }),
      }),
    })

    const { buildFreshnessReport } = await import('../build-freshness-report')
    await buildFreshnessReport(new AbortController().signal)

    expect(mockBuildRegistrySourceFreshnessStatuses).toHaveBeenCalledWith(
      [],
      [],
      [runtimeRow],
      expect.any(Number)
    )
  })

  it('rejects non-object rows at the local database boundary', async () => {
    mockFrom.mockReturnValueOnce({
      select: () => ({
        in: () => abortableResult({ data: [null], error: null }),
      }),
    })

    const { buildFreshnessReport } = await import('../build-freshness-report')

    await expect(buildFreshnessReport(new AbortController().signal)).rejects.toThrow(
      'source watermark freshness row 0 is not an object'
    )
  })
})
