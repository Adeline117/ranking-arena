import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'

const mockUpload = jest.fn()
const mockDownload = jest.fn()
const mockPoolQuery = jest.fn()

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    storage: {
      from: jest.fn(() => ({ upload: mockUpload, download: mockDownload })),
    },
  })),
}))

jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: jest.fn(() => ({ query: mockPoolQuery })),
  ingestClientConnect: jest.fn(),
}))

import type { HistoryKind, RawPage } from '@/lib/ingest/core/types'
import type { IngestQueryExecutor } from '@/lib/ingest/db'
import {
  captureHistoryAcquisition,
  HISTORY_TERMINAL_CLAIM_CONTRACT,
  type HistoryTerminalClaim,
} from '@/lib/ingest/history-acquisition'
import {
  buildPositionHistoryAcquisitionArtifactV2,
  type PositionHistoryAcquisitionArtifactV2,
} from '@/lib/ingest/position-history-acquisition-v2'
import {
  EVENT_HISTORY_RAW_ARTIFACT_ROLE,
  type LockedVerifiedPositionHistoryRawArtifactV2,
  POSITION_HISTORY_PUBLICATION_EVIDENCE_CONTRACT,
  POSITION_HISTORY_RAW_JOB_TYPE,
  type IngestTransactionRunner,
  withVerifiedPositionHistoryRawArtifactV2,
  writePositionHistoryRawArtifact,
  type WritePositionHistoryRawArtifactInput,
} from '@/lib/ingest/raw'
import { strictCanonicalJson, strictCanonicalSha256 } from '@/lib/ingest/strict-canonical-json'
import {
  BINANCE_HISTORY_PAGE_ENVELOPE_CONTRACT,
  BINANCE_POSITION_HISTORY_URL,
} from '@/lib/ingest/adapters/binance/history-contract'
import { binancePositionHistoryTerminalVerifier } from '@/lib/ingest/adapters/binance/history-terminal'

interface PointerRow {
  id: number
  source_id: number
  job_type: string
  trader_id: number | null
  timeframe: number | null
  fetched_at: string
  storage_path: string
  bytes: number
  content_hash: string
  quarantined: boolean
  meta: unknown
  source_run_id: string | null
  trust_artifact_role: string | null
}

const attemptStartedAt = '2026-08-03T10:00:00.000Z'
const fetchedAt = '2026-08-03T10:00:01.000Z'

function terminalClaim(): HistoryTerminalClaim {
  return {
    contract: HISTORY_TERMINAL_CLAIM_CONTRACT,
    observations: [{ segment_id: 'default', reason: 'reported_end', page_ordinal: 1 }],
  }
}

async function artifactInput(
  options: { kind?: HistoryKind; upstreamError?: boolean } = {}
): Promise<WritePositionHistoryRawArtifactInput> {
  const kind = options.kind ?? 'position_history'
  async function* stream(): AsyncGenerator<RawPage, HistoryTerminalClaim, void> {
    yield {
      pageIndex: 1,
      payload: { data: [{ id: 'closed-position-1' }], total: 1 },
      url: 'https://example.test/history?page=1',
      fetchedAt,
    }
    if (options.upstreamError) throw new Error('upstream failed after the durable page')
    return terminalClaim()
  }

  const captured = await captureHistoryAcquisition({
    source: { id: 1, slug: 'binance_futures' },
    traderId: 11,
    exchangeTraderId: 'portfolio-1',
    kind,
    cursor: null,
    attemptStartedAt,
    stream: stream(),
    terminalVerifier: {
      contract: `arena.ingest.history-terminal-verifier.test.${kind}@1`,
      verify: () => ({ verified: true, scanTerminalState: 'exhausted' }),
    },
  })
  return { artifact: captured.artifact, sourceRunId: captured.sourceRunId }
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function trustedV2ReadInput(
  input: Pick<WritePositionHistoryRawArtifactInput, 'sourceRunId'>,
  rawObjectId = 41
) {
  return {
    rawObjectId,
    expectedSourceId: 1,
    expectedSourceSlug: 'binance_futures',
    expectedTraderId: 11,
    expectedExchangeTraderId: 'portfolio-1',
    expectedSourceRunId: input.sourceRunId,
  }
}

async function verifiedV2ArtifactInputs(options: { empty?: boolean } = {}): Promise<{
  v1: WritePositionHistoryRawArtifactInput
  v2: WritePositionHistoryRawArtifactInput & {
    artifact: PositionHistoryAcquisitionArtifactV2
  }
}> {
  const opened = Date.parse('2026-07-02T00:00:00.000Z')
  const payload = {
    contract: BINANCE_HISTORY_PAGE_ENVELOPE_CONTRACT,
    portfolioId: 'portfolio-1',
    sort: 'CLOSING',
    request: {
      pageNumber: 1,
      pageSize: 50,
      portfolioId: 'portfolio-1',
      sort: 'CLOSING',
    },
    response: {
      code: '000000',
      success: true,
      data: {
        total: options.empty ? 0 : 1,
        list: options.empty
          ? []
          : [
              {
                id: 'closed-position-1',
                symbol: 'BTCUSDT',
                side: 'Long',
                status: 'All Closed',
                opened,
                closed: opened + 60_000,
                roi: '0.1',
                leverage: '10',
                closedVolume: '2',
                avgCost: '60000',
                avgClosePrice: '61000',
                closingPnl: '12.5',
              },
            ],
      },
    },
  }
  const claim: HistoryTerminalClaim = {
    contract: HISTORY_TERMINAL_CLAIM_CONTRACT,
    observations: [{ segment_id: 'closing', reason: 'reported_end', page_ordinal: 1 }],
  }
  async function* stream(): AsyncGenerator<RawPage, HistoryTerminalClaim, void> {
    yield { pageIndex: 1, payload, url: BINANCE_POSITION_HISTORY_URL, fetchedAt }
    return claim
  }
  const capture = await captureHistoryAcquisition({
    source: { id: 1, slug: 'binance_futures' },
    traderId: 11,
    exchangeTraderId: 'portfolio-1',
    kind: 'position_history',
    cursor: '2026-07-01T00:00:00.000Z',
    attemptStartedAt,
    stream: stream(),
    terminalVerifier: binancePositionHistoryTerminalVerifier,
  })
  const built = buildPositionHistoryAcquisitionArtifactV2({
    acquisition: capture.artifact,
    expectedAcquisition: {
      sourceRunId: capture.sourceRunId,
      sourceId: 1,
      sourceSlug: 'binance_futures',
      traderId: 11,
      exchangeTraderId: 'portfolio-1',
    },
  })
  if (built.state !== 'verified') {
    throw new Error(`expected verified v2 acquisition, got ${built.reason}`)
  }
  return {
    v1: { artifact: capture.artifact, sourceRunId: capture.sourceRunId },
    v2: { artifact: built.artifact, sourceRunId: built.sourceRunId },
  }
}

function downloadBody(payload: Buffer) {
  return {
    arrayBuffer: async () =>
      payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
  }
}

function pointerSnapshot(row: PointerRow): PointerRow {
  return { ...row, meta: jsonClone(row.meta) }
}

function databaseHarness(
  initialRows: PointerRow[] = [],
  options: { exactInstant?: boolean; notFuture?: boolean; gcPending?: boolean } = {}
) {
  const pointers = initialRows.map(pointerSnapshot)
  const gcPendingPaths = new Set<string>()
  let nextId = 41
  const query = jest.fn(async (sqlInput: unknown, params: unknown[] = []) => {
    const sql = String(sqlInput)
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] }
    if (sql.startsWith('SELECT fetched_at =')) {
      const pointer = pointers.find((candidate) => candidate.id === params[0])
      return {
        rows: pointer
          ? [
              {
                exact_instant:
                  options.exactInstant ??
                  Date.parse(pointer.fetched_at) === Date.parse(String(params[1])),
                not_future:
                  options.notFuture ?? Date.parse(pointer.fetched_at) <= Date.now() + 5 * 60_000,
              },
            ]
          : [],
      }
    }
    if (sql.startsWith('SELECT id, source_id')) {
      if (sql.includes('AS gc_pending')) {
        return {
          rows: pointers
            .filter(
              (pointer) =>
                pointer.id === params[0] ||
                (pointer.source_run_id === params[1] &&
                  pointer.trust_artifact_role === EVENT_HISTORY_RAW_ARTIFACT_ROLE)
            )
            .map((pointer) => ({
              ...pointerSnapshot(pointer),
              gc_pending: (options.gcPending ?? false) || gcPendingPaths.has(pointer.storage_path),
            })),
        }
      }
      return {
        rows: pointers
          .filter(
            (pointer) =>
              pointer.storage_path === params[0] ||
              (pointer.source_run_id === params[1] &&
                pointer.trust_artifact_role === EVENT_HISTORY_RAW_ARTIFACT_ROLE)
          )
          .map(pointerSnapshot),
      }
    }
    if (sql.startsWith('INSERT INTO arena.raw_objects')) {
      const storagePath = params[4] as string
      if (!pointers.some((pointer) => pointer.storage_path === storagePath)) {
        pointers.push({
          id: nextId++,
          source_id: params[0] as number,
          job_type: params[1] as string,
          trader_id: params[2] as number,
          timeframe: null,
          fetched_at: params[3] as string,
          storage_path: storagePath,
          bytes: params[5] as number,
          content_hash: params[6] as string,
          quarantined: false,
          meta: JSON.parse(params[7] as string),
          source_run_id: params[8] as string,
          trust_artifact_role: params[9] as string,
        })
      }
      return { rows: [] }
    }
    throw new Error(`Unexpected SQL: ${sql}`)
  })
  const transaction = { query } as unknown as IngestQueryExecutor
  const runTransaction = jest.fn(
    async <T>(operation: (executor: IngestQueryExecutor) => Promise<T>): Promise<T> => {
      const before = pointers.map(pointerSnapshot)
      const gcBefore = [...gcPendingPaths]
      try {
        return await operation(transaction)
      } catch (error) {
        pointers.splice(0, pointers.length, ...before)
        gcPendingPaths.clear()
        gcBefore.forEach((path) => gcPendingPaths.add(path))
        throw error
      }
    }
  ) as IngestTransactionRunner & jest.Mock
  return { pointers, gcPendingPaths, query, runTransaction, transaction }
}

describe('writePositionHistoryRawArtifact', () => {
  const storage = new Map<string, Buffer>()

  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
  })

  beforeEach(() => {
    jest.clearAllMocks()
    storage.clear()
    mockUpload.mockImplementation(async (path: string, payload: Buffer) => {
      if (storage.has(path)) return { error: { message: 'already exists', statusCode: 409 } }
      storage.set(path, Buffer.from(payload))
      return { error: null }
    })
    mockDownload.mockImplementation(async (path: string) => {
      const payload = storage.get(path)
      return payload
        ? { data: downloadBody(payload), error: null }
        : { data: null, error: { message: 'not found' } }
    })
  })

  it('stores one canonical event_history object with exact source, trader, and run binding', async () => {
    const input = await artifactInput()
    const database = databaseHarness()

    const receipt = await writePositionHistoryRawArtifact(input, database.runTransaction)

    expect(receipt).toEqual({
      id: 41,
      storagePath:
        `binance_futures/history_trust/position_history/${input.sourceRunId}/` +
        `event_history_${input.sourceRunId}.json.gz`,
      contentHash: input.sourceRunId,
    })
    expect(database.runTransaction).toHaveBeenCalledTimes(1)
    expect(database.pointers).toHaveLength(1)
    expect(database.pointers[0]).toMatchObject({
      source_id: 1,
      job_type: POSITION_HISTORY_RAW_JOB_TYPE,
      trader_id: 11,
      timeframe: null,
      fetched_at: fetchedAt,
      content_hash: input.sourceRunId,
      source_run_id: input.sourceRunId,
      trust_artifact_role: EVENT_HISTORY_RAW_ARTIFACT_ROLE,
      quarantined: false,
    })
    expect(database.pointers[0].meta).toMatchObject({
      data_contract: input.artifact.contract,
      history_evidence_contract: POSITION_HISTORY_PUBLICATION_EVIDENCE_CONTRACT,
      exchange_trader_id: 'portfolio-1',
      attempt_started_at: attemptStartedAt,
      starting_cursor: null,
      capture_config: { caller_page_cap: null },
      observed_at: fetchedAt,
      terminal_evidence_state: 'verified',
      scan_terminal_state: 'exhausted',
      termination: input.artifact.termination,
      raw_integrity: {
        serialization_contract: 'arena.strict-canonical-json@1',
        hash_scope: 'json_utf8',
      },
    })
    expect(Object.keys(database.pointers[0].meta as Record<string, unknown>)).toEqual([
      'surface',
      'data_contract',
      'history_evidence_contract',
      'source_run_id',
      'source_slug',
      'exchange_trader_id',
      'history_kind',
      'attempt_started_at',
      'starting_cursor',
      'capture_config',
      'observed_at',
      'page_count',
      'terminal_evidence_state',
      'scan_terminal_state',
      'verifier_contract',
      'termination',
      'raw_integrity',
    ])
    const uploaded = storage.get(receipt.storagePath)
    expect(uploaded).toBeDefined()
    expect(gunzipSync(uploaded!).toString('utf8')).toBe(strictCanonicalJson(input.artifact))
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('returns the same pointer on an exact retry after verifying existing Storage content', async () => {
    const input = await artifactInput()
    const database = databaseHarness()

    const first = await writePositionHistoryRawArtifact(input, database.runTransaction)
    const second = await writePositionHistoryRawArtifact(input, database.runTransaction)

    expect(second).toEqual(first)
    expect(database.pointers).toHaveLength(1)
    expect(mockUpload).toHaveBeenCalledTimes(2)
    expect(mockDownload).toHaveBeenCalledTimes(1)
    expect(
      database.query.mock.calls.filter(([sql]) =>
        String(sql).startsWith('INSERT INTO arena.raw_objects')
      )
    ).toHaveLength(1)
  })

  it('replays only the exact legacy audit metadata without upgrading it', async () => {
    const input = await artifactInput()
    const database = databaseHarness()
    const first = await writePositionHistoryRawArtifact(input, database.runTransaction)
    const meta = database.pointers[0].meta as Record<string, unknown>
    delete meta.history_evidence_contract
    delete meta.attempt_started_at
    delete meta.starting_cursor
    delete meta.capture_config
    delete meta.observed_at
    delete meta.termination

    await expect(writePositionHistoryRawArtifact(input, database.runTransaction)).resolves.toEqual(
      first
    )
    expect(database.pointers[0].meta).not.toHaveProperty('history_evidence_contract')

    meta.page_count = 2
    await expect(writePositionHistoryRawArtifact(input, database.runTransaction)).rejects.toThrow(
      'database pointer 41 does not match the artifact'
    )
  })

  it('rejects a same-path Storage collision with different canonical JSON before pointer I/O', async () => {
    const input = await artifactInput()
    const database = databaseHarness()
    const first = await writePositionHistoryRawArtifact(input, database.runTransaction)
    storage.set(first.storagePath, gzipSync(Buffer.from('{"forged":true}', 'utf8')))

    await expect(writePositionHistoryRawArtifact(input, database.runTransaction)).rejects.toThrow(
      'has different content'
    )

    expect(database.runTransaction).toHaveBeenCalledTimes(1)
    expect(database.pointers).toHaveLength(1)
  })

  it('rejects a retry when the database pointer has a foreign trader binding', async () => {
    const input = await artifactInput()
    const database = databaseHarness()
    await writePositionHistoryRawArtifact(input, database.runTransaction)
    database.pointers[0].trader_id = 999

    await expect(writePositionHistoryRawArtifact(input, database.runTransaction)).rejects.toThrow(
      'database pointer 41 does not match the artifact'
    )

    expect(database.pointers).toHaveLength(1)
  })

  it('requires a claimed transaction runner before Storage or database I/O', async () => {
    const input = await artifactInput()
    const unsafeWrite = writePositionHistoryRawArtifact as unknown as (
      value: WritePositionHistoryRawArtifactInput
    ) => Promise<unknown>

    await expect(unsafeWrite(input)).rejects.toThrow('a claimed transaction runner is required')
    expect(mockUpload).not.toHaveBeenCalled()
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('rejects a mismatched run digest and every non-position history artifact before I/O', async () => {
    const database = databaseHarness()
    const positionHistory = await artifactInput()
    await expect(
      writePositionHistoryRawArtifact(
        { ...positionHistory, sourceRunId: 'f'.repeat(64) },
        database.runTransaction
      )
    ).rejects.toThrow('canonical artifact hash does not match source run id')

    const orders = await artifactInput({ kind: 'orders' })
    await expect(writePositionHistoryRawArtifact(orders, database.runTransaction)).rejects.toThrow(
      'only position_history may bind the event_history role'
    )

    expect(mockUpload).not.toHaveBeenCalled()
    expect(database.runTransaction).not.toHaveBeenCalled()
  })

  it('durably labels upstream-error evidence as partial without upgrading its terminal state', async () => {
    const input = await artifactInput({ upstreamError: true })
    const database = databaseHarness()

    await writePositionHistoryRawArtifact(input, database.runTransaction)

    expect(input.artifact.termination).toMatchObject({
      evidence_state: 'upstream_error',
      scan_terminal_state: 'partial',
      blocker_reasons: ['upstream_error'],
    })
    expect(database.pointers[0].meta).toMatchObject({
      history_evidence_contract: POSITION_HISTORY_PUBLICATION_EVIDENCE_CONTRACT,
      observed_at: fetchedAt,
      terminal_evidence_state: 'upstream_error',
      scan_terminal_state: 'partial',
      termination: {
        evidence_state: 'upstream_error',
        scan_terminal_state: 'partial',
        blocker_reasons: ['upstream_error'],
      },
    })
  })

  it('stores verified @2 evidence under the outer digest with exact acquisition-only metadata', async () => {
    const { v2 } = await verifiedV2ArtifactInputs()
    const database = databaseHarness()

    const receipt = await writePositionHistoryRawArtifact(v2, database.runTransaction)

    expect(v2.sourceRunId).not.toBe(v2.artifact.acquisition_source_run_id)
    expect(receipt).toEqual({
      id: 41,
      storagePath:
        `binance_futures/history_trust/position_history/${v2.sourceRunId}/` +
        `event_history_${v2.sourceRunId}.json.gz`,
      contentHash: v2.sourceRunId,
    })
    expect(database.pointers[0]).toMatchObject({
      content_hash: v2.sourceRunId,
      source_run_id: v2.sourceRunId,
      trust_artifact_role: EVENT_HISTORY_RAW_ARTIFACT_ROLE,
      meta: {
        data_contract: v2.artifact.contract,
        source_run_id: v2.sourceRunId,
        acquisition_contract: v2.artifact.acquisition.contract,
        acquisition_source_run_id: v2.artifact.acquisition_source_run_id,
        candidate_ledger_contract: v2.artifact.candidate_ledger.contract,
        candidate_ledger_sha256: v2.artifact.candidate_ledger_sha256,
        source_fact_contract: v2.artifact.candidate_ledger.source_fact_contract,
        observed_candidate_count: 1,
        unique_source_fact_count: 1,
        fact_set_sha256: v2.artifact.candidate_ledger.fact_set_sha256,
      },
    })
    const meta = database.pointers[0].meta as Record<string, unknown>
    expect(meta).not.toHaveProperty('history_evidence_contract')
    expect(meta).not.toHaveProperty('parser_complete')
    expect(meta).not.toHaveProperty('rank_eligible')
    expect(Object.keys(meta).sort()).toEqual(
      [
        'surface',
        'data_contract',
        'source_run_id',
        'source_slug',
        'exchange_trader_id',
        'history_kind',
        'attempt_started_at',
        'starting_cursor',
        'capture_config',
        'observed_at',
        'page_count',
        'terminal_evidence_state',
        'scan_terminal_state',
        'verifier_contract',
        'termination',
        'acquisition_contract',
        'acquisition_source_run_id',
        'candidate_ledger_contract',
        'candidate_ledger_sha256',
        'source_fact_contract',
        'observed_candidate_count',
        'unique_source_fact_count',
        'fact_set_sha256',
        'raw_integrity',
      ].sort()
    )
    expect(gunzipSync(storage.get(receipt.storagePath)!)).toEqual(
      Buffer.from(strictCanonicalJson(v2.artifact), 'utf8')
    )
  })

  it('keeps @1 and @2 pointers for the same acquisition distinct and replayable', async () => {
    const { v1, v2 } = await verifiedV2ArtifactInputs()
    const database = databaseHarness()

    const v1Receipt = await writePositionHistoryRawArtifact(v1, database.runTransaction)
    const v2Receipt = await writePositionHistoryRawArtifact(v2, database.runTransaction)
    const v2Replay = await writePositionHistoryRawArtifact(v2, database.runTransaction)

    expect(v1.sourceRunId).toBe(v2.artifact.acquisition_source_run_id)
    expect(v1Receipt.storagePath).not.toBe(v2Receipt.storagePath)
    expect(v2Replay).toEqual(v2Receipt)
    expect(database.pointers).toHaveLength(2)
  })

  it('never accepts the nested @1 digest as the @2 pointer identity', async () => {
    const { v2 } = await verifiedV2ArtifactInputs()
    const database = databaseHarness()

    await expect(
      writePositionHistoryRawArtifact(
        { ...v2, sourceRunId: v2.artifact.acquisition_source_run_id },
        database.runTransaction
      )
    ).rejects.toThrow('history artifact v2 is invalid: position_history_v2_source_run_mismatch')
    expect(mockUpload).not.toHaveBeenCalled()
    expect(database.runTransaction).not.toHaveBeenCalled()
  })

  it('replays @2 semantics before I/O and rejects a fully rehashed terminal forgery', async () => {
    const { v2 } = await verifiedV2ArtifactInputs()
    const forged = jsonClone(v2.artifact)
    ;(forged.acquisition.pages[0].payload as { portfolioId: string }).portfolioId = 'another-trader'
    forged.acquisition.pages[0].payload_sha256 = strictCanonicalSha256(
      forged.acquisition.pages[0].payload
    )
    forged.acquisition_source_run_id = strictCanonicalSha256(forged.acquisition)
    forged.candidate_ledger.acquisition_source_run_id = forged.acquisition_source_run_id
    forged.candidate_ledger_sha256 = strictCanonicalSha256(forged.candidate_ledger)
    const database = databaseHarness()

    await expect(
      writePositionHistoryRawArtifact(
        { artifact: forged, sourceRunId: strictCanonicalSha256(forged) },
        database.runTransaction
      )
    ).rejects.toThrow(
      'history artifact v2 is invalid: candidate_ledger_revalidation_failed:terminal_evidence_revalidation_failed'
    )
    expect(mockUpload).not.toHaveBeenCalled()
    expect(database.runTransaction).not.toHaveBeenCalled()
  })

  it('rejects a self-consistent @2 candidate omission before Storage or pointer I/O', async () => {
    const { v2 } = await verifiedV2ArtifactInputs()
    const omitted = jsonClone(v2.artifact)
    omitted.candidate_ledger.segments[0].pages[0].occurrences = []
    omitted.candidate_ledger.segments[0].pages[0].candidate_count = 0
    omitted.candidate_ledger.observed_candidate_count = 0
    omitted.candidate_ledger.source_facts = []
    omitted.candidate_ledger.unique_source_fact_count = 0
    omitted.candidate_ledger.fact_set_sha256 = strictCanonicalSha256([])
    omitted.candidate_ledger_sha256 = strictCanonicalSha256(omitted.candidate_ledger)
    const database = databaseHarness()

    await expect(
      writePositionHistoryRawArtifact(
        { artifact: omitted, sourceRunId: strictCanonicalSha256(omitted) },
        database.runTransaction
      )
    ).rejects.toThrow(
      'history artifact v2 is invalid: candidate_ledger_revalidation_failed:source_fact_ledger_mismatch'
    )
    expect(mockUpload).not.toHaveBeenCalled()
    expect(database.runTransaction).not.toHaveBeenCalled()
  })

  it('does not grant @2 the legacy @1 metadata replay exception', async () => {
    const { v2 } = await verifiedV2ArtifactInputs()
    const database = databaseHarness()
    await writePositionHistoryRawArtifact(v2, database.runTransaction)
    const meta = database.pointers[0].meta as Record<string, unknown>
    delete meta.acquisition_contract
    delete meta.acquisition_source_run_id
    delete meta.candidate_ledger_contract
    delete meta.candidate_ledger_sha256
    delete meta.source_fact_contract
    delete meta.observed_candidate_count
    delete meta.unique_source_fact_count
    delete meta.fact_set_sha256
    meta.history_evidence_contract = POSITION_HISTORY_PUBLICATION_EVIDENCE_CONTRACT

    await expect(writePositionHistoryRawArtifact(v2, database.runTransaction)).rejects.toThrow(
      'database pointer 41 does not match the artifact'
    )
  })

  describe('withVerifiedPositionHistoryRawArtifactV2', () => {
    it('locks, replays, and exposes acquisition-only evidence inside one transaction', async () => {
      const { v2 } = await verifiedV2ArtifactInputs()
      const database = databaseHarness()
      await writePositionHistoryRawArtifact(v2, database.runTransaction)
      database.query.mockClear()
      mockDownload.mockClear()
      let captured: LockedVerifiedPositionHistoryRawArtifactV2 | null = null
      const consume = jest.fn(
        async (
          transaction: IngestQueryExecutor,
          evidence: LockedVerifiedPositionHistoryRawArtifactV2
        ) => {
          expect(transaction).toBe(database.transaction)
          captured = evidence
          return { projectionReceipt: 'projection-1' }
        }
      )

      await expect(
        withVerifiedPositionHistoryRawArtifactV2(
          trustedV2ReadInput(v2),
          database.runTransaction,
          consume
        )
      ).resolves.toEqual({ projectionReceipt: 'projection-1' })

      expect(consume).toHaveBeenCalledTimes(1)
      expect(captured).toEqual({
        contract: v2.artifact.contract,
        trustScope: 'acquisition_and_source_facts',
        acquisitionSourceRunId: v2.artifact.acquisition_source_run_id,
        pointerSnapshot: {
          rawObjectId: 41,
          sourceRunId: v2.sourceRunId,
          storagePath:
            `binance_futures/history_trust/position_history/${v2.sourceRunId}/` +
            `event_history_${v2.sourceRunId}.json.gz`,
          fetchedAt,
        },
        candidateLedgerSha256: v2.artifact.candidate_ledger_sha256,
        artifact: v2.artifact,
      })
      expect(Object.isFrozen(captured)).toBe(true)
      expect(Object.isFrozen(captured!.pointerSnapshot)).toBe(true)
      expect(Object.isFrozen(captured!.artifact)).toBe(true)
      expect(Object.isFrozen(captured!.artifact.acquisition.pages[0])).toBe(true)
      expect(captured).not.toHaveProperty('parserComplete')
      expect(captured).not.toHaveProperty('priceComplete')
      expect(captured).not.toHaveProperty('costBasisComplete')
      expect(captured).not.toHaveProperty('rankEligible')
      expect(mockDownload).toHaveBeenCalledTimes(1)
      expect(database.query).toHaveBeenCalledTimes(4)
      expect(String(database.query.mock.calls[0][0])).toContain('pg_advisory_xact_lock')
      expect(
        database.query.mock.calls.filter(([sql]) => String(sql).includes('AS gc_pending'))
      ).toHaveLength(2)
      expect(
        database.query.mock.calls
          .filter(([sql]) => String(sql).includes('AS gc_pending'))
          .every(([sql]) => String(sql).includes('FOR SHARE'))
      ).toBe(true)
      expect(String(database.query.mock.calls[2][0])).toContain(
        'fetched_at = $2::timestamptz AS exact_instant'
      )
    })

    it('accepts a terminally verified true-empty @2 history without inventing candidates', async () => {
      const { v2 } = await verifiedV2ArtifactInputs({ empty: true })
      const database = databaseHarness()
      await writePositionHistoryRawArtifact(v2, database.runTransaction)

      await expect(
        withVerifiedPositionHistoryRawArtifactV2(
          trustedV2ReadInput(v2),
          database.runTransaction,
          async (_transaction, evidence) => ({
            observed: evidence.artifact.candidate_ledger.observed_candidate_count,
            facts: evidence.artifact.candidate_ledger.unique_source_fact_count,
          })
        )
      ).resolves.toEqual({ observed: 0, facts: 0 })
    })

    it('rejects @1, legacy @1 metadata, and unknown contracts before Storage download', async () => {
      const input = await artifactInput()
      const database = databaseHarness()
      await writePositionHistoryRawArtifact(input, database.runTransaction)
      mockDownload.mockClear()
      const consume = jest.fn(async () => null)

      await expect(
        withVerifiedPositionHistoryRawArtifactV2(
          trustedV2ReadInput(input),
          database.runTransaction,
          consume
        )
      ).rejects.toThrow('locked pointer does not match the expected @2 identity')

      const meta = database.pointers[0].meta as Record<string, unknown>
      delete meta.history_evidence_contract
      delete meta.attempt_started_at
      delete meta.starting_cursor
      delete meta.capture_config
      delete meta.observed_at
      delete meta.termination
      await expect(
        withVerifiedPositionHistoryRawArtifactV2(
          trustedV2ReadInput(input),
          database.runTransaction,
          consume
        )
      ).rejects.toThrow('locked pointer does not match the expected @2 identity')

      const unknownMeta = database.pointers[0].meta as Record<string, unknown>
      unknownMeta.data_contract = 'arena.position-history-acquisition-artifact@999'
      await expect(
        withVerifiedPositionHistoryRawArtifactV2(
          trustedV2ReadInput(input),
          database.runTransaction,
          consume
        )
      ).rejects.toThrow('locked pointer does not match the expected @2 identity')
      expect(mockDownload).not.toHaveBeenCalled()
      expect(consume).not.toHaveBeenCalled()
    })

    it('rejects every external coordinate drift and nested @1 digest before download', async () => {
      const { v2 } = await verifiedV2ArtifactInputs()
      const database = databaseHarness()
      await writePositionHistoryRawArtifact(v2, database.runTransaction)
      mockDownload.mockClear()
      const valid = trustedV2ReadInput(v2)
      const invalidInputs = [
        { ...valid, expectedSourceId: 2 },
        { ...valid, expectedSourceSlug: 'other_source' },
        { ...valid, expectedTraderId: 12 },
        { ...valid, expectedExchangeTraderId: 'portfolio-2' },
        { ...valid, expectedSourceRunId: v2.artifact.acquisition_source_run_id },
      ]

      for (const invalid of invalidInputs) {
        await expect(
          withVerifiedPositionHistoryRawArtifactV2(
            invalid,
            database.runTransaction,
            async () => null
          )
        ).rejects.toThrow('locked pointer does not match the expected @2 identity')
      }
      expect(mockDownload).not.toHaveBeenCalled()
    })

    it('rejects pointer identity, quarantine, role, and integrity drift before download', async () => {
      const { v2 } = await verifiedV2ArtifactInputs()
      const database = databaseHarness()
      await writePositionHistoryRawArtifact(v2, database.runTransaction)
      mockDownload.mockClear()
      const original = pointerSnapshot(database.pointers[0])
      const mutations: Array<(pointer: PointerRow) => void> = [
        (pointer) => {
          pointer.job_type = 'history:orders'
        },
        (pointer) => {
          pointer.timeframe = 7
        },
        (pointer) => {
          pointer.fetched_at = 'not-a-timestamp'
        },
        (pointer) => {
          pointer.storage_path = `${pointer.storage_path}.moved`
        },
        (pointer) => {
          pointer.bytes += 1
        },
        (pointer) => {
          pointer.content_hash = 'f'.repeat(64)
        },
        (pointer) => {
          pointer.quarantined = true
        },
        (pointer) => {
          pointer.source_run_id = 'f'.repeat(64)
        },
        (pointer) => {
          pointer.trust_artifact_role = 'manifest'
        },
        (pointer) => {
          const meta = pointer.meta as Record<string, unknown>
          const integrity = meta.raw_integrity as Record<string, unknown>
          integrity.serialization_contract = 'arena.raw-json-stringify@1'
        },
        (pointer) => {
          const meta = pointer.meta as Record<string, unknown>
          const integrity = meta.raw_integrity as Record<string, unknown>
          integrity.uncompressed_bytes = 256 * 1024 * 1024 + 1
        },
      ]

      for (const mutate of mutations) {
        database.pointers.splice(0, 1, pointerSnapshot(original))
        mutate(database.pointers[0])
        await expect(
          withVerifiedPositionHistoryRawArtifactV2(
            trustedV2ReadInput(v2),
            database.runTransaction,
            async () => null
          )
        ).rejects.toThrow('locked pointer does not match the expected @2 identity')
      }
      expect(mockDownload).not.toHaveBeenCalled()
    })

    it('rejects duplicate run pointers, tombstones, and pending GC paths before download', async () => {
      const { v2 } = await verifiedV2ArtifactInputs()
      const database = databaseHarness()
      await writePositionHistoryRawArtifact(v2, database.runTransaction)
      mockDownload.mockClear()
      const original = pointerSnapshot(database.pointers[0])

      database.pointers.push({
        ...pointerSnapshot(original),
        id: 42,
        storage_path: `${original.storage_path}.duplicate`,
      })
      await expect(
        withVerifiedPositionHistoryRawArtifactV2(
          trustedV2ReadInput(v2),
          database.runTransaction,
          async () => null
        )
      ).rejects.toThrow('expected one locked pointer for the outer source run, found 2')

      database.pointers.splice(0, database.pointers.length)
      await expect(
        withVerifiedPositionHistoryRawArtifactV2(
          trustedV2ReadInput(v2),
          database.runTransaction,
          async () => null
        )
      ).rejects.toThrow('expected one locked pointer for the outer source run, found 0')

      const gcDatabase = databaseHarness([original], { gcPending: true })
      await expect(
        withVerifiedPositionHistoryRawArtifactV2(
          trustedV2ReadInput(v2),
          gcDatabase.runTransaction,
          async () => null
        )
      ).rejects.toThrow('locked pointer does not match the expected @2 identity')
      expect(mockDownload).not.toHaveBeenCalled()
    })

    it('requires exact current @2 metadata after replay, with no missing or extra fields', async () => {
      const { v2 } = await verifiedV2ArtifactInputs()
      const database = databaseHarness()
      await writePositionHistoryRawArtifact(v2, database.runTransaction)
      mockDownload.mockClear()
      const originalMeta = jsonClone(database.pointers[0].meta) as Record<string, unknown>
      const consume = jest.fn(async () => null)

      const extraMeta = jsonClone(originalMeta)
      extraMeta.rank_eligible = true
      database.pointers[0].meta = extraMeta
      await expect(
        withVerifiedPositionHistoryRawArtifactV2(
          trustedV2ReadInput(v2),
          database.runTransaction,
          consume
        )
      ).rejects.toThrow('locked pointer metadata is not the exact @2 evidence contract')

      const missingMeta = jsonClone(originalMeta)
      delete missingMeta.candidate_ledger_sha256
      database.pointers[0].meta = missingMeta
      await expect(
        withVerifiedPositionHistoryRawArtifactV2(
          trustedV2ReadInput(v2),
          database.runTransaction,
          consume
        )
      ).rejects.toThrow('locked pointer metadata is not the exact @2 evidence contract')
      expect(mockDownload).toHaveBeenCalledTimes(2)
      expect(consume).not.toHaveBeenCalled()
    })

    it('uses PostgreSQL equality and clock bounds for the exact observation instant', async () => {
      const { v2 } = await verifiedV2ArtifactInputs()
      const database = databaseHarness([], { exactInstant: false })
      await writePositionHistoryRawArtifact(v2, database.runTransaction)
      database.pointers[0].fetched_at = '2026-08-03T10:00:01.000001Z'
      expect(Date.parse(database.pointers[0].fetched_at)).toBe(Date.parse(fetchedAt))
      const consume = jest.fn(async () => null)

      await expect(
        withVerifiedPositionHistoryRawArtifactV2(
          trustedV2ReadInput(v2),
          database.runTransaction,
          consume
        )
      ).rejects.toThrow('locked pointer timestamp does not match the @2 observation clock')
      expect(consume).not.toHaveBeenCalled()

      storage.clear()
      const futureDatabase = databaseHarness([], { notFuture: false })
      await writePositionHistoryRawArtifact(v2, futureDatabase.runTransaction)
      await expect(
        withVerifiedPositionHistoryRawArtifactV2(
          trustedV2ReadInput(v2),
          futureDatabase.runTransaction,
          consume
        )
      ).rejects.toThrow('locked pointer timestamp does not match the @2 observation clock')
      expect(consume).not.toHaveBeenCalled()
    })

    it('rejects unavailable, truncated, corrupt, non-UTF8, invalid, and noncanonical Storage', async () => {
      const { v2 } = await verifiedV2ArtifactInputs()
      const database = databaseHarness()
      const receipt = await writePositionHistoryRawArtifact(v2, database.runTransaction)
      const originalPointer = pointerSnapshot(database.pointers[0])
      const originalGzip = Buffer.from(storage.get(receipt.storagePath)!)
      const consume = jest.fn(async () => null)

      function reset(): void {
        database.pointers.splice(0, database.pointers.length, pointerSnapshot(originalPointer))
        storage.clear()
        storage.set(originalPointer.storage_path, Buffer.from(originalGzip))
      }

      function rebindUncompressedBytes(bytes: Buffer) {
        const pointer = database.pointers[0]
        const sourceRunId = createHash('sha256').update(bytes).digest('hex')
        const gz = gzipSync(bytes)
        storage.delete(pointer.storage_path)
        pointer.storage_path =
          `binance_futures/history_trust/position_history/${sourceRunId}/` +
          `event_history_${sourceRunId}.json.gz`
        pointer.bytes = gz.byteLength
        pointer.content_hash = sourceRunId
        pointer.source_run_id = sourceRunId
        const meta = pointer.meta as Record<string, unknown>
        meta.source_run_id = sourceRunId
        const integrity = meta.raw_integrity as Record<string, unknown>
        integrity.compressed_bytes = gz.byteLength
        integrity.uncompressed_bytes = bytes.byteLength
        storage.set(pointer.storage_path, gz)
        return { ...trustedV2ReadInput(v2), expectedSourceRunId: sourceRunId }
      }

      storage.delete(receipt.storagePath)
      await expect(
        withVerifiedPositionHistoryRawArtifactV2(
          trustedV2ReadInput(v2),
          database.runTransaction,
          consume
        )
      ).rejects.toThrow('RAW download failed')

      reset()
      mockDownload.mockImplementationOnce(async () => ({
        data: {
          arrayBuffer: async () => {
            throw new Error('stream failed')
          },
        },
        error: null,
      }))
      await expect(
        withVerifiedPositionHistoryRawArtifactV2(
          trustedV2ReadInput(v2),
          database.runTransaction,
          consume
        )
      ).rejects.toThrow('RAW download body failed')

      reset()
      storage.set(receipt.storagePath, Buffer.concat([originalGzip, Buffer.from([0])]))
      await expect(
        withVerifiedPositionHistoryRawArtifactV2(
          trustedV2ReadInput(v2),
          database.runTransaction,
          consume
        )
      ).rejects.toThrow('compressed byte count mismatch')

      reset()
      const badHeader = Buffer.from([0, 0, 0])
      storage.set(receipt.storagePath, badHeader)
      database.pointers[0].bytes = badHeader.byteLength
      const badHeaderMeta = database.pointers[0].meta as Record<string, unknown>
      ;(badHeaderMeta.raw_integrity as Record<string, unknown>).compressed_bytes =
        badHeader.byteLength
      await expect(
        withVerifiedPositionHistoryRawArtifactV2(
          trustedV2ReadInput(v2),
          database.runTransaction,
          consume
        )
      ).rejects.toThrow('invalid gzip header')

      reset()
      const badGzip = Buffer.from([0x1f, 0x8b, 0x08, 0])
      storage.set(receipt.storagePath, badGzip)
      database.pointers[0].bytes = badGzip.byteLength
      const badGzipMeta = database.pointers[0].meta as Record<string, unknown>
      ;(badGzipMeta.raw_integrity as Record<string, unknown>).compressed_bytes = badGzip.byteLength
      await expect(
        withVerifiedPositionHistoryRawArtifactV2(
          trustedV2ReadInput(v2),
          database.runTransaction,
          consume
        )
      ).rejects.toThrow('gzip payload or trailer is corrupt')

      reset()
      const wrongUncompressedMeta = database.pointers[0].meta as Record<string, unknown>
      const wrongUncompressedIntegrity = wrongUncompressedMeta.raw_integrity as Record<
        string,
        unknown
      >
      wrongUncompressedIntegrity.uncompressed_bytes =
        Number(wrongUncompressedIntegrity.uncompressed_bytes) + 1
      await expect(
        withVerifiedPositionHistoryRawArtifactV2(
          trustedV2ReadInput(v2),
          database.runTransaction,
          consume
        )
      ).rejects.toThrow('raw_integrity.uncompressed_bytes mismatch')

      reset()
      const foreignJson = Buffer.from('{}', 'utf8')
      const foreignGzip = gzipSync(foreignJson)
      storage.set(receipt.storagePath, foreignGzip)
      database.pointers[0].bytes = foreignGzip.byteLength
      const foreignMeta = database.pointers[0].meta as Record<string, unknown>
      const foreignIntegrity = foreignMeta.raw_integrity as Record<string, unknown>
      foreignIntegrity.compressed_bytes = foreignGzip.byteLength
      foreignIntegrity.uncompressed_bytes = foreignJson.byteLength
      await expect(
        withVerifiedPositionHistoryRawArtifactV2(
          trustedV2ReadInput(v2),
          database.runTransaction,
          consume
        )
      ).rejects.toThrow('SHA-256 checksum mismatch')

      reset()
      await expect(
        withVerifiedPositionHistoryRawArtifactV2(
          rebindUncompressedBytes(Buffer.from([0xc3, 0x28])),
          database.runTransaction,
          consume
        )
      ).rejects.toThrow('payload is not valid UTF-8')

      reset()
      await expect(
        withVerifiedPositionHistoryRawArtifactV2(
          rebindUncompressedBytes(Buffer.from('not-json', 'utf8')),
          database.runTransaction,
          consume
        )
      ).rejects.toThrow('payload is not valid JSON')

      reset()
      await expect(
        withVerifiedPositionHistoryRawArtifactV2(
          rebindUncompressedBytes(Buffer.from(JSON.stringify(v2.artifact, null, 2), 'utf8')),
          database.runTransaction,
          consume
        )
      ).rejects.toThrow('strict canonical serialization mismatch')
      expect(consume).not.toHaveBeenCalled()
    })

    it('semantically rejects fully rehashed terminal forgery and candidate omission', async () => {
      const { v2 } = await verifiedV2ArtifactInputs()
      const database = databaseHarness()
      const receipt = await writePositionHistoryRawArtifact(v2, database.runTransaction)
      const originalPointer = pointerSnapshot(database.pointers[0])
      const originalGzip = Buffer.from(storage.get(receipt.storagePath)!)
      const consume = jest.fn(async () => null)

      function reset(): void {
        database.pointers.splice(0, database.pointers.length, pointerSnapshot(originalPointer))
        storage.clear()
        storage.set(originalPointer.storage_path, Buffer.from(originalGzip))
      }

      function rebindArtifact(artifact: PositionHistoryAcquisitionArtifactV2) {
        const json = strictCanonicalJson(artifact)
        const bytes = Buffer.from(json, 'utf8')
        const gz = gzipSync(bytes)
        const sourceRunId = strictCanonicalSha256(artifact)
        const pointer = database.pointers[0]
        storage.delete(pointer.storage_path)
        pointer.storage_path =
          `binance_futures/history_trust/position_history/${sourceRunId}/` +
          `event_history_${sourceRunId}.json.gz`
        pointer.bytes = gz.byteLength
        pointer.content_hash = sourceRunId
        pointer.source_run_id = sourceRunId
        const meta = pointer.meta as Record<string, unknown>
        meta.source_run_id = sourceRunId
        meta.acquisition_source_run_id = artifact.acquisition_source_run_id
        meta.candidate_ledger_sha256 = artifact.candidate_ledger_sha256
        meta.observed_candidate_count = artifact.candidate_ledger.observed_candidate_count
        meta.unique_source_fact_count = artifact.candidate_ledger.unique_source_fact_count
        meta.fact_set_sha256 = artifact.candidate_ledger.fact_set_sha256
        const integrity = meta.raw_integrity as Record<string, unknown>
        integrity.compressed_bytes = gz.byteLength
        integrity.uncompressed_bytes = bytes.byteLength
        storage.set(pointer.storage_path, gz)
        return { ...trustedV2ReadInput(v2), expectedSourceRunId: sourceRunId }
      }

      const terminalForgery = jsonClone(v2.artifact)
      ;(terminalForgery.acquisition.pages[0].payload as { portfolioId: string }).portfolioId =
        'another-trader'
      terminalForgery.acquisition.pages[0].payload_sha256 = strictCanonicalSha256(
        terminalForgery.acquisition.pages[0].payload
      )
      terminalForgery.acquisition_source_run_id = strictCanonicalSha256(terminalForgery.acquisition)
      terminalForgery.candidate_ledger.acquisition_source_run_id =
        terminalForgery.acquisition_source_run_id
      terminalForgery.candidate_ledger_sha256 = strictCanonicalSha256(
        terminalForgery.candidate_ledger
      )
      await expect(
        withVerifiedPositionHistoryRawArtifactV2(
          rebindArtifact(terminalForgery),
          database.runTransaction,
          consume
        )
      ).rejects.toThrow('@2 semantic replay failed')

      reset()
      const omission = jsonClone(v2.artifact)
      omission.candidate_ledger.segments[0].pages[0].occurrences = []
      omission.candidate_ledger.segments[0].pages[0].candidate_count = 0
      omission.candidate_ledger.observed_candidate_count = 0
      omission.candidate_ledger.source_facts = []
      omission.candidate_ledger.unique_source_fact_count = 0
      omission.candidate_ledger.fact_set_sha256 = strictCanonicalSha256([])
      omission.candidate_ledger_sha256 = strictCanonicalSha256(omission.candidate_ledger)
      await expect(
        withVerifiedPositionHistoryRawArtifactV2(
          rebindArtifact(omission),
          database.runTransaction,
          consume
        )
      ).rejects.toThrow('@2 semantic replay failed')
      expect(consume).not.toHaveBeenCalled()
    })

    it('detects and rolls back consumer pointer, deletion, quarantine, and GC mutations', async () => {
      const { v2 } = await verifiedV2ArtifactInputs()
      const database = databaseHarness()
      await writePositionHistoryRawArtifact(v2, database.runTransaction)
      const original = pointerSnapshot(database.pointers[0])

      await expect(
        withVerifiedPositionHistoryRawArtifactV2(
          trustedV2ReadInput(v2),
          database.runTransaction,
          async () => {
            const meta = database.pointers[0].meta as Record<string, unknown>
            meta.consumer_mutation = true
          }
        )
      ).rejects.toThrow('locked pointer changed during @2 consumption')
      expect(database.pointers).toEqual([original])

      await expect(
        withVerifiedPositionHistoryRawArtifactV2(
          trustedV2ReadInput(v2),
          database.runTransaction,
          async () => {
            database.pointers[0].quarantined = true
          }
        )
      ).rejects.toThrow('locked pointer does not match the expected @2 identity')
      expect(database.pointers).toEqual([original])

      await expect(
        withVerifiedPositionHistoryRawArtifactV2(
          trustedV2ReadInput(v2),
          database.runTransaction,
          async () => {
            database.pointers.splice(0, 1)
          }
        )
      ).rejects.toThrow('expected one locked pointer for the outer source run, found 0')
      expect(database.pointers).toEqual([original])

      await expect(
        withVerifiedPositionHistoryRawArtifactV2(
          trustedV2ReadInput(v2),
          database.runTransaction,
          async () => {
            database.pointers.push({
              ...pointerSnapshot(original),
              id: 42,
              storage_path: `${original.storage_path}.consumer-duplicate`,
            })
          }
        )
      ).rejects.toThrow('expected one locked pointer for the outer source run, found 2')
      expect(database.pointers).toEqual([original])

      await expect(
        withVerifiedPositionHistoryRawArtifactV2(
          trustedV2ReadInput(v2),
          database.runTransaction,
          async () => {
            database.gcPendingPaths.add(original.storage_path)
          }
        )
      ).rejects.toThrow('locked pointer does not match the expected @2 identity')
      expect(database.gcPendingPaths).toEqual(new Set())
      expect(database.pointers).toEqual([original])
    })

    it('validates the runner and consumer before any I/O and preserves consumer errors', async () => {
      const { v2 } = await verifiedV2ArtifactInputs()
      const database = databaseHarness()
      const unsafeRead = withVerifiedPositionHistoryRawArtifactV2 as unknown as (
        input: ReturnType<typeof trustedV2ReadInput>,
        runner?: IngestTransactionRunner,
        consume?: (
          transaction: IngestQueryExecutor,
          evidence: LockedVerifiedPositionHistoryRawArtifactV2
        ) => Promise<unknown>
      ) => Promise<unknown>

      await expect(unsafeRead(trustedV2ReadInput(v2))).rejects.toThrow(
        'a claimed transaction runner is required'
      )
      await expect(unsafeRead(trustedV2ReadInput(v2), database.runTransaction)).rejects.toThrow(
        'a locked consumer is required'
      )
      expect(database.runTransaction).not.toHaveBeenCalled()
      expect(mockDownload).not.toHaveBeenCalled()

      await writePositionHistoryRawArtifact(v2, database.runTransaction)
      const consumerError = new Error('projection consumer failed')
      await expect(
        withVerifiedPositionHistoryRawArtifactV2(
          trustedV2ReadInput(v2),
          database.runTransaction,
          async () => {
            throw consumerError
          }
        )
      ).rejects.toBe(consumerError)
    })
  })
})
