const mockQuery = jest.fn()
const mockRelease = jest.fn()

jest.mock('@/lib/ingest/db', () => ({
  ingestClientConnect: jest.fn(async () => ({ query: mockQuery, release: mockRelease })),
}))

import { runHistoryTransaction } from '../history-transaction'

describe('history transaction boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('commits one successful operation and releases a reusable client', async () => {
    await expect(runHistoryTransaction(async () => 'written')).resolves.toBe('written')

    expect(mockQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT'])
    expect(mockRelease).toHaveBeenCalledWith(false)
  })

  it('rolls back a known pre-commit failure', async () => {
    const failure = new Error('history insert failed')

    await expect(
      runHistoryTransaction(async () => {
        throw failure
      })
    ).rejects.toBe(failure)

    expect(mockQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK'])
    expect(mockRelease).toHaveBeenCalledWith(false)
  })

  it('never rolls back or reuses a client after an ambiguous COMMIT failure', async () => {
    const failure = new Error('connection lost during commit')
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql === 'COMMIT') throw failure
      return { rows: [], rowCount: 0 }
    })

    await expect(runHistoryTransaction(async () => 'written')).rejects.toBe(failure)

    expect(mockQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT'])
    expect(mockRelease).toHaveBeenCalledWith(true)
  })

  it('surfaces both the body and rollback failures and destroys the client', async () => {
    const bodyFailure = new Error('history insert failed')
    const rollbackFailure = new Error('rollback connection lost')
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql === 'ROLLBACK') throw rollbackFailure
      return { rows: [], rowCount: 0 }
    })

    const result = runHistoryTransaction(async () => {
      throw bodyFailure
    })
    await expect(result).rejects.toBeInstanceOf(AggregateError)
    await expect(result).rejects.toMatchObject({
      errors: [bodyFailure, rollbackFailure],
    })

    expect(mockRelease).toHaveBeenCalledWith(true)
  })
})
