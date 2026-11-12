/**
 * B2 (docs/DATA_RESUME_PLAN_2026-11.md): arena-worker's Redis must be gated by
 * the ranking command-chain constant, not the ingest constant. Publishing only
 * the ranking chain must start its queue; ingest Redis must stay closed.
 */
const mockRedisInstance = {
  on: jest.fn(),
  quit: jest.fn().mockResolvedValue('OK'),
}
const mockRedisConstructor = jest.fn(() => mockRedisInstance)
const mockNodeRequire = jest.fn(() => ({ default: mockRedisConstructor }))
const mockGates = { ingest: false, ranking: true }

jest.mock('node:module', () => ({
  createRequire: () => mockNodeRequire,
}))

jest.mock('@/lib/ingest/v1-execution-publication', () => ({
  isV1IngestExecutionPublished: jest.fn(() => mockGates.ingest),
  assertV1IngestExecutionPublished: jest.fn(() => {
    if (!mockGates.ingest) {
      throw Object.assign(new Error('V1 ingest execution is not published'), {
        code: 'INGEST_EXECUTION_NOT_PUBLISHED',
      })
    }
  }),
}))

jest.mock('@/lib/cron/v1-ranking-command-chain-publication', () => ({
  V1_RANKING_COMMAND_CHAIN_NOT_PUBLISHED_CODE: 'RANKING_COMMAND_CHAIN_NOT_PUBLISHED',
  isV1RankingCommandChainPublished: jest.fn(() => mockGates.ranking),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const connection = require('../connection') as typeof import('../connection')

describe('ranking command-chain Redis gate', () => {
  const originalUrl = process.env.REDIS_URL

  beforeEach(() => {
    process.env.REDIS_URL = 'redis://127.0.0.1:6379/15'
    mockRedisConstructor.mockClear()
    mockRedisInstance.quit.mockClear()
  })

  afterEach(async () => {
    mockGates.ranking = true
    await connection.closeRankingCommandChainConnection()
    if (originalUrl === undefined) delete process.env.REDIS_URL
    else process.env.REDIS_URL = originalUrl
  })

  test('ranking published + ingest unpublished: ranking Redis opens, ingest Redis refuses', () => {
    mockGates.ingest = false
    mockGates.ranking = true

    expect(() => connection.getRankingCommandChainConnection()).not.toThrow()
    expect(mockRedisConstructor).toHaveBeenCalledTimes(1)
    expect(() => connection.getConnection()).toThrow(/ingest execution is not published/)
    expect(mockRedisConstructor).toHaveBeenCalledTimes(1)
  })

  test('ranking unpublished: no Redis client is constructed and close sends nothing', async () => {
    mockGates.ranking = false

    expect(() => connection.getRankingCommandChainConnection()).toThrow(
      expect.objectContaining({ code: 'RANKING_COMMAND_CHAIN_NOT_PUBLISHED' })
    )
    expect(mockRedisConstructor).not.toHaveBeenCalled()
    await connection.closeRankingCommandChainConnection()
    expect(mockRedisInstance.quit).not.toHaveBeenCalled()
  })

  test('the ranking client is reused and closed through its own lifecycle', async () => {
    const first = connection.getRankingCommandChainConnection()
    const second = connection.getRankingCommandChainConnection()
    expect(second).toBe(first)
    expect(mockRedisConstructor).toHaveBeenCalledTimes(1)
    await connection.closeRankingCommandChainConnection()
    expect(mockRedisInstance.quit).toHaveBeenCalledTimes(1)
  })
})
