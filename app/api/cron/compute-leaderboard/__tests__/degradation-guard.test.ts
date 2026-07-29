import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { PipelineState } from '@/lib/services/pipeline-state'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { checkDegradationGuard } from '../degradation-guard'

jest.mock('@/lib/services/pipeline-state', () => ({
  PipelineState: {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
  },
}))

jest.mock('@/lib/alerts/send-alert', () => ({
  sendRateLimitedAlert: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}))

const mockGet = jest.mocked(PipelineState.get)
const mockSet = jest.mocked(PipelineState.set)
const mockDel = jest.mocked(PipelineState.del)
const mockAlert = jest.mocked(sendRateLimitedAlert)

function supabaseWithExpectedCount(expectedCount?: number) {
  const from = jest.fn()
  const rpc = jest.fn().mockResolvedValue({
    data:
      expectedCount === undefined
        ? []
        : [{ source: 'binance_futures', expected_count: expectedCount }],
    error: null,
  })
  return { client: { rpc, from } as never, rpc, from }
}

describe('compute leaderboard degradation guard', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGet.mockResolvedValue(undefined)
    mockSet.mockResolvedValue(undefined)
    mockDel.mockResolvedValue(undefined)
  })

  test('the first degraded run skips even for a baseline below 500', async () => {
    const { client, from } = supabaseWithExpectedCount(100)

    await expect(
      checkDegradationGuard({
        supabase: client,
        season: '90D',
        scoredCount: 59,
        freshPlatforms: ['binance_futures'],
        forceWrite: false,
      })
    ).resolves.toEqual({ action: 'skip' })

    expect(mockSet).toHaveBeenCalledWith('leaderboard:degradation-skips:90D', 1)
    expect(mockAlert).toHaveBeenCalledTimes(1)
    expect(from).not.toHaveBeenCalled()
  })

  test('repeated degraded runs keep skipping and never auto-force', async () => {
    const { client } = supabaseWithExpectedCount(1_000)
    mockGet.mockResolvedValue(7)

    await expect(
      checkDegradationGuard({
        supabase: client,
        season: '30D',
        scoredCount: 100,
        freshPlatforms: ['binance_futures'],
        forceWrite: false,
      })
    ).resolves.toEqual({ action: 'skip' })

    expect(mockSet).toHaveBeenCalledWith('leaderboard:degradation-skips:30D', 8)
    expect(mockDel).not.toHaveBeenCalled()
  })

  test('uses the full previous table count as fallback baseline', async () => {
    const { client } = supabaseWithExpectedCount()
    mockGet.mockImplementation(async (key: string) =>
      key === 'leaderboard:last-scored-count:7D' ? undefined : 0
    )

    await expect(
      checkDegradationGuard({
        supabase: client,
        season: '7D',
        scoredCount: 59,
        freshPlatforms: [],
        forceWrite: false,
        previousCount: 100,
      })
    ).resolves.toEqual({ action: 'skip' })
  })

  test('fails closed when the expected baseline is unknown and scoring returns zero', async () => {
    const { client, from } = supabaseWithExpectedCount()

    await expect(
      checkDegradationGuard({
        supabase: client,
        season: '7D',
        scoredCount: 0,
        freshPlatforms: [],
        forceWrite: false,
      })
    ).resolves.toEqual({ action: 'skip' })

    expect(from).not.toHaveBeenCalled()
    expect(mockAlert).toHaveBeenCalledTimes(1)
  })

  test('fails closed when every baseline is unknown even if scoring returns rows', async () => {
    const { client } = supabaseWithExpectedCount()

    await expect(
      checkDegradationGuard({
        supabase: client,
        season: '30D',
        scoredCount: 250,
        freshPlatforms: ['binance_futures'],
        forceWrite: false,
      })
    ).resolves.toEqual({ action: 'skip' })

    expect(mockDel).not.toHaveBeenCalled()
    expect(mockAlert).toHaveBeenCalledTimes(1)
  })

  test('treats a resolved expected-count RPC error as unavailable authority', async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: null,
      error: { message: 'expected-count authority unavailable' },
    })
    const client = { rpc } as never

    await expect(
      checkDegradationGuard({
        supabase: client,
        season: '7D',
        scoredCount: 250,
        freshPlatforms: ['binance_futures'],
        forceWrite: false,
      })
    ).resolves.toEqual({ action: 'skip' })

    expect(mockAlert).toHaveBeenCalledTimes(1)
  })

  test('only an explicit force override may bypass known degradation', async () => {
    const { client } = supabaseWithExpectedCount(1_000)

    await expect(
      checkDegradationGuard({
        supabase: client,
        season: '90D',
        scoredCount: 0,
        freshPlatforms: ['binance_futures'],
        forceWrite: true,
      })
    ).resolves.toEqual({ action: 'force' })

    expect(mockSet).not.toHaveBeenCalled()
    expect(mockAlert).not.toHaveBeenCalled()
  })

  test('skips when one source collapses even if the aggregate count remains healthy', async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: [
        { source: 'large', expected_count: 900 },
        { source: 'collapsed', expected_count: 100 },
      ],
      error: null,
    })

    await expect(
      checkDegradationGuard({
        supabase: { rpc } as never,
        season: '30D',
        scoredCount: 900,
        publishedCountsBySource: { large: 900, collapsed: 0 },
        freshPlatforms: ['large', 'collapsed'],
        forceWrite: false,
      })
    ).resolves.toEqual({ action: 'skip' })

    expect(mockAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          degradedSources: [{ source: 'collapsed', published: 0, expected: 100, ratio: 0 }],
        }),
      }),
      'leaderboard-degrade:30D',
      60 * 60 * 1000
    )
  })
})

describe('degradation route contract', () => {
  const route = readFileSync(join(__dirname, '..', 'route.ts'), 'utf8')
  const guard = readFileSync(join(__dirname, '..', 'degradation-guard.ts'), 'utf8')

  test('authenticates before reading force=1 and guards the exact PG cohort before mutation', () => {
    const authIndex = route.indexOf('if (!verifyCronSecret(request))')
    const forceIndex = route.indexOf("searchParams.get('force') === '1'")
    const writeIndex = route.indexOf('await publishAtomicRankGeneration({')
    const authorizationIndex = route.indexOf(
      'authorizePublication: async ({ publishedCount, publishedCountsBySource }) => {'
    )
    const guardIndex = route.indexOf('await checkDegradationGuard({', authorizationIndex)
    const skipIndex = route.indexOf('if (!publication) return -1', guardIndex)

    expect(authIndex).toBeGreaterThan(-1)
    expect(forceIndex).toBeGreaterThan(authIndex)
    expect(writeIndex).toBeGreaterThan(forceIndex)
    expect(authorizationIndex).toBeGreaterThan(writeIndex)
    expect(guardIndex).toBeGreaterThan(authorizationIndex)
    expect(skipIndex).toBeGreaterThan(guardIndex)
  })

  test('contains no automatic force or cleanup path', () => {
    expect(guard).not.toContain('MAX_CONSECUTIVE_SKIPS')
    expect(guard).not.toContain('cleanupStaleRows')
    expect(guard.match(/return \{ action: 'force' \}/g)).toHaveLength(1)
    expect(guard).toContain('if (forceWrite)')
  })

  test('guards PostgreSQL exact output while publishing only the trust-filtered input', () => {
    const scoreIndex = route.indexOf('const { scored, scoredFiltered } = await scoreTraders(')
    const publishIndex = route.indexOf('await publishAtomicRankGeneration({', scoreIndex)
    const authorizationIndex = route.indexOf(
      'authorizePublication: async ({ publishedCount, publishedCountsBySource }) => {',
      publishIndex
    )
    const guardIndex = route.indexOf('await checkDegradationGuard({', authorizationIndex)
    const skipIndex = route.indexOf('if (!publication) return -1', guardIndex)
    const saveIndex = route.indexOf(
      'await saveScoredCount(season, publication.publishedCount)',
      skipIndex
    )

    expect(scoreIndex).toBeGreaterThan(-1)
    expect(route.slice(publishIndex, authorizationIndex)).toContain('scoredTraders: scoredFiltered')
    expect(route.slice(guardIndex, skipIndex)).toContain('scoredCount: publishedCount')
    expect(route.slice(guardIndex, skipIndex)).toContain('publishedCountsBySource')
    expect(saveIndex).toBeGreaterThan(skipIndex)
    expect(route).not.toContain('scoredCount: scored.length')
    expect(route).not.toContain('scoredCount: scoredFiltered.length')
    expect(route).not.toContain('saveScoredCount(season, scored.length)')
  })
})
