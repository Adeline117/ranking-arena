const mockRpc = jest.fn()
const mockFrom = jest.fn()
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
  buildRegistrySourceFreshnessStatuses: () => [],
}))

describe('buildFreshnessReport abort propagation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    observedSignals.length = 0
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
})
