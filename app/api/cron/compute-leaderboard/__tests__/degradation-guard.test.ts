/**
 * @jest-environment node
 */

const mockStateGet = jest.fn()
const mockStateSet = jest.fn()
const mockStateDel = jest.fn()
const mockSendAlert = jest.fn().mockResolvedValue(undefined)

jest.mock('@/lib/services/pipeline-state', () => ({
  PipelineState: {
    get: (...args: unknown[]) => mockStateGet(...args),
    set: (...args: unknown[]) => mockStateSet(...args),
    del: (...args: unknown[]) => mockStateDel(...args),
  },
}))

jest.mock('@/lib/alerts/send-alert', () => ({
  sendRateLimitedAlert: (...args: unknown[]) => mockSendAlert(...args),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

import { checkDegradationGuard } from '../degradation-guard'

function supabaseWithExpectedCount(expectedCount: number) {
  return {
    rpc: jest.fn().mockResolvedValue({
      data: [{ source: 'binance_futures', expected_count: expectedCount }],
      error: null,
    }),
    from: jest.fn(),
  }
}

function supabaseWithSourceCounts(rows: Array<{ source: string; expected_count: number }>) {
  return {
    rpc: jest.fn().mockResolvedValue({ data: rows, error: null }),
    from: jest.fn(),
  }
}

describe('leaderboard degradation last-good gate', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockStateGet.mockResolvedValue(undefined)
    mockStateSet.mockResolvedValue(undefined)
    mockStateDel.mockResolvedValue(undefined)
  })

  it('skips the first degraded cohort and preserves last-good state', async () => {
    const supabase = supabaseWithExpectedCount(1_000)

    await expect(
      checkDegradationGuard({
        supabase: supabase as never,
        season: '30D',
        scoredCount: 400,
        scoredCountBySource: new Map([['binance_futures', 400]]),
        freshPlatforms: ['binance_futures'],
        forceWrite: false,
      })
    ).resolves.toEqual({ action: 'skip' })

    expect(mockStateSet).toHaveBeenCalledWith('leaderboard:degradation-skips:30D', 1)
    expect(mockStateDel).not.toHaveBeenCalled()
    expect(mockSendAlert).toHaveBeenCalledTimes(1)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('never auto-publishes a degraded cohort after repeated skips', async () => {
    mockStateGet.mockResolvedValue(25)

    await expect(
      checkDegradationGuard({
        supabase: supabaseWithExpectedCount(1_000) as never,
        season: '90D',
        scoredCount: 100,
        scoredCountBySource: new Map([['binance_futures', 100]]),
        freshPlatforms: ['binance_futures'],
        forceWrite: false,
      })
    ).resolves.toEqual({ action: 'skip' })

    expect(mockStateSet).toHaveBeenCalledWith('leaderboard:degradation-skips:90D', 26)
    expect(mockStateDel).not.toHaveBeenCalled()
  })

  it('skips when one established source collapses despite a healthy global ratio', async () => {
    const supabase = supabaseWithSourceCounts([
      { source: 'binance_futures', expected_count: 1_000 },
      { source: 'hyperliquid', expected_count: 1_000 },
    ])

    await expect(
      checkDegradationGuard({
        supabase: supabase as never,
        season: '30D',
        scoredCount: 1_500,
        scoredCountBySource: new Map([
          ['binance_futures', 1_000],
          ['hyperliquid', 500],
        ]),
        freshPlatforms: ['binance_futures', 'hyperliquid'],
        forceWrite: false,
      })
    ).resolves.toEqual({ action: 'skip' })

    expect(mockStateSet).toHaveBeenCalledWith('leaderboard:degradation-skips:30D', 1)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('prefers the positive-score count-cache cohort over the legacy score-above-10 count', async () => {
    const supabase = supabaseWithSourceCounts([
      { source: 'binance_futures', expected_count: 50 },
      { source: 'binance_futures_gt0', expected_count: 200 },
    ])

    await expect(
      checkDegradationGuard({
        supabase: supabase as never,
        season: '30D',
        scoredCount: 80,
        scoredCountBySource: new Map([['binance_futures', 80]]),
        freshPlatforms: ['binance_futures'],
        forceWrite: false,
      })
    ).resolves.toEqual({ action: 'skip' })
  })

  it('protects a small established source from destructive cleanup too', async () => {
    const supabase = supabaseWithSourceCounts([
      { source: 'binance_futures_gt0', expected_count: 2 },
    ])

    await expect(
      checkDegradationGuard({
        supabase: supabase as never,
        season: '7D',
        scoredCount: 1,
        scoredCountBySource: new Map([['binance_futures', 1]]),
        freshPlatforms: ['binance_futures'],
        forceWrite: false,
      })
    ).resolves.toEqual({ action: 'skip' })
  })

  it('fails closed when per-source counts do not equal the publication cohort', async () => {
    await expect(
      checkDegradationGuard({
        supabase: supabaseWithExpectedCount(1_000) as never,
        season: '30D',
        scoredCount: 1_500,
        scoredCountBySource: new Map([['binance_futures', 1_000]]),
        freshPlatforms: ['binance_futures'],
        forceWrite: false,
      })
    ).resolves.toEqual({ action: 'skip' })

    expect(mockSendAlert).toHaveBeenCalledTimes(1)
    expect(mockStateDel).not.toHaveBeenCalled()
  })

  it('never substitutes a global count for missing per-source authority', async () => {
    const supabase = supabaseWithSourceCounts([])
    mockStateGet.mockResolvedValue(1_000)

    await expect(
      checkDegradationGuard({
        supabase: supabase as never,
        season: '7D',
        scoredCount: 1_000,
        scoredCountBySource: new Map([['binance_futures', 1_000]]),
        freshPlatforms: ['binance_futures'],
        forceWrite: false,
      })
    ).resolves.toEqual({ action: 'skip' })

    expect(mockStateGet).not.toHaveBeenCalled()
    expect(mockStateSet).not.toHaveBeenCalled()
    expect(mockSendAlert).toHaveBeenCalledTimes(1)
  })

  it('fails closed when any fresh source lacks its own baseline despite a healthy global total', async () => {
    const supabase = supabaseWithSourceCounts([
      { source: 'binance_futures_gt0', expected_count: 1_000 },
    ])
    mockStateGet.mockResolvedValue(2_000)

    await expect(
      checkDegradationGuard({
        supabase: supabase as never,
        season: '30D',
        scoredCount: 2_000,
        scoredCountBySource: new Map([
          ['binance_futures', 1_000],
          ['hyperliquid', 1_000],
        ]),
        freshPlatforms: ['binance_futures', 'hyperliquid'],
        forceWrite: false,
      })
    ).resolves.toEqual({ action: 'skip' })

    expect(mockStateGet).not.toHaveBeenCalled()
    expect(mockStateSet).not.toHaveBeenCalled()
    expect(mockSendAlert).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the expected-count authority returns an error', async () => {
    const supabase = {
      rpc: jest.fn().mockResolvedValue({
        data: null,
        error: { message: 'count cache unavailable' },
      }),
      from: jest.fn(),
    }

    await expect(
      checkDegradationGuard({
        supabase: supabase as never,
        season: '90D',
        scoredCount: 10_000,
        scoredCountBySource: new Map([['binance_futures', 10_000]]),
        freshPlatforms: ['binance_futures'],
        forceWrite: false,
      })
    ).resolves.toEqual({ action: 'skip' })

    expect(mockStateSet).not.toHaveBeenCalled()
    expect(mockSendAlert).toHaveBeenCalledTimes(1)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('requires explicit force to bootstrap when every trusted baseline is absent', async () => {
    const supabase = supabaseWithSourceCounts([])

    await expect(
      checkDegradationGuard({
        supabase: supabase as never,
        season: '30D',
        scoredCount: 10_000,
        scoredCountBySource: new Map([['binance_futures', 10_000]]),
        freshPlatforms: ['binance_futures'],
        forceWrite: false,
      })
    ).resolves.toEqual({ action: 'skip' })

    expect(mockSendAlert).toHaveBeenCalledTimes(1)
    expect(mockStateDel).not.toHaveBeenCalled()
  })

  it('allows explicit force to bootstrap without consulting baseline authority', async () => {
    const supabase = supabaseWithSourceCounts([])

    await expect(
      checkDegradationGuard({
        supabase: supabase as never,
        season: '30D',
        scoredCount: 10_000,
        scoredCountBySource: new Map([['binance_futures', 10_000]]),
        freshPlatforms: ['binance_futures'],
        forceWrite: true,
      })
    ).resolves.toEqual({ action: 'force' })

    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(mockStateGet).not.toHaveBeenCalled()
    expect(mockSendAlert).not.toHaveBeenCalled()
  })

  it('still permits an explicit force and resets the counter after a healthy cohort', async () => {
    const supabase = supabaseWithExpectedCount(1_000)
    await expect(
      checkDegradationGuard({
        supabase: supabase as never,
        season: '7D',
        scoredCount: 100,
        scoredCountBySource: new Map([['binance_futures', 100]]),
        freshPlatforms: ['binance_futures'],
        forceWrite: true,
      })
    ).resolves.toEqual({ action: 'force' })

    await expect(
      checkDegradationGuard({
        supabase: supabase as never,
        season: '7D',
        scoredCount: 800,
        scoredCountBySource: new Map([['binance_futures', 800]]),
        freshPlatforms: ['binance_futures'],
        forceWrite: false,
      })
    ).resolves.toEqual({ action: 'proceed' })
    expect(mockStateDel).toHaveBeenCalledWith('leaderboard:degradation-skips:7D')
  })
})
