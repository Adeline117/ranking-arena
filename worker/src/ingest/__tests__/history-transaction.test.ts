const mockQuery = jest.fn()
const mockRelease = jest.fn()
const mockConnect = jest.fn()

jest.mock('@/lib/ingest/db', () => ({
  ingestClientConnect: (...args: unknown[]) => mockConnect(...args),
}))

import {
  getHistoryTransactionFailure,
  isHistoryTransactionError,
  runHistoryTransaction,
} from '../history-transaction'

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (cause) {
    return cause
  }
  throw new Error('expected promise to reject')
}

describe('history transaction boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockConnect.mockResolvedValue({ query: mockQuery, release: mockRelease })
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('commits one successful operation and releases a reusable client', async () => {
    await expect(runHistoryTransaction(async () => 'written')).resolves.toBe('written')

    expect(mockQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT'])
    expect(mockRelease).toHaveBeenCalledWith(false)
  })

  it('classifies connect failure before any client or transaction exists', async () => {
    const failure = new Error('pool checkout failed')
    mockConnect.mockRejectedValueOnce(failure)

    const caught = await rejection(runHistoryTransaction(async () => 'never reached'))

    expect(caught).toBe(failure)
    expect(getHistoryTransactionFailure(caught)).toMatchObject({
      code: 'history_transaction_failed',
      stage: 'connect',
      primaryStage: 'connect',
      failedStages: ['connect'],
      outcome: 'not_committed',
      outcomeAmbiguous: false,
      replayPolicy: 'caller_decides',
      primaryCause: failure,
      clientDisposition: 'not_acquired',
      destroyRequested: false,
      releaseSucceeded: null,
    })
    expect(mockQuery).not.toHaveBeenCalled()
    expect(mockRelease).not.toHaveBeenCalled()
  })

  it('does not trust caller-forged or transplanted transaction failure metadata', async () => {
    const forged = Object.assign(new Error('forged'), {
      historyTransactionFailure: {
        contract: 'arena.ingest.history-transaction-failure@1',
        code: 'history_transaction_failed',
        outcome: 'ambiguous',
        replayPolicy: 'exact_input_only',
      },
    })

    expect(getHistoryTransactionFailure(forged)).toBeUndefined()
    expect(isHistoryTransactionError(forged)).toBe(false)

    const genuineCause = new Error('genuine checkout failure')
    mockConnect.mockRejectedValueOnce(genuineCause)
    const genuine = await rejection(runHistoryTransaction(async () => 'never reached'))
    const genuineContract = getHistoryTransactionFailure(genuine)
    expect(genuineContract).toBeDefined()

    const transplanted = Object.assign(new Error('transplanted'), {
      historyTransactionFailure: genuineContract,
    })
    expect(getHistoryTransactionFailure(transplanted)).toBeUndefined()
    expect(isHistoryTransactionError(transplanted)).toBe(false)
  })

  it('rolls back a known pre-commit operation failure', async () => {
    const failure = new Error('history insert failed')

    const caught = await rejection(
      runHistoryTransaction(async () => {
        throw failure
      })
    )

    expect(caught).toBe(failure)
    expect(getHistoryTransactionFailure(caught)).toMatchObject({
      stage: 'operation',
      primaryStage: 'operation',
      failedStages: ['operation'],
      outcome: 'not_committed',
      outcomeAmbiguous: false,
      primaryCause: failure,
      clientDisposition: 'released_reusable',
      destroyRequested: false,
      releaseSucceeded: true,
    })
    expect(mockQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK'])
    expect(mockRelease).toHaveBeenCalledWith(false)
  })

  it('marks BEGIN failure not committed and destroys the uncertain client', async () => {
    const failure = new Error('connection lost during begin')
    mockQuery.mockRejectedValueOnce(failure)

    const caught = await rejection(runHistoryTransaction(async () => 'never reached'))

    expect(caught).toBe(failure)
    expect(isHistoryTransactionError(caught)).toBe(true)
    expect(getHistoryTransactionFailure(caught)).toMatchObject({
      stage: 'begin',
      primaryStage: 'begin',
      failedStages: ['begin'],
      outcome: 'not_committed',
      outcomeAmbiguous: false,
      replayPolicy: 'caller_decides',
      primaryCause: failure,
      clientDisposition: 'destroyed',
      destroyRequested: true,
      releaseSucceeded: true,
    })
    expect(mockQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN'])
    expect(mockRelease).toHaveBeenCalledWith(true)
  })

  it('marks a rejected COMMIT ambiguous and permits only exact-input replay', async () => {
    const failure = new Error('connection lost during commit')
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql === 'COMMIT') throw failure
      return { rows: [], rowCount: 0 }
    })

    const caught = await rejection(runHistoryTransaction(async () => 'written'))

    expect(caught).toBe(failure)
    expect(getHistoryTransactionFailure(caught)).toMatchObject({
      stage: 'commit',
      primaryStage: 'commit',
      failedStages: ['commit'],
      outcome: 'ambiguous',
      outcomeAmbiguous: true,
      replayPolicy: 'exact_input_only',
      primaryCause: failure,
      clientDisposition: 'destroyed',
      destroyRequested: true,
      releaseSucceeded: true,
    })
    expect(mockQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT'])
    expect(mockRelease).toHaveBeenCalledWith(true)
  })

  it('preserves the operation as primary when rollback fails and destroys the client', async () => {
    const operationFailure = new Error('history insert failed')
    const rollbackFailure = new Error('rollback connection lost')
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql === 'ROLLBACK') throw rollbackFailure
      return { rows: [], rowCount: 0 }
    })

    const caught = await rejection(
      runHistoryTransaction(async () => {
        throw operationFailure
      })
    )

    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors).toEqual([operationFailure, rollbackFailure])
    expect((caught as Error & { cause?: unknown }).cause).toBe(operationFailure)
    expect(getHistoryTransactionFailure(caught)).toMatchObject({
      stage: 'rollback',
      primaryStage: 'operation',
      failedStages: ['operation', 'rollback'],
      outcome: 'not_committed',
      outcomeAmbiguous: false,
      primaryCause: operationFailure,
      rollbackCause: rollbackFailure,
      clientDisposition: 'destroyed',
      destroyRequested: true,
      releaseSucceeded: true,
    })
    expect(mockRelease).toHaveBeenCalledWith(true)
  })

  it('reports release failure after a successful COMMIT as already committed', async () => {
    const releaseFailure = new Error('pool release failed')
    mockRelease.mockImplementationOnce(() => {
      throw releaseFailure
    })

    const caught = await rejection(runHistoryTransaction(async () => 'written'))

    expect(caught).toBe(releaseFailure)
    expect(getHistoryTransactionFailure(caught)).toMatchObject({
      stage: 'release',
      primaryStage: 'release',
      failedStages: ['release'],
      outcome: 'committed',
      outcomeAmbiguous: false,
      replayPolicy: 'never',
      primaryCause: releaseFailure,
      releaseCause: releaseFailure,
      clientDisposition: 'release_failed',
      destroyRequested: false,
      releaseSucceeded: false,
    })
    expect(mockRelease).toHaveBeenCalledWith(false)
  })

  it('keeps COMMIT as primary if destroying that failed client also throws', async () => {
    const commitFailure = new Error('connection lost during commit')
    const releaseFailure = new Error('destroy failed')
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql === 'COMMIT') throw commitFailure
      return { rows: [], rowCount: 0 }
    })
    mockRelease.mockImplementationOnce(() => {
      throw releaseFailure
    })

    const caught = await rejection(runHistoryTransaction(async () => 'written'))

    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors).toEqual([commitFailure, releaseFailure])
    expect(getHistoryTransactionFailure(caught)).toMatchObject({
      stage: 'release',
      primaryStage: 'commit',
      failedStages: ['commit', 'release'],
      outcome: 'ambiguous',
      outcomeAmbiguous: true,
      replayPolicy: 'exact_input_only',
      primaryCause: commitFailure,
      releaseCause: releaseFailure,
      clientDisposition: 'release_failed',
      destroyRequested: true,
      releaseSucceeded: false,
    })
    expect(mockRelease).toHaveBeenCalledWith(true)
  })
})
