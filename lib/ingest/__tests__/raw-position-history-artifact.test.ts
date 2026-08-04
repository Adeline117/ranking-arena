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
import {
  BITGET_HISTORY_PAGE_ENVELOPE_CONTRACT,
  BITGET_POSITION_HISTORY_URL,
  bitgetPositionHistoryTerminalVerifier,
} from '@/lib/ingest/adapters/bitget/history-terminal'
import type { IngestQueryExecutor } from '@/lib/ingest/db'
import {
  captureHistoryAcquisition,
  HISTORY_TERMINAL_CLAIM_CONTRACT,
  type HistoryTerminalClaim,
  type SelectedHistoryTerminalVerifier,
} from '@/lib/ingest/history-acquisition'
import {
  EVENT_HISTORY_PUBLICATION_EVIDENCE_CONTRACT,
  EVENT_HISTORY_RAW_ARTIFACT_ROLE,
  historyRawJobType,
  POSITION_HISTORY_AUDIT_EVIDENCE_CONTRACT,
  POSITION_HISTORY_PUBLICATION_EVIDENCE_CONTRACT,
  POSITION_HISTORY_RAW_JOB_TYPE,
  prepareHistoryRawArtifactReconciliationExpectation,
  type IngestTransactionRunner,
  writeHistoryRawArtifact,
  writePositionHistoryRawArtifact,
  type WritePositionHistoryRawArtifactInput,
} from '@/lib/ingest/raw'
import {
  POSITION_HISTORY_PAGE_MANIFEST_KEYS,
  POSITION_HISTORY_RAW_META_KEYS,
  POSITION_HISTORY_SOURCE_ROW_MANIFEST_KEYS,
} from '@/lib/ingest/reviewed-position-history'
import { strictCanonicalJson, strictCanonicalSha256 } from '@/lib/ingest/strict-canonical-json'

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
const openedMs = String(Date.parse('2026-08-03T08:00:00.000Z'))
const closedMs = String(Date.parse('2026-08-03T09:00:00.000Z'))

function terminalClaim(): HistoryTerminalClaim {
  return {
    contract: HISTORY_TERMINAL_CLAIM_CONTRACT,
    observations: [{ segment_id: 'default', reason: 'reported_end', page_ordinal: 1 }],
  }
}

async function artifactInput(
  options: {
    kind?: HistoryKind
    upstreamError?: boolean
    missingClaim?: boolean
    sourceSlug?: string
  } = {}
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
    source: { id: 1, slug: options.sourceSlug ?? 'binance_futures' },
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

function reviewedBitgetRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orderNo: 'order-1',
    openTime: openedMs,
    closeTime: closedMs,
    symbolDisplayName: 'BTCUSDT',
    position: 1,
    openLevel: '5',
    closeDealCount: '2',
    openAvgPrice: '100',
    closeAvgPrice: '110',
    netProfit: '20',
    returnRate: '0.2',
    ...overrides,
  }
}

async function reviewedBitgetArtifactInput(
  rows: readonly Record<string, unknown>[] = [reviewedBitgetRaw()],
  terminalVerifier: SelectedHistoryTerminalVerifier = bitgetPositionHistoryTerminalVerifier,
  exchangeTraderId = 'portfolio-1'
): Promise<WritePositionHistoryRawArtifactInput> {
  async function* stream(): AsyncGenerator<RawPage, HistoryTerminalClaim, void> {
    yield {
      pageIndex: 1,
      url: BITGET_POSITION_HISTORY_URL,
      fetchedAt,
      payload: {
        contract: BITGET_HISTORY_PAGE_ENVELOPE_CONTRACT,
        historyTraderIdentity: exchangeTraderId,
        request: { pageNo: 1, pageSize: 20, traderUid: exchangeTraderId },
        response: { code: '00000', data: { rows, nextFlag: false } },
      },
    }
    return terminalClaim()
  }

  const captured = await captureHistoryAcquisition({
    source: { id: 7, slug: 'bitget_futures' },
    traderId: 11,
    exchangeTraderId,
    kind: 'position_history',
    cursor: null,
    attemptStartedAt,
    stream: stream(),
    terminalVerifier,
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

  it('stores reviewed evidence with the exact publication metadata and manifest contract', async () => {
    const sourceRow = reviewedBitgetRaw()
    const input = await reviewedBitgetArtifactInput([sourceRow])
    const database = databaseHarness()

    const receipt = await writePositionHistoryRawArtifact(input, database.runTransaction)

    expect(receipt).toEqual({
      id: 41,
      storagePath:
        `bitget_futures/history_trust/position_history/${input.sourceRunId}/` +
        `event_history_${input.sourceRunId}.json.gz`,
      contentHash: input.sourceRunId,
    })
    expect(database.runTransaction).toHaveBeenCalledTimes(1)
    expect(database.pointers).toHaveLength(1)
    expect(database.pointers[0]).toMatchObject({
      source_id: 7,
      job_type: POSITION_HISTORY_RAW_JOB_TYPE,
      trader_id: 11,
      timeframe: null,
      fetched_at: fetchedAt,
      content_hash: input.sourceRunId,
      source_run_id: input.sourceRunId,
      trust_artifact_role: EVENT_HISTORY_RAW_ARTIFACT_ROLE,
      quarantined: false,
    })
    const meta = database.pointers[0].meta as Record<string, unknown>
    const reconciliation = prepareHistoryRawArtifactReconciliationExpectation(input)
    expect(reconciliation).toMatchObject({
      bytes: database.pointers[0].bytes,
      contentHash: input.sourceRunId,
      fetchedAt,
      storagePath: receipt.storagePath,
    })
    expect(reconciliation.metaCandidatesCanonicalJson).toContain(strictCanonicalJson(meta))
    const alternateCompressedBytes = database.pointers[0].bytes + 7
    const crossRuntimeReconciliation = prepareHistoryRawArtifactReconciliationExpectation(
      input,
      alternateCompressedBytes
    )
    expect(crossRuntimeReconciliation.bytes).toBe(alternateCompressedBytes)
    expect(
      crossRuntimeReconciliation.metaCandidatesCanonicalJson.some((candidate) =>
        candidate.includes(`"compressed_bytes":${alternateCompressedBytes}`)
      )
    ).toBe(true)
    expect(Object.keys(meta).sort()).toEqual(POSITION_HISTORY_RAW_META_KEYS)
    expect(meta).toMatchObject({
      data_contract: input.artifact.contract,
      history_evidence_contract: POSITION_HISTORY_PUBLICATION_EVIDENCE_CONTRACT,
      history_kind: 'position_history',
      source_slug: 'bitget_futures',
      source_run_id: input.sourceRunId,
      exchange_trader_id: 'portfolio-1',
      attempt_started_at: attemptStartedAt,
      starting_cursor: null,
      capture_config: { caller_page_cap: null },
      observed_at: fetchedAt,
      page_count: 1,
      parser_contract: 'arena.ingest.position-history-parser.bitget@1',
      source_contract: 'arena.ingest.position-history-source.bitget_futures@1',
      verifier_contract: bitgetPositionHistoryTerminalVerifier.contract,
      termination: input.artifact.termination,
      raw_integrity: {
        serialization_contract: 'arena.strict-canonical-json@1',
        hash_scope: 'json_utf8',
      },
    })
    const pageManifest = meta.page_manifest as Array<Record<string, unknown>>
    expect(pageManifest).toHaveLength(1)
    expect(Object.keys(pageManifest[0]).sort()).toEqual(POSITION_HISTORY_PAGE_MANIFEST_KEYS)
    expect(pageManifest[0]).toMatchObject({
      classification: 'canonical_materialized',
      fetched_at: fetchedAt,
      ordinal: 1,
      payload_sha256: input.artifact.pages[0].payload_sha256,
      segment_id: 'default',
      stored_page_index: 1,
    })
    const sourceRows = pageManifest[0].source_rows as Array<Record<string, unknown>>
    expect(sourceRows).toHaveLength(1)
    expect(Object.keys(sourceRows[0]).sort()).toEqual(POSITION_HISTORY_SOURCE_ROW_MANIFEST_KEYS)
    expect(sourceRows[0]).toEqual({
      source_row_ordinal: 1,
      source_row_sha256: strictCanonicalSha256(sourceRow),
    })
    const uploaded = storage.get(receipt.storagePath)
    expect(uploaded).toBeDefined()
    expect(gunzipSync(uploaded!).toString('utf8')).toBe(strictCanonicalJson(input.artifact))
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('returns the same pointer on an exact retry after verifying existing Storage content', async () => {
    const input = await reviewedBitgetArtifactInput()
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

  it('persists rejected reviewed evidence as a fixed-code nonpublication audit artifact', async () => {
    const input = await artifactInput()
    const database = databaseHarness()

    await writePositionHistoryRawArtifact(input, database.runTransaction)

    const meta = database.pointers[0].meta as Record<string, unknown>
    expect(
      prepareHistoryRawArtifactReconciliationExpectation(input).metaCandidatesCanonicalJson
    ).toContain(strictCanonicalJson(meta))
    expect(Object.keys(meta).sort()).toEqual([
      'attempt_started_at',
      'audit_reason',
      'capture_config',
      'data_contract',
      'exchange_trader_id',
      'history_evidence_contract',
      'history_kind',
      'observed_at',
      'page_count',
      'publication_eligible',
      'raw_integrity',
      'source_run_id',
      'source_slug',
      'starting_cursor',
      'surface',
      'termination',
    ])
    expect(meta).toMatchObject({
      surface: 'position_history_audit',
      publication_eligible: false,
      history_evidence_contract: POSITION_HISTORY_AUDIT_EVIDENCE_CONTRACT,
      audit_reason: 'source_container_invalid',
      source_run_id: input.sourceRunId,
      termination: input.artifact.termination,
    })
    expect(JSON.stringify(meta)).not.toContain('[reviewed-position-history]')
    expect(meta).not.toHaveProperty('parser_contract')
    expect(meta).not.toHaveProperty('page_manifest')
  })

  it('persists parser-accounting failures and replays their exact audit pointer', async () => {
    const missingSymbol = reviewedBitgetRaw()
    delete missingSymbol.symbolDisplayName
    const input = await reviewedBitgetArtifactInput([missingSymbol])
    const database = databaseHarness()

    const first = await writePositionHistoryRawArtifact(input, database.runTransaction)
    const second = await writePositionHistoryRawArtifact(input, database.runTransaction)

    expect(second).toEqual(first)
    expect(database.pointers).toHaveLength(1)
    expect(database.pointers[0].meta).toMatchObject({
      surface: 'position_history_audit',
      publication_eligible: false,
      history_evidence_contract: POSITION_HISTORY_AUDIT_EVIDENCE_CONTRACT,
      audit_reason: 'source_candidate_accounting_failed',
      termination: input.artifact.termination,
    })
    expect(storage.has(first.storagePath)).toBe(true)
    expect(mockDownload).toHaveBeenCalledTimes(1)
  })

  it.each([
    {
      label: 'RAW string value',
      make: () => reviewedBitgetArtifactInput([reviewedBitgetRaw({ note: 'unsafe\0value' })]),
      expectedAuditIdentity: 'portfolio-1',
    },
    {
      label: 'RAW object key',
      make: () => reviewedBitgetArtifactInput([reviewedBitgetRaw({ ['unsafe\0key']: 'value' })]),
      expectedAuditIdentity: 'portfolio-1',
    },
    {
      label: 'outer identity',
      make: () =>
        reviewedBitgetArtifactInput(
          [reviewedBitgetRaw()],
          bitgetPositionHistoryTerminalVerifier,
          'leader\0identity'
        ),
      expectedAuditIdentity: 'invalid_jsonb_text',
    },
    {
      label: 'empty verified identity',
      make: () =>
        reviewedBitgetArtifactInput([], bitgetPositionHistoryTerminalVerifier, 'leader\0identity'),
      expectedAuditIdentity: 'invalid_jsonb_text',
    },
  ])(
    'keeps $label as exact gzip RAW with JSONB-safe replayable audit metadata',
    async ({ make, expectedAuditIdentity }) => {
      const input = await make()
      const database = databaseHarness()

      const first = await writePositionHistoryRawArtifact(input, database.runTransaction)
      const second = await writePositionHistoryRawArtifact(input, database.runTransaction)
      const expectation = prepareHistoryRawArtifactReconciliationExpectation(input)
      const meta = database.pointers[0].meta as Record<string, unknown>

      expect(second).toEqual(first)
      expect(database.pointers).toHaveLength(1)
      expect(meta).toMatchObject({
        surface: 'position_history_audit',
        publication_eligible: false,
        audit_reason: 'reviewed_contract_rejected',
        exchange_trader_id: expectedAuditIdentity,
      })
      expect(strictCanonicalJson(meta)).not.toContain('\\u0000')
      expect(expectation.metaCandidatesCanonicalJson).toContain(strictCanonicalJson(meta))
      expect(expectation.metaCandidatesCanonicalJson).not.toContain(
        expect.stringContaining('\\u0000')
      )
      expect(expectation.metaCandidatesCanonicalJson).toHaveLength(
        expectedAuditIdentity === 'invalid_jsonb_text' ? 1 : 3
      )
      expect(gunzipSync(storage.get(first.storagePath)!)).toEqual(
        Buffer.from(strictCanonicalJson(input.artifact), 'utf8')
      )
      expect(mockDownload).toHaveBeenCalledTimes(1)
    }
  )

  it('persists a schema-valid nonreviewed source without granting publication metadata', async () => {
    const input = await artifactInput({ sourceSlug: 'candidate_exchange' })
    const database = databaseHarness()

    const receipt = await writePositionHistoryRawArtifact(input, database.runTransaction)

    expect(storage.has(receipt.storagePath)).toBe(true)
    expect(database.pointers[0].meta).toMatchObject({
      surface: 'position_history_audit',
      publication_eligible: false,
      history_evidence_contract: POSITION_HISTORY_AUDIT_EVIDENCE_CONTRACT,
      audit_reason: 'source_not_reviewed',
      source_slug: 'candidate_exchange',
    })
  })

  it('replays exact previous publication metadata without upgrading it', async () => {
    const input = await reviewedBitgetArtifactInput()
    const database = databaseHarness()
    const first = await writePositionHistoryRawArtifact(input, database.runTransaction)
    const inserted = database.pointers[0].meta as Record<string, unknown>
    const previousMeta: Record<string, unknown> = {
      surface: 'position_history',
      data_contract: input.artifact.contract,
      history_evidence_contract: POSITION_HISTORY_PUBLICATION_EVIDENCE_CONTRACT,
      source_run_id: input.sourceRunId,
      source_slug: input.artifact.source.slug,
      exchange_trader_id: input.artifact.trader.exchange_trader_id,
      history_kind: input.artifact.history_kind,
      attempt_started_at: input.artifact.attempt_started_at,
      starting_cursor: input.artifact.starting_cursor,
      capture_config: input.artifact.capture_config,
      observed_at: fetchedAt,
      page_count: input.artifact.pages.length,
      terminal_evidence_state: input.artifact.termination.evidence_state,
      scan_terminal_state: input.artifact.termination.scan_terminal_state,
      verifier_contract: input.artifact.termination.verifier_contract,
      termination: input.artifact.termination,
      raw_integrity: inserted.raw_integrity,
    }
    database.pointers[0].meta = previousMeta

    await expect(writePositionHistoryRawArtifact(input, database.runTransaction)).resolves.toEqual(
      first
    )
    expect(database.pointers[0].meta).toBe(previousMeta)
    expect(database.pointers[0].meta).not.toHaveProperty('page_manifest')
    expect(
      prepareHistoryRawArtifactReconciliationExpectation(input).metaCandidatesCanonicalJson
    ).toContain(strictCanonicalJson(previousMeta))
  })

  it('replays only the exact legacy audit metadata without upgrading it', async () => {
    const input = await artifactInput()
    const database = databaseHarness()
    const first = await writePositionHistoryRawArtifact(input, database.runTransaction)
    const inserted = database.pointers[0].meta as Record<string, unknown>
    const meta: Record<string, unknown> = {
      surface: 'position_history',
      data_contract: input.artifact.contract,
      source_run_id: input.sourceRunId,
      source_slug: input.artifact.source.slug,
      exchange_trader_id: input.artifact.trader.exchange_trader_id,
      history_kind: input.artifact.history_kind,
      page_count: input.artifact.pages.length,
      terminal_evidence_state: input.artifact.termination.evidence_state,
      scan_terminal_state: input.artifact.termination.scan_terminal_state,
      verifier_contract: input.artifact.termination.verifier_contract,
      raw_integrity: inserted.raw_integrity,
    }
    database.pointers[0].meta = meta

    await expect(writePositionHistoryRawArtifact(input, database.runTransaction)).resolves.toEqual(
      first
    )
    expect(database.pointers[0].meta).not.toHaveProperty('history_evidence_contract')
    expect(
      prepareHistoryRawArtifactReconciliationExpectation(input).metaCandidatesCanonicalJson
    ).toContain(strictCanonicalJson(meta))

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
      surface: 'position_history_audit',
      publication_eligible: false,
      history_evidence_contract: POSITION_HISTORY_AUDIT_EVIDENCE_CONTRACT,
      audit_reason: 'terminal_evidence_not_verified',
      observed_at: fetchedAt,
      termination: {
        evidence_state: 'upstream_error',
        scan_terminal_state: 'partial',
        blocker_reasons: ['upstream_error'],
      },
    })
  })
})
