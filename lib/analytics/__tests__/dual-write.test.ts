/**
 * Tests for dual-write adapter (Supabase + ClickHouse).
 * Verifies that ClickHouse failures never propagate to callers.
 */

const mockInsertBatch = jest.fn()
const mockIsAvailable = jest.fn()

jest.mock('../clickhouse', () => ({
  isClickHouseAvailable: () => mockIsAvailable(),
  insertBatch: (...args: unknown[]) => mockInsertBatch(...args),
}))

jest.mock('@/lib/logger', () => ({
  logger: {
    child: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }),
  },
}))

import { syncToClickHouse } from '../dual-write'

describe('syncToClickHouse', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('is a no-op when ClickHouse is not available', async () => {
    mockIsAvailable.mockReturnValue(false)

    await syncToClickHouse('test_table', [{ id: '1', name: 'test' }])

    expect(mockInsertBatch).not.toHaveBeenCalled()
  })

  it('is a no-op when rows array is empty', async () => {
    mockIsAvailable.mockReturnValue(true)

    await syncToClickHouse('test_table', [])

    expect(mockInsertBatch).not.toHaveBeenCalled()
  })

  it('calls insertBatch when ClickHouse is available and rows are provided', async () => {
    mockIsAvailable.mockReturnValue(true)
    mockInsertBatch.mockResolvedValue(2)

    const rows = [
      { id: '1', value: 100 },
      { id: '2', value: 200 },
    ]

    await syncToClickHouse('metrics', rows)

    expect(mockInsertBatch).toHaveBeenCalledWith('metrics', rows)
  })

  it('does not throw when insertBatch fails', async () => {
    mockIsAvailable.mockReturnValue(true)
    mockInsertBatch.mockRejectedValue(new Error('ClickHouse connection timeout'))

    // Should not throw
    await expect(
      syncToClickHouse('metrics', [{ id: '1' }])
    ).resolves.toBeUndefined()
  })

  it('does not throw when insertBatch throws non-Error', async () => {
    mockIsAvailable.mockReturnValue(true)
    mockInsertBatch.mockRejectedValue('string error')

    await expect(
      syncToClickHouse('metrics', [{ id: '1' }])
    ).resolves.toBeUndefined()
  })
})
