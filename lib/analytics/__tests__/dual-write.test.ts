/**
 * Tests for dual-write adapter (Supabase + ClickHouse).
 * Verifies that ClickHouse failures never propagate to callers.
 *
 * NOTE: We test syncToClickHouse by observing its side-effects rather than
 * mocking the clickhouse module, because Jest resolves relative imports
 * from dual-write.ts and the test file to different module cache keys.
 */

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  logger: {
    child: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }),
  },
  default: {
    child: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }),
  },
}))

jest.mock('@/lib/utils/logger', () => {
  const inst = {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  }
  return {
    __esModule: true,
    logger: inst,
    default: inst,
    createLogger: jest.fn(() => inst),
  }
})

import { syncToClickHouse } from '../dual-write'

describe('syncToClickHouse', () => {
  const originalEnv = process.env

  beforeEach(() => {
    jest.clearAllMocks()
    // ClickHouse is NOT available when env vars are missing (default test env)
    process.env = { ...originalEnv }
    delete process.env.CLICKHOUSE_URL
    delete process.env.CLICKHOUSE_DATABASE
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it('is a no-op when ClickHouse is not available (no env vars)', async () => {
    // No CLICKHOUSE_URL set → isClickHouseAvailable() returns false → no-op
    await expect(
      syncToClickHouse('test_table', [{ id: '1', name: 'test' }])
    ).resolves.toBeUndefined()
  })

  it('is a no-op when rows array is empty', async () => {
    await expect(
      syncToClickHouse('test_table', [])
    ).resolves.toBeUndefined()
  })

  it('does not throw when ClickHouse is available but insertBatch fails', async () => {
    // Set env to make isClickHouseAvailable() return true
    process.env.CLICKHOUSE_URL = 'http://localhost:8123'
    process.env.CLICKHOUSE_DATABASE = 'arena_test'

    // insertBatch will fail because @clickhouse/client is not installed in test env
    // The try/catch in syncToClickHouse should swallow the error
    await expect(
      syncToClickHouse('metrics', [{ id: '1', value: 100 }])
    ).resolves.toBeUndefined()
  })

  it('returns void (never throws) regardless of input', async () => {
    // Verify the fire-and-forget contract
    await expect(
      syncToClickHouse('metrics', [{ id: '1' }])
    ).resolves.toBeUndefined()
  })

  it('handles large batches without throwing', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: String(i), value: i }))
    await expect(
      syncToClickHouse('metrics', rows)
    ).resolves.toBeUndefined()
  })
})
