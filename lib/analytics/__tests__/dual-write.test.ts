/**
 * Tests for the Supabase-primary / ClickHouse-secondary write boundary.
 * The ClickHouse adapter is mocked explicitly so this suite can never open a
 * socket, even when CLICKHOUSE_URL is present in the developer environment.
 */

const mockClickHouseAvailable = jest.fn<() => boolean>()
const mockInsertBatch =
  jest.fn<(table: string, rows: Record<string, unknown>[]) => Promise<number>>()
const mockInfo = jest.fn()
const mockWarn = jest.fn()

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  logger: {
    child: () => ({
      info: (...args: unknown[]) => mockInfo(...args),
      warn: (...args: unknown[]) => mockWarn(...args),
      error: jest.fn(),
    }),
  },
}))

jest.mock('../clickhouse', () => ({
  __esModule: true,
  isClickHouseAvailable: () => mockClickHouseAvailable(),
  insertBatch: (table: string, rows: Record<string, unknown>[]) => mockInsertBatch(table, rows),
}))

// jest.setup.js replaces the public alias globally. Restore the real adapter
// for this focused suite while retaining the explicit low-level client mock.
jest.mock('@/lib/analytics/dual-write', () => jest.requireActual('@/lib/analytics/dual-write'))

import { syncToClickHouse } from '../dual-write'

describe('syncToClickHouse', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockClickHouseAvailable.mockReturnValue(false)
    mockInsertBatch.mockResolvedValue(0)
  })

  it('does not initialize the client when ClickHouse is not configured', async () => {
    await expect(
      syncToClickHouse('test_table', [{ id: '1', name: 'test' }])
    ).resolves.toBeUndefined()

    expect(mockInsertBatch).not.toHaveBeenCalled()
  })

  it('does not initialize the client for an empty batch', async () => {
    mockClickHouseAvailable.mockReturnValue(true)

    await expect(syncToClickHouse('test_table', [])).resolves.toBeUndefined()

    expect(mockInsertBatch).not.toHaveBeenCalled()
  })

  it('isolates a configured client initialization failure from the primary write path', async () => {
    mockClickHouseAvailable.mockReturnValue(true)
    mockInsertBatch.mockRejectedValueOnce(
      new Error('ClickHouse is configured but the client could not be initialized')
    )

    await expect(syncToClickHouse('metrics', [{ id: '1', value: 100 }])).resolves.toBeUndefined()

    expect(mockWarn).toHaveBeenCalledWith(
      'Failed to sync 1 rows to metrics:',
      'ClickHouse is configured but the client could not be initialized'
    )
  })

  it('isolates an insert failure from the primary write path', async () => {
    mockClickHouseAvailable.mockReturnValue(true)
    mockInsertBatch.mockRejectedValueOnce(new Error('insert rejected'))

    await expect(syncToClickHouse('metrics', [{ id: '1' }])).resolves.toBeUndefined()

    expect(mockWarn).toHaveBeenCalledWith('Failed to sync 1 rows to metrics:', 'insert rejected')
  })

  it('records the successful secondary-write count', async () => {
    const rows = [
      { id: '1', value: 1 },
      { id: '2', value: 2 },
    ]
    mockClickHouseAvailable.mockReturnValue(true)
    mockInsertBatch.mockResolvedValueOnce(rows.length)

    await expect(syncToClickHouse('metrics', rows)).resolves.toBeUndefined()

    expect(mockInsertBatch).toHaveBeenCalledWith('metrics', rows)
    expect(mockInfo).toHaveBeenCalledWith('Synced 2 rows to metrics')
  })
})
