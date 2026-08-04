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
  EVENT_HISTORY_PUBLICATION_EVIDENCE_CONTRACT,
  EVENT_HISTORY_RAW_ARTIFACT_ROLE,
  historyRawJobType,
  POSITION_HISTORY_PUBLICATION_EVIDENCE_CONTRACT,
  POSITION_HISTORY_RAW_JOB_TYPE,
  type IngestTransactionRunner,
  writeHistoryRawArtifact,
  writePositionHistoryRawArtifact,
  type WritePositionHistoryRawArtifactInput,
} from '@/lib/ingest/raw'
import { strictCanonicalJson } from '@/lib/ingest/strict-canonical-json'

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
  options: { kind?: HistoryKind; upstreamError?: boolean; missingClaim?: boolean } = {}
): Promise<WritePositionHistoryRawArtifactInput> {
  const kind = options.kind ?? 'position_history'
  async function* stream(): AsyncGenerator<RawPage, HistoryTerminalClaim | undefined, void> {
    yield {
      pageIndex: 1,
      payload: { data: [{ id: 'closed-position-1' }], total: 1 },
      url: 'https://example.test/history?page=1',
      fetchedAt,
    }
    if (options.upstreamError) throw new Error('upstream failed after the durable page')
    return options.missingClaim ? undefined : terminalClaim()
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

function downloadBody(payload: Buffer) {
  return {
    arrayBuffer: async () =>
      payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
  }
}

function databaseHarness(initialRows: PointerRow[] = []) {
  const pointers = initialRows.map((row) => ({ ...row }))
  let nextId = 41
  const query = jest.fn(async (sqlInput: unknown, params: unknown[] = []) => {
    const sql = String(sqlInput)
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] }
    if (sql.startsWith('SELECT id, source_id')) {
      return {
        rows: pointers.filter(
          (pointer) =>
            pointer.storage_path === params[0] ||
            (pointer.source_run_id === params[1] &&
              pointer.trust_artifact_role === EVENT_HISTORY_RAW_ARTIFACT_ROLE)
        ),
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
    async <T>(operation: (executor: IngestQueryExecutor) => Promise<T>): Promise<T> =>
      operation(transaction)
  ) as IngestTransactionRunner & jest.Mock
  return { pointers, query, runTransaction }
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

  it.each<HistoryKind>(['orders', 'transfers', 'copiers'])(
    'persists %s as its own deterministic event-history artifact',
    async (kind) => {
      const input = await artifactInput({ kind })
      const database = databaseHarness()

      const receipt = await writeHistoryRawArtifact(input, database.runTransaction)

      expect(receipt.storagePath).toBe(
        `binance_futures/history_trust/${kind}/${input.sourceRunId}/` +
          `event_history_${input.sourceRunId}.json.gz`
      )
      expect(database.pointers).toHaveLength(1)
      expect(database.pointers[0]).toMatchObject({
        job_type: historyRawJobType(kind),
        source_run_id: input.sourceRunId,
        trust_artifact_role: EVENT_HISTORY_RAW_ARTIFACT_ROLE,
      })
      expect(database.pointers[0].meta).toMatchObject({
        surface: kind,
        history_kind: kind,
        history_evidence_contract: EVENT_HISTORY_PUBLICATION_EVIDENCE_CONTRACT,
        termination: input.artifact.termination,
      })
    }
  )

  it('replays an exact generic artifact without duplicating its pointer', async () => {
    const input = await artifactInput({ kind: 'orders' })
    const database = databaseHarness()

    const first = await writeHistoryRawArtifact(input, database.runTransaction)
    const second = await writeHistoryRawArtifact(input, database.runTransaction)

    expect(second).toEqual(first)
    expect(database.pointers).toHaveLength(1)
    expect(mockUpload).toHaveBeenCalledTimes(2)
    expect(mockDownload).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['missing claim', { missingClaim: true }, 'missing'],
    ['upstream error', { upstreamError: true }, 'upstream_error'],
  ] as const)(
    'persists generic %s evidence without upgrading it',
    async (_label, options, evidenceState) => {
      const input = await artifactInput({ kind: 'orders', ...options })
      const database = databaseHarness()

      await writeHistoryRawArtifact(input, database.runTransaction)

      expect(input.artifact.termination.evidence_state).toBe(evidenceState)
      expect(database.pointers[0].meta).toMatchObject({
        surface: 'orders',
        terminal_evidence_state: evidenceState,
        termination: input.artifact.termination,
      })
    }
  )

  it('rejects a generic retry whose pointer changed history kind', async () => {
    const input = await artifactInput({ kind: 'orders' })
    const database = databaseHarness()
    await writeHistoryRawArtifact(input, database.runTransaction)
    database.pointers[0].job_type = POSITION_HISTORY_RAW_JOB_TYPE

    await expect(writeHistoryRawArtifact(input, database.runTransaction)).rejects.toThrow(
      'database pointer 41 does not match the artifact'
    )
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
})
