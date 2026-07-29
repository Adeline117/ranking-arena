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
})

describe('degradation route contract', () => {
  const route = readFileSync(join(__dirname, '..', 'route.ts'), 'utf8')
  const guard = readFileSync(join(__dirname, '..', 'degradation-guard.ts'), 'utf8')

  test('authenticates before reading force=1 and returns before ranking mutation on skip', () => {
    const authIndex = route.indexOf('if (!verifyCronSecret(request))')
    const forceIndex = route.indexOf("searchParams.get('force') === '1'")
    const guardIndex = route.indexOf('await checkDegradationGuard({')
    const skipIndex = route.indexOf("if (degradation.action === 'skip') return -1")
    const writeIndex = route.indexOf('await publishAtomicRankGeneration({')

    expect(authIndex).toBeGreaterThan(-1)
    expect(forceIndex).toBeGreaterThan(authIndex)
    expect(guardIndex).toBeGreaterThan(forceIndex)
    expect(skipIndex).toBeGreaterThan(guardIndex)
    expect(writeIndex).toBeGreaterThan(skipIndex)
  })

  test('contains no automatic force or cleanup path', () => {
    expect(guard).not.toContain('MAX_CONSECUTIVE_SKIPS')
    expect(guard).not.toContain('cleanupStaleRows')
    expect(guard.match(/return \{ action: 'force' \}/g)).toHaveLength(1)
    expect(guard).toContain('if (forceWrite)')
  })
})
