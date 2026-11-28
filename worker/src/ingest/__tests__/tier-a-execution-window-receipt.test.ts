import type { QueryResult, QueryResultRow } from 'pg'

import type { IngestQueryExecutor } from '@/lib/ingest/db'
import { validateWorkerDbFencedWriteStatement } from '@/lib/ingest/db-fenced-write-contract'

jest.mock('../source-job-execution-authority', () => ({
  assertTierAExecutionClaimedWrite: jest.fn(),
}))

import {
  assertTierAExecutionClaimedWrite,
  type TierAExecutionClaimedWrite,
} from '../source-job-execution-authority'
import {
  GET_TIER_A_EXECUTION_WINDOW_RECEIPT_SQL,
  getTierAExecutionWindowReceipt,
  hasTierAExecutionWindowRepublishReceipt,
  RECORD_TIER_A_EXECUTION_WINDOW_REPUBLISH_RECEIPT_SQL,
  recordTierAExecutionWindowRepublishReceipt,
  TIER_A_EXECUTION_WINDOW_REPUBLISH_RECEIPT_PRESENT_SQL,
  RECORD_TIER_A_EXECUTION_WINDOW_RECEIPT_SQL,
  recordTierAExecutionWindowReceipt,
  TIER_A_EXECUTION_WINDOW_RECEIPT_CONTRACT,
  type GetTierAExecutionWindowReceiptInput,
  type RecordTierAExecutionWindowReceiptInput,
  type TierAExecutionReceiptWriter,
  type TierAExecutionReceiptWriterBinding,
  type TierAExecutionWindowReceipt,
  withTierAExecutionReceiptWriter,
} from '../tier-a-execution-window-receipt'

const SOURCE_ID = 17
const CLAIM_ID = '11111111-1111-4111-8111-111111111111'
const ATTEMPT_ID = '22222222-2222-4222-8222-222222222222'
const GENERATION_SEQ = 9
const SNAPSHOT_ID = 501
const QUEUE_NAME = 'arena:ingest:tier-a:local'
const QUEUE_JOB_ID = 'repeat:leaderboard:1785283200000'
const OBSERVATION_CYCLE_ID = `tier-a:binance_futures:${QUEUE_JOB_ID}`
const SOURCE_RUN_ID = 'a'.repeat(64)
const RECORDED_AT = '2026-07-29T05:00:00.000Z'
const RESULT_ALIAS = 'tier_a_execution_window_receipt'

const mockAssertClaimedWrite = assertTierAExecutionClaimedWrite as jest.MockedFunction<
  typeof assertTierAExecutionClaimedWrite
>
let liveTransactions: WeakSet<object>

function binding(
  overrides: Partial<TierAExecutionReceiptWriterBinding> = {}
): TierAExecutionReceiptWriterBinding {
  return {
    claimId: CLAIM_ID,
    generationSeq: GENERATION_SEQ,
    queueJobId: QUEUE_JOB_ID,
    queueName: QUEUE_NAME,
    sourceId: SOURCE_ID,
    ...overrides,
  }
}

function recordInput(
  overrides: Partial<RecordTierAExecutionWindowReceiptInput> = {}
): RecordTierAExecutionWindowReceiptInput {
  return {
    attemptId: ATTEMPT_ID,
    observationCycleId: OBSERVATION_CYCLE_ID,
    rawObjectId: 401,
    snapshotId: SNAPSHOT_ID,
    sourceRunId: SOURCE_RUN_ID,
    timeframe: 30,
    ...overrides,
  }
}

function getInput(
  overrides: Partial<GetTierAExecutionWindowReceiptInput> = {}
): GetTierAExecutionWindowReceiptInput {
  return {
    observationCycleId: OBSERVATION_CYCLE_ID,
    queueJobId: QUEUE_JOB_ID,
    queueName: QUEUE_NAME,
    sourceId: SOURCE_ID,
    timeframe: 30,
    ...overrides,
  }
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attempt_id: ATTEMPT_ID,
    attempt_seq: 81,
    claim_id: CLAIM_ID,
    contract: TIER_A_EXECUTION_WINDOW_RECEIPT_CONTRACT,
    generation_seq: GENERATION_SEQ,
    observation_cycle_id: OBSERVATION_CYCLE_ID,
    queue_job_id: QUEUE_JOB_ID,
    queue_name: QUEUE_NAME,
    raw_object_id: 401,
    recorded_at: RECORDED_AT,
    snapshot_id: SNAPSHOT_ID,
    source_id: SOURCE_ID,
    source_run_id: SOURCE_RUN_ID,
    timeframe: 30,
    ...overrides,
  }
}

function selectResult(
  value: unknown,
  overrides: Partial<QueryResult<QueryResultRow>> = {}
): QueryResult<QueryResultRow> {
  return {
    command: 'SELECT',
    fields: [],
    oid: 0,
    rowCount: 1,
    rows: [{ [RESULT_ALIAS]: value }],
    ...overrides,
  }
}

function claimedTransaction(query: jest.Mock): TierAExecutionClaimedWrite {
  const transaction = Object.freeze({
    query,
    signal: new AbortController().signal,
  }) as TierAExecutionClaimedWrite
  liveTransactions.add(transaction)
  return transaction
}

function readExecutor(query: jest.Mock): IngestQueryExecutor {
  return { query } as IngestQueryExecutor
}

function expectReceiptError(operation: string, code: string) {
  return expect.objectContaining({
    code,
    message: `[ingest-worker] Tier-A execution window receipt ${operation} failed (${code})`,
    operation,
  })
}

async function recordWith(
  query: jest.Mock,
  input: RecordTierAExecutionWindowReceiptInput = recordInput(),
  executionBinding: TierAExecutionReceiptWriterBinding = binding()
): Promise<TierAExecutionWindowReceipt> {
  const transaction = claimedTransaction(query)
  return withTierAExecutionReceiptWriter(transaction, executionBinding, (writer) =>
    recordTierAExecutionWindowReceipt(writer, input)
  )
}

beforeEach(() => {
  liveTransactions = new WeakSet<object>()
  mockAssertClaimedWrite.mockReset()
  mockAssertClaimedWrite.mockImplementation((value: unknown) => {
    if (value === null || typeof value !== 'object' || !liveTransactions.has(value)) {
      throw new Error('not a live claimed transaction')
    }
  })
})

describe('Tier-A execution window receipt', () => {
  it('records once on the callback-owned claimed transaction with exact SQL and parameters', async () => {
    const query = jest.fn(async () => selectResult(payload()))

    const receipt = await recordWith(query)

    expect(query).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledWith(RECORD_TIER_A_EXECUTION_WINDOW_RECEIPT_SQL, [
      CLAIM_ID,
      GENERATION_SEQ,
      ATTEMPT_ID,
      SNAPSHOT_ID,
    ])
    const parameters = query.mock.calls[0]?.[1] as unknown[]
    expect(Object.isFrozen(parameters)).toBe(true)
    expect(receipt).toEqual({
      attemptId: ATTEMPT_ID,
      attemptSeq: 81,
      claimId: CLAIM_ID,
      contract: TIER_A_EXECUTION_WINDOW_RECEIPT_CONTRACT,
      generationSeq: GENERATION_SEQ,
      observationCycleId: OBSERVATION_CYCLE_ID,
      queueJobId: QUEUE_JOB_ID,
      queueName: QUEUE_NAME,
      rawObjectId: 401,
      recordedAt: RECORDED_AT,
      snapshotId: SNAPSHOT_ID,
      sourceId: SOURCE_ID,
      sourceRunId: SOURCE_RUN_ID,
      timeframe: 30,
    })
    expect(Object.isFrozen(receipt)).toBe(true)
  })

  it('gets by the queue-scoped key and keeps queue name in the RPC identity', async () => {
    const query = jest.fn(async () => selectResult(payload()))

    const receipt = await getTierAExecutionWindowReceipt(readExecutor(query), getInput())

    expect(receipt?.claimId).toBe(CLAIM_ID)
    expect(query).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledWith(GET_TIER_A_EXECUTION_WINDOW_RECEIPT_SQL, [
      SOURCE_ID,
      QUEUE_NAME,
      QUEUE_JOB_ID,
      OBSERVATION_CYCLE_ID,
      30,
    ])
    expect(Object.isFrozen(query.mock.calls[0]?.[1])).toBe(true)
  })

  it('returns null only from one well-formed SELECT row containing a null RPC payload', async () => {
    const query = jest.fn(async () => selectResult(null))

    await expect(
      getTierAExecutionWindowReceipt(readExecutor(query), getInput())
    ).resolves.toBeNull()
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('rejects a null observation cycle from the database contract', async () => {
    const query = jest.fn(async () => selectResult(payload({ observation_cycle_id: null })))

    await expect(getTierAExecutionWindowReceipt(readExecutor(query), getInput())).rejects.toEqual(
      expectReceiptError('get', 'rpc_contract_violation')
    )
    expect(query).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      'missing key',
      (() => {
        const value = payload()
        delete value.source_run_id
        return value
      })(),
    ],
    ['extra key', payload({ unexpected: true })],
  ])('rejects a record payload with an %s', async (_label, value) => {
    const query = jest.fn(async () => selectResult(value))

    await expect(recordWith(query)).rejects.toEqual(
      expectReceiptError('record', 'rpc_contract_violation')
    )
    expect(query).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      'missing key',
      (() => {
        const value = payload()
        delete value.attempt_seq
        return value
      })(),
    ],
    ['extra key', payload({ extra: 'not allowed' })],
  ])('rejects a getter payload with an %s', async (_label, value) => {
    const query = jest.fn(async () => selectResult(value))

    await expect(getTierAExecutionWindowReceipt(readExecutor(query), getInput())).rejects.toEqual(
      expectReceiptError('get', 'rpc_contract_violation')
    )
    expect(query).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['null prototype', Object.assign(Object.create(null), payload())],
    [
      'accessor descriptor',
      Object.defineProperty(payload(), 'source_id', {
        enumerable: true,
        get: () => SOURCE_ID,
      }),
    ],
    ['symbol property', Object.assign(payload(), { [Symbol('hidden')]: 'value' })],
  ])('rejects payload prototype/descriptor/symbol deception: %s', async (_label, value) => {
    const query = jest.fn(async () => selectResult(value))

    await expect(getTierAExecutionWindowReceipt(readExecutor(query), getInput())).rejects.toEqual(
      expectReceiptError('get', 'rpc_contract_violation')
    )
    expect(query).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['non-canonical UUID', { claim_id: 'abcdefab-cdef-4abc-8abc-abcdefabcdef'.toUpperCase() }],
    ['padded text', { queue_name: ` ${QUEUE_NAME}` }],
    ['fractional integer', { snapshot_id: SNAPSHOT_ID + 0.5 }],
    ['unsafe integer', { raw_object_id: Number.MAX_SAFE_INTEGER }],
    ['non-canonical timestamp', { recorded_at: '2026-07-29T05:00:00Z' }],
    ['uppercase digest', { source_run_id: SOURCE_RUN_ID.toUpperCase() }],
    ['zero digest', { source_run_id: '0'.repeat(64) }],
  ])('rejects a non-canonical receipt field: %s', async (_label, override) => {
    const query = jest.fn(async () => selectResult(payload(override)))

    await expect(getTierAExecutionWindowReceipt(readExecutor(query), getInput())).rejects.toEqual(
      expectReceiptError('get', 'rpc_contract_violation')
    )
    expect(query).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['wrong command', { command: 'UPDATE' }],
    ['null rowCount', { rowCount: null }],
    ['zero rowCount', { rowCount: 0 }],
    ['two rowCount', { rowCount: 2 }],
    ['no rows', { rows: [] }],
    ['two rows', { rows: [{ [RESULT_ALIAS]: payload() }, { [RESULT_ALIAS]: payload() }] }],
  ])('rejects malformed RPC result cardinality: %s', async (_label, overrides) => {
    const query = jest.fn(async () => selectResult(payload(), overrides))

    await expect(getTierAExecutionWindowReceipt(readExecutor(query), getInput())).rejects.toEqual(
      expectReceiptError('get', 'rpc_contract_violation')
    )
    expect(query).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['source', { source_id: SOURCE_ID + 1 }],
    ['queue name', { queue_name: `${QUEUE_NAME}:other` }],
    ['queue job ID', { queue_job_id: `${QUEUE_JOB_ID}:other` }],
    ['observation cycle', { observation_cycle_id: `${OBSERVATION_CYCLE_ID}:other` }],
    ['timeframe', { timeframe: 90 }],
  ])('rejects a getter identity conflict: %s', async (_label, override) => {
    const query = jest.fn(async () => selectResult(payload(override)))

    await expect(getTierAExecutionWindowReceipt(readExecutor(query), getInput())).rejects.toEqual(
      expectReceiptError('get', 'rpc_contract_violation')
    )
  })

  it.each([
    ['source', { source_id: SOURCE_ID + 1 }],
    ['queue name', { queue_name: `${QUEUE_NAME}:other` }],
    ['queue job ID', { queue_job_id: `${QUEUE_JOB_ID}:other` }],
    ['claim', { claim_id: '33333333-3333-4333-8333-333333333333' }],
    ['generation', { generation_seq: GENERATION_SEQ + 1 }],
    ['attempt', { attempt_id: '44444444-4444-4444-8444-444444444444' }],
    ['snapshot', { snapshot_id: SNAPSHOT_ID + 1 }],
    ['timeframe', { timeframe: 90 }],
    ['observation cycle', { observation_cycle_id: `${OBSERVATION_CYCLE_ID}:other` }],
    ['raw object', { raw_object_id: 402 }],
    ['source run', { source_run_id: 'b'.repeat(64) }],
  ])('rejects a record identity conflict: %s', async (_label, override) => {
    const query = jest.fn(async () => selectResult(payload(override)))

    await expect(recordWith(query)).rejects.toEqual(
      expectReceiptError('record', 'rpc_contract_violation')
    )
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('rejects a forged writer without running any query', async () => {
    const query = jest.fn()
    const forged = Object.freeze({}) as TierAExecutionReceiptWriter

    await expect(recordTierAExecutionWindowReceipt(forged, recordInput())).rejects.toEqual(
      expectReceiptError('record', 'unauthorized')
    )
    expect(query).not.toHaveBeenCalled()
  })

  it('revokes a real writer when its callback settles', async () => {
    const query = jest.fn(async () => selectResult(payload()))
    const transaction = claimedTransaction(query)
    let escaped: TierAExecutionReceiptWriter | undefined

    await withTierAExecutionReceiptWriter(transaction, binding(), async (writer) => {
      escaped = writer
    })

    await expect(
      recordTierAExecutionWindowReceipt(escaped as TierAExecutionReceiptWriter, recordInput())
    ).rejects.toEqual(expectReceiptError('record', 'unauthorized'))
    expect(query).not.toHaveBeenCalled()
  })

  it('rejects an ordinary query executor before creating a writer', async () => {
    const query = jest.fn()
    const ordinary = Object.freeze({
      query,
      signal: new AbortController().signal,
    }) as TierAExecutionClaimedWrite
    const callback = jest.fn()

    await expect(withTierAExecutionReceiptWriter(ordinary, binding(), callback)).rejects.toEqual(
      expectReceiptError('writer', 'unauthorized')
    )
    expect(callback).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
  })

  it('rejects malformed record input before querying', async () => {
    const query = jest.fn(async () => selectResult(payload()))
    const malformed = Object.assign(recordInput(), { extra: true })

    await expect(recordWith(query, malformed)).rejects.toEqual(
      expectReceiptError('record', 'invalid_input')
    )
    expect(query).not.toHaveBeenCalled()
  })

  it.each([
    [
      'missing key',
      (() => {
        const { sourceRunId: _sourceRunId, ...value } = recordInput()
        return value
      })(),
    ],
    ['null observation cycle', { ...recordInput(), observationCycleId: null }],
    ['zero source-run digest', { ...recordInput(), sourceRunId: '0'.repeat(64) }],
    [
      'hostile accessor',
      Object.defineProperty(recordInput(), 'rawObjectId', {
        enumerable: true,
        get: () => 401,
      }),
    ],
    ['symbol property', Object.assign(recordInput(), { [Symbol('hidden')]: true })],
  ])('strictly rejects malformed record coordinates: %s', async (_label, malformed) => {
    const query = jest.fn(async () => selectResult(payload()))

    await expect(
      recordWith(query, malformed as RecordTierAExecutionWindowReceiptInput)
    ).rejects.toEqual(expectReceiptError('record', 'invalid_input'))
    expect(query).not.toHaveBeenCalled()
  })

  it('rejects a null observation cycle returned from record', async () => {
    const query = jest.fn(async () => selectResult(payload({ observation_cycle_id: null })))

    await expect(recordWith(query)).rejects.toEqual(
      expectReceiptError('record', 'rpc_contract_violation')
    )
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed getter input before querying', async () => {
    const query = jest.fn(async () => selectResult(payload()))
    const malformed = Object.assign(getInput(), { hidden: true })

    await expect(getTierAExecutionWindowReceipt(readExecutor(query), malformed)).rejects.toEqual(
      expectReceiptError('get', 'invalid_input')
    )
    expect(query).not.toHaveBeenCalled()
  })

  it.each([
    [
      'missing observation cycle',
      (() => {
        const { observationCycleId: _observationCycleId, ...value } = getInput()
        return value
      })(),
    ],
    ['null observation cycle', { ...getInput(), observationCycleId: null }],
    [
      'hostile accessor',
      Object.defineProperty(getInput(), 'observationCycleId', {
        enumerable: true,
        get: () => OBSERVATION_CYCLE_ID,
      }),
    ],
    ['symbol property', Object.assign(getInput(), { [Symbol('hidden')]: true })],
  ])('strictly rejects malformed getter coordinates: %s', async (_label, malformed) => {
    const query = jest.fn(async () => selectResult(payload()))

    await expect(
      getTierAExecutionWindowReceipt(
        readExecutor(query),
        malformed as GetTierAExecutionWindowReceiptInput
      )
    ).rejects.toEqual(expectReceiptError('get', 'invalid_input'))
    expect(query).not.toHaveBeenCalled()
  })

  it('accepts a 512-character queue job ID and rejects 513 characters before querying', async () => {
    const maximumJobId = 'j'.repeat(512)
    const acceptedQuery = jest.fn(async () => selectResult(payload({ queue_job_id: maximumJobId })))

    await expect(
      getTierAExecutionWindowReceipt(
        readExecutor(acceptedQuery),
        getInput({ queueJobId: maximumJobId })
      )
    ).resolves.toEqual(expect.objectContaining({ queueJobId: maximumJobId }))
    expect(acceptedQuery).toHaveBeenCalledTimes(1)

    const rejectedQuery = jest.fn()
    await expect(
      getTierAExecutionWindowReceipt(
        readExecutor(rejectedQuery),
        getInput({ queueJobId: 'j'.repeat(513) })
      )
    ).rejects.toEqual(expectReceiptError('get', 'invalid_input'))
    expect(rejectedQuery).not.toHaveBeenCalled()
  })

  it('rejects a 513-character queue job ID returned by the RPC', async () => {
    const query = jest.fn(async () => selectResult(payload({ queue_job_id: 'j'.repeat(513) })))

    await expect(getTierAExecutionWindowReceipt(readExecutor(query), getInput())).rejects.toEqual(
      expectReceiptError('get', 'rpc_contract_violation')
    )
    expect(query).toHaveBeenCalledTimes(1)
  })

  it.each(['record', 'get'])('never replays an uncertain %s query failure', async (operation) => {
    const failure = new Error('connection outcome unknown')
    const query = jest.fn(async () => Promise.reject(failure))

    const promise =
      operation === 'record'
        ? recordWith(query)
        : getTierAExecutionWindowReceipt(readExecutor(query), getInput())
    await expect(promise).rejects.toEqual(expectReceiptError(operation, 'unavailable'))
    expect(query).toHaveBeenCalledTimes(1)
  })
})

describe('Tier-A execution window republish receipt', () => {
  async function republishWith(
    query: jest.Mock,
    input: RecordTierAExecutionWindowReceiptInput = recordInput()
  ): Promise<TierAExecutionWindowReceipt> {
    const transaction = claimedTransaction(query)
    return withTierAExecutionReceiptWriter(transaction, binding(), (writer) =>
      recordTierAExecutionWindowRepublishReceipt(writer, input)
    )
  }

  it('calls the republish RPC with the calling claim and validates the same receipt shape', async () => {
    const query = jest.fn(async () => selectResult(payload()))

    const receipt = await republishWith(query)

    expect(RECORD_TIER_A_EXECUTION_WINDOW_REPUBLISH_RECEIPT_SQL).toContain(
      'arena.record_tier_a_execution_window_republish_receipt('
    )
    expect(query).toHaveBeenCalledWith(RECORD_TIER_A_EXECUTION_WINDOW_REPUBLISH_RECEIPT_SQL, [
      CLAIM_ID,
      GENERATION_SEQ,
      ATTEMPT_ID,
      SNAPSHOT_ID,
    ])
    expect(receipt.attemptId).toBe(ATTEMPT_ID)
    expect(receipt.claimId).toBe(CLAIM_ID)
  })

  it('maps a missing function (42883) to undefined_function', async () => {
    const query = jest.fn(async () => {
      throw Object.assign(new Error('function does not exist'), { code: '42883' })
    })

    await expect(republishWith(query)).rejects.toEqual(
      expectReceiptError('republish', 'undefined_function')
    )
  })

  it('maps any other database failure to unavailable', async () => {
    const query = jest.fn(async () => {
      throw Object.assign(new Error('deadline'), { code: '57014' })
    })

    await expect(republishWith(query)).rejects.toEqual(
      expectReceiptError('republish', 'unavailable')
    )
  })

  it('rejects a receipt naming a different claim, snapshot or RAW', async () => {
    for (const override of [
      { claim_id: '33333333-3333-4333-8333-333333333333' },
      { snapshot_id: SNAPSHOT_ID + 1 },
      { raw_object_id: 402 },
    ]) {
      const query = jest.fn(async () => selectResult(payload(override)))
      await expect(republishWith(query)).rejects.toEqual(
        expectReceiptError('republish', 'rpc_contract_violation')
      )
    }
  })

  it('refuses a writer outside its callback', async () => {
    const query = jest.fn(async () => selectResult(payload()))
    let escaped: TierAExecutionReceiptWriter | null = null
    await withTierAExecutionReceiptWriter(claimedTransaction(query), binding(), async (writer) => {
      escaped = writer
    })

    await expect(
      recordTierAExecutionWindowRepublishReceipt(escaped!, recordInput())
    ).rejects.toEqual(expectReceiptError('republish', 'unauthorized'))
    expect(query).not.toHaveBeenCalled()
  })

  it('probes the RPC with a read-only catalog query', async () => {
    for (const present of [true, false]) {
      const query = jest.fn(async () => ({
        command: 'SELECT',
        fields: [],
        oid: 0,
        rowCount: 1,
        rows: [{ republish_receipt_present: present }],
      }))
      await expect(hasTierAExecutionWindowRepublishReceipt(readExecutor(query))).resolves.toBe(
        present
      )
      expect(query).toHaveBeenCalledWith(TIER_A_EXECUTION_WINDOW_REPUBLISH_RECEIPT_PRESENT_SQL)
    }
    expect(TIER_A_EXECUTION_WINDOW_REPUBLISH_RECEIPT_PRESENT_SQL).toMatch(
      /to_regprocedure\(\s*'arena\.record_tier_a_execution_window_republish_receipt\(uuid,bigint,uuid,bigint\)'/
    )
    expect(TIER_A_EXECUTION_WINDOW_REPUBLISH_RECEIPT_PRESENT_SQL).toMatch(
      /has_function_privilege\(\s*current_user,\s*'arena\.record_tier_a_execution_window_republish_receipt\(uuid,bigint,uuid,bigint\)',\s*'EXECUTE'/
    )
  })

  it('keeps the probe and receipt SQL inside the worker fenced-statement contract', () => {
    for (const sql of [
      TIER_A_EXECUTION_WINDOW_REPUBLISH_RECEIPT_PRESENT_SQL,
      RECORD_TIER_A_EXECUTION_WINDOW_REPUBLISH_RECEIPT_SQL,
    ]) {
      expect(validateWorkerDbFencedWriteStatement(sql)).toBe(sql.trim())
    }
  })

  it('reports a malformed probe result as a contract violation', async () => {
    const query = jest.fn(async () => ({
      command: 'SELECT',
      fields: [],
      oid: 0,
      rowCount: 1,
      rows: [{ republish_receipt_present: 't' }],
    }))
    await expect(hasTierAExecutionWindowRepublishReceipt(readExecutor(query))).rejects.toEqual(
      expectReceiptError('probe', 'rpc_contract_violation')
    )
  })
})
