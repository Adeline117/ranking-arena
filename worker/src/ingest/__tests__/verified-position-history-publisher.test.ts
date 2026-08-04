import { gzipSync } from 'node:zlib'
import type { SourceAdapter } from '@/lib/ingest/core/adapter'
import type { SourceRow } from '@/lib/ingest/core/types'
import type { IngestQueryExecutor } from '@/lib/ingest/db'
import type { FetchSession } from '@/lib/ingest/fetch/types'
import type { WriteHistoryRawArtifactInput } from '@/lib/ingest/raw'
import { strictCanonicalJson, strictCanonicalSha256 } from '@/lib/ingest/strict-canonical-json'
import type {
  PreparedVerifiedPositionHistoryPublication,
  VerifiedPositionHistoryPublicationReceipt,
} from '@/lib/ingest/verified-position-history'

const mockPoolQuery = jest.fn()
const mockIngestClientConnect = jest.fn()
const mockCaptureHistoryAcquisition = jest.fn()
const mockWriteHistoryRawArtifact = jest.fn()
const mockBuildReviewedEvidence = jest.fn()
const mockPreparePublication = jest.fn()
const mockPrepareRpcCall = jest.fn()
const mockValidateReceipt = jest.fn()

jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: jest.fn(() => ({ query: (...args: unknown[]) => mockPoolQuery(...args) })),
  ingestClientConnect: (...args: unknown[]) => mockIngestClientConnect(...args),
}))

jest.mock('@/lib/ingest/history-acquisition', () => {
  const actual = jest.requireActual('@/lib/ingest/history-acquisition')
  return {
    ...actual,
    captureHistoryAcquisition: (...args: unknown[]) => mockCaptureHistoryAcquisition(...args),
  }
})

jest.mock('@/lib/ingest/raw', () => {
  const actual = jest.requireActual('@/lib/ingest/raw')
  return {
    ...actual,
    writeHistoryRawArtifact: (...args: unknown[]) => mockWriteHistoryRawArtifact(...args),
  }
})

jest.mock('@/lib/ingest/reviewed-position-history', () => {
  const actual = jest.requireActual('@/lib/ingest/reviewed-position-history')
  return {
    ...actual,
    buildReviewedPositionHistoryEvidence: (...args: unknown[]) =>
      mockBuildReviewedEvidence(...args),
  }
})

jest.mock('@/lib/ingest/verified-position-history', () => ({
  prepareVerifiedPositionHistoryPublication: (...args: unknown[]) =>
    mockPreparePublication(...args),
  prepareVerifiedPositionHistoryRpcCall: (...args: unknown[]) => mockPrepareRpcCall(...args),
  validateVerifiedPositionHistoryPublicationReceipt: (...args: unknown[]) =>
    mockValidateReceipt(...args),
}))

import {
  canPublishVerifiedPositionHistory,
  captureAndPublishVerifiedPositionHistory,
  captureTierBHistoryRawOnly,
  persistHistoryRawArtifactFirst,
  publishPreparedVerifiedPositionHistory,
  readVerifiedPositionHistoryHead,
  type VerifiedPositionHistoryPublisherRuntime,
} from '../verified-position-history-publisher'
import { runHistoryTransaction } from '../history-transaction'

const sourceRunId = 'a'.repeat(64)
const bindingSetSha256 = 'b'.repeat(64)
const publicationSha256 = 'c'.repeat(64)
const rpcPayload = '{"exact":"canonical-payload"}'
const rpcValues = Object.freeze([501, sourceRunId, 40, rpcPayload] as const)
const rpcCall = Object.freeze({ text: 'SELECT verified_publish($1,$2,$3,$4)', values: rpcValues })

function preparedPublication(
  rowCount = 2,
  previousPublicationId: number | null = 40,
  partialRowCount = 0
): PreparedVerifiedPositionHistoryPublication {
  const publication = {} as PreparedVerifiedPositionHistoryPublication
  return Object.assign(publication, {
    previousPublicationId,
    publicationSha256,
    rawObjectId: 501,
    bindingSetSha256,
    rowBindings: [
      ...Array.from({ length: partialRowCount }, () =>
        Object.freeze({ classification: 'source_partial_omitted' as const })
      ),
      ...Array.from({ length: rowCount }, () =>
        Object.freeze({ classification: 'canonical_materialized' as const })
      ),
    ],
    rows: Array.from({ length: rowCount }, () => Object.freeze({})),
    sourceRunId,
  })
}

function receipt(
  overrides: Partial<VerifiedPositionHistoryPublicationReceipt> = {}
): VerifiedPositionHistoryPublicationReceipt {
  return {
    cursorAfter: '2026-08-03T09:00:00.000Z',
    factsAdded: 2,
    factsReused: 0,
    observedAt: '2026-08-03T10:00:00.000Z',
    publicationId: 41,
    publicationSha256,
    rawObjectId: 501,
    replayed: false,
    sourceRunId,
    stateId: 41,
    ...overrides,
  }
}

function reconciliationRow(
  publication: PreparedVerifiedPositionHistoryPublication,
  overrides: Record<string, unknown> = {}
) {
  return {
    publication_id: 41,
    previous_publication_id: publication.previousPublicationId,
    parsed_row_count: publication.rows.length,
    binding_count: publication.rowBindings.length,
    partial_row_count: publication.rowBindings.filter(
      (binding) => binding.classification === 'source_partial_omitted'
    ).length,
    binding_set_sha256: publication.bindingSetSha256,
    publication_sha256: publication.publicationSha256,
    publication_payload: rpcPayload,
    raw_object_id: publication.rawObjectId,
    receipt: receipt({
      factsAdded: 0,
      factsReused: publication.rows.length,
      replayed: true,
    }),
    ...overrides,
  }
}

interface ScriptedClientOptions {
  commitError?: Error
  operationError?: Error
  operationReceipt?: VerifiedPositionHistoryPublicationReceipt
  releaseError?: Error
}

function scriptedClient(options: ScriptedClientOptions = {}) {
  const events: string[] = []
  const query = jest.fn(async (sql: string, values?: readonly unknown[]) => {
    if (sql === 'BEGIN') {
      events.push('begin')
      return { rows: [], rowCount: null }
    }
    if (sql === 'COMMIT') {
      events.push('commit')
      if (options.commitError) throw options.commitError
      return { rows: [], rowCount: null }
    }
    if (sql === 'ROLLBACK') {
      events.push('rollback')
      return { rows: [], rowCount: null }
    }
    events.push('operation')
    if (values !== rpcValues) throw new Error('publication call values were not the frozen tuple')
    if (options.operationError) throw options.operationError
    return { rows: [{ receipt: options.operationReceipt ?? receipt() }], rowCount: 1 }
  })
  const release = jest.fn(() => {
    events.push('release')
    if (options.releaseError) throw options.releaseError
  })
  return { events, query, release }
}

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

function rawReconciliationFixture() {
  const artifact = {
    contract: 'arena.ingest.history-acquisition-artifact@1',
    serialization_contract: 'arena.strict-canonical-json@1',
    source: { id: 7, slug: 'bitget_futures' },
    trader: { id: 41, exchange_trader_id: 'leader-1' },
    history_kind: 'orders',
    attempt_started_at: '2026-08-03T10:00:00.000Z',
    starting_cursor: null,
    capture_config: { caller_page_cap: null },
    pages: [],
    termination: {
      evidence_state: 'missing',
      claim_observations: [],
      verifier_contract: null,
      scan_terminal_state: 'unknown',
      terminal_cursor_value: null,
      overlap_event_at: null,
      blocker_reasons: ['terminal_claim_missing'],
    },
  } as WriteHistoryRawArtifactInput['artifact']
  const rawSourceRunId = strictCanonicalSha256(artifact)
  const input = Object.freeze({ artifact, sourceRunId: rawSourceRunId })
  const jsonBytes = Buffer.from(strictCanonicalJson(artifact), 'utf8')
  const compressedBytes = gzipSync(jsonBytes).byteLength
  const storagePath =
    `bitget_futures/history_trust/orders/${rawSourceRunId}/` +
    `event_history_${rawSourceRunId}.json.gz`
  const row = {
    id: 501,
    source_id: 7,
    job_type: 'history:orders',
    trader_id: 41,
    timeframe: null,
    fetched_at: '2026-08-03T10:00:00.000Z',
    storage_path: storagePath,
    bytes: compressedBytes,
    content_hash: rawSourceRunId,
    quarantined: false,
    meta: {
      surface: 'orders',
      data_contract: artifact.contract,
      history_evidence_contract: 'arena.event-history-publication-evidence@1',
      source_run_id: rawSourceRunId,
      source_slug: 'bitget_futures',
      exchange_trader_id: 'leader-1',
      history_kind: 'orders',
      attempt_started_at: artifact.attempt_started_at,
      starting_cursor: null,
      capture_config: artifact.capture_config,
      observed_at: artifact.attempt_started_at,
      page_count: 0,
      terminal_evidence_state: 'missing',
      scan_terminal_state: 'unknown',
      verifier_contract: null,
      termination: artifact.termination,
      raw_integrity: {
        version: 1,
        content_type: 'application/json',
        encoding: 'utf-8',
        compression: 'gzip',
        hash_algorithm: 'sha256',
        hash_scope: 'json_utf8',
        serialization_contract: 'arena.strict-canonical-json@1',
        compressed_bytes: compressedBytes,
        uncompressed_bytes: jsonBytes.byteLength,
      },
    },
  }
  return { input, rawSourceRunId, row, storagePath }
}

describe('verified Tier-B position-history publisher', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    for (const mock of [
      mockPoolQuery,
      mockIngestClientConnect,
      mockCaptureHistoryAcquisition,
      mockWriteHistoryRawArtifact,
      mockBuildReviewedEvidence,
      mockPreparePublication,
      mockPrepareRpcCall,
      mockValidateReceipt,
    ]) {
      mock.mockReset()
    }
    mockPrepareRpcCall.mockReturnValue(rpcCall)
    mockValidateReceipt.mockImplementation(
      (_publication: unknown, value: VerifiedPositionHistoryPublicationReceipt) =>
        Object.freeze({ ...value })
    )
  })

  it.each([
    ['binance_futures', 'binance'],
    ['bitget_futures', 'bitget'],
    ['okx_futures', 'okx'],
  ])('enables only the reviewed %s/%s contract', (slug, adapterSlug) => {
    expect(
      canPublishVerifiedPositionHistory({ slug, adapter_slug: adapterSlug } as SourceRow)
    ).toBe(true)
    expect(
      canPublishVerifiedPositionHistory({ slug, adapter_slug: `${adapterSlug}_drift` } as SourceRow)
    ).toBe(false)
  })

  it('normalizes the verified head cursor and never consults a legacy cursor', async () => {
    const query = jest.fn(async () => ({
      rows: [{ publication_id: 40, cursor_after: new Date('2026-08-03T09:00:00.000Z') }],
    }))

    await expect(
      readVerifiedPositionHistoryHead({ query } as IngestQueryExecutor, 7, 41)
    ).resolves.toEqual({ publicationId: 40, cursor: '2026-08-03T09:00:00.000Z' })
    expect(String(query.mock.calls[0][0])).toContain('position_history_publications')
    expect(String(query.mock.calls[0][0])).not.toContain('ingest_cursors')
    expect(query).toHaveBeenCalledWith(expect.any(String), [7, 41])
  })

  it('validates the authority receipt before COMMIT and returns it only after COMMIT', async () => {
    const publication = preparedPublication()
    const client = scriptedClient()
    mockIngestClientConnect.mockResolvedValue(client)
    mockValidateReceipt.mockImplementation((_publication, value) => {
      client.events.push('validate')
      return value
    })

    await expect(publishPreparedVerifiedPositionHistory(publication)).resolves.toEqual(receipt())
    expect(client.events).toEqual(['begin', 'operation', 'validate', 'commit', 'release'])
    expect(mockPrepareRpcCall).toHaveBeenCalledTimes(1)
    expect(client.query.mock.calls.find(([sql]) => sql === rpcCall.text)?.[1]).toBe(rpcValues)
  })

  it('reconciles a known-committed release failure without replaying the RPC', async () => {
    const publication = preparedPublication()
    const client = scriptedClient({ releaseError: new Error('release failed') })
    mockIngestClientConnect.mockResolvedValue(client)
    mockPoolQuery.mockResolvedValue({ rows: [reconciliationRow(publication)] })

    await expect(publishPreparedVerifiedPositionHistory(publication)).resolves.toMatchObject({
      publicationId: 41,
      replayed: true,
      factsAdded: 0,
      factsReused: 2,
    })
    expect(mockIngestClientConnect).toHaveBeenCalledTimes(1)
    expect(client.query.mock.calls.filter(([sql]) => sql === rpcCall.text)).toHaveLength(1)
    expect(mockPoolQuery).toHaveBeenCalledTimes(1)
  })

  it('retries reconciliation up to three times when a committed row is not immediately visible', async () => {
    const publication = preparedPublication()
    const client = scriptedClient({ releaseError: new Error('release failed') })
    mockIngestClientConnect.mockResolvedValue(client)
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [reconciliationRow(publication)] })

    await expect(publishPreparedVerifiedPositionHistory(publication)).resolves.toMatchObject({
      publicationId: 41,
      replayed: true,
    })
    expect(mockPoolQuery).toHaveBeenCalledTimes(3)
    expect(mockIngestClientConnect).toHaveBeenCalledTimes(1)
  })

  it('reconciles first, then replays the exact frozen call once after an ambiguous COMMIT', async () => {
    const publication = preparedPublication()
    const first = scriptedClient({ commitError: new Error('commit response lost') })
    const second = scriptedClient({
      operationReceipt: receipt({ factsAdded: 0, factsReused: 2, replayed: true }),
    })
    mockIngestClientConnect.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    mockPoolQuery.mockResolvedValue({ rows: [] })

    await expect(publishPreparedVerifiedPositionHistory(publication)).resolves.toMatchObject({
      replayed: true,
      factsAdded: 0,
      factsReused: 2,
    })
    expect(mockPrepareRpcCall).toHaveBeenCalledTimes(1)
    expect(mockIngestClientConnect).toHaveBeenCalledTimes(2)
    expect(mockPoolQuery).toHaveBeenCalledTimes(3)
    expect(first.query.mock.calls.find(([sql]) => sql === rpcCall.text)?.[1]).toBe(rpcValues)
    expect(second.query.mock.calls.find(([sql]) => sql === rpcCall.text)?.[1]).toBe(rpcValues)
    expect(second.query.mock.calls.find(([sql]) => sql === rpcCall.text)?.[1]).toEqual(rpcValues)
  })

  it.each(['40P01', '08006', 'ECONNRESET'])(
    'replays one exact call after an explicitly transient not-committed %s',
    async (code) => {
      const publication = preparedPublication()
      const first = scriptedClient({ operationError: pgError(code, 'transient failure') })
      const second = scriptedClient()
      mockIngestClientConnect.mockResolvedValueOnce(first).mockResolvedValueOnce(second)

      await expect(publishPreparedVerifiedPositionHistory(publication)).resolves.toEqual(receipt())
      expect(mockPrepareRpcCall).toHaveBeenCalledTimes(1)
      expect(mockIngestClientConnect).toHaveBeenCalledTimes(2)
      expect(first.query.mock.calls.find(([sql]) => sql === rpcCall.text)?.[1]).toBe(rpcValues)
      expect(second.query.mock.calls.find(([sql]) => sql === rpcCall.text)?.[1]).toBe(rpcValues)
      expect(mockPoolQuery).not.toHaveBeenCalled()
    }
  )

  it('retries one exact call after a transient not-committed connection failure', async () => {
    const publication = preparedPublication()
    const second = scriptedClient()
    mockIngestClientConnect
      .mockRejectedValueOnce(pgError('ECONNRESET', 'connect reset'))
      .mockResolvedValueOnce(second)

    await expect(publishPreparedVerifiedPositionHistory(publication)).resolves.toEqual(receipt())
    expect(mockPrepareRpcCall).toHaveBeenCalledTimes(1)
    expect(mockIngestClientConnect).toHaveBeenCalledTimes(2)
    expect(second.query.mock.calls.find(([sql]) => sql === rpcCall.text)?.[1]).toBe(rpcValues)
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it.each(['40001', '23505'])(
    '%s reconciles an exact hit but never rebases or replays',
    async (code) => {
      const publication = preparedPublication()
      const client = scriptedClient({ operationError: pgError(code, 'database conflict') })
      mockIngestClientConnect.mockResolvedValue(client)
      mockPoolQuery.mockResolvedValue({ rows: [reconciliationRow(publication)] })

      await expect(publishPreparedVerifiedPositionHistory(publication)).resolves.toMatchObject({
        replayed: true,
        publicationId: 41,
      })
      expect(mockPrepareRpcCall).toHaveBeenCalledTimes(1)
      expect(mockIngestClientConnect).toHaveBeenCalledTimes(1)
      expect(mockPoolQuery).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['40001', '23505'])('%s exact-input mismatch is a permanent conflict', async (code) => {
    const publication = preparedPublication()
    const client = scriptedClient({ operationError: pgError(code, 'database conflict') })
    mockIngestClientConnect.mockResolvedValue(client)
    mockPoolQuery.mockResolvedValue({
      rows: [reconciliationRow(publication, { publication_payload: '{"different":true}' })],
    })

    await expect(publishPreparedVerifiedPositionHistory(publication)).rejects.toThrow(
      'immutable source-run reconciliation does not match the prepared call'
    )
    expect(mockIngestClientConnect).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['binding count', { binding_count: 2 }],
    ['partial row count', { partial_row_count: 0 }],
  ] as const)(
    'rejects a reconciled %s that loses mixed-binding audit state',
    async (_label, drift) => {
      const publication = preparedPublication(2, 40, 1)
      const client = scriptedClient({ operationError: pgError('40001', 'database conflict') })
      mockIngestClientConnect.mockResolvedValue(client)
      mockPoolQuery.mockResolvedValue({ rows: [reconciliationRow(publication, drift)] })

      await expect(publishPreparedVerifiedPositionHistory(publication)).rejects.toThrow(
        'immutable source-run reconciliation does not match the prepared call'
      )
    }
  )

  it('never reloads a head or rebases when a stale 40001 has no exact source-run hit', async () => {
    const publication = preparedPublication()
    const client = scriptedClient({ operationError: pgError('40001', 'stale head') })
    mockIngestClientConnect.mockResolvedValue(client)
    mockPoolQuery.mockResolvedValue({ rows: [] })

    await expect(publishPreparedVerifiedPositionHistory(publication)).rejects.toMatchObject({
      code: '40001',
    })
    expect(mockPrepareRpcCall).toHaveBeenCalledTimes(1)
    expect(mockIngestClientConnect).toHaveBeenCalledTimes(1)
    expect(mockPoolQuery).toHaveBeenCalledTimes(3)
    expect(
      mockPoolQuery.mock.calls.every(([sql]) =>
        String(sql).includes('WHERE publication.source_run_id = $1')
      )
    ).toBe(true)
    expect(
      mockPoolQuery.mock.calls.some(([sql]) =>
        String(sql).includes('ORDER BY publication.publication_id DESC')
      )
    ).toBe(false)
  })

  it('does not reconcile or retry a permanent owner RPC rejection', async () => {
    const publication = preparedPublication()
    const client = scriptedClient({ operationError: pgError('22023', 'invalid payload') })
    mockIngestClientConnect.mockResolvedValue(client)

    await expect(publishPreparedVerifiedPositionHistory(publication)).rejects.toMatchObject({
      code: '22023',
    })
    expect(mockPoolQuery).not.toHaveBeenCalled()
    expect(mockIngestClientConnect).toHaveBeenCalledTimes(1)
  })

  it('rolls back a malformed receipt so no success or count escapes validation', async () => {
    const publication = preparedPublication()
    const client = scriptedClient()
    mockIngestClientConnect.mockResolvedValue(client)
    mockValidateReceipt.mockImplementation(() => {
      throw new Error('receipt mismatch')
    })

    await expect(publishPreparedVerifiedPositionHistory(publication)).rejects.toThrow(
      'receipt mismatch'
    )
    expect(client.events).toEqual(['begin', 'operation', 'rollback', 'release'])
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('rolls back a receipt whose state id drifts from its publication id', async () => {
    const publication = preparedPublication()
    const client = scriptedClient({ operationReceipt: receipt({ stateId: 42 }) })
    mockIngestClientConnect.mockResolvedValue(client)

    await expect(publishPreparedVerifiedPositionHistory(publication)).rejects.toThrow(
      'publication receipt state is not bound to its publication'
    )
    expect(client.events).toEqual(['begin', 'operation', 'rollback', 'release'])
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('persists RAW before surfacing an acquisition failure', async () => {
    const artifact = Object.freeze({ source: { id: 7, slug: 'bitget_futures' } })
    const upstreamError = new Error('upstream failed')
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    mockCaptureHistoryAcquisition.mockResolvedValue({
      artifact,
      sourceRunId,
      pages: [],
      error: upstreamError,
    })
    mockWriteHistoryRawArtifact.mockResolvedValue({
      id: 501,
      storagePath:
        `bitget_futures/history_trust/position_history/${sourceRunId}/` +
        `event_history_${sourceRunId}.json.gz`,
      contentHash: sourceRunId,
    })
    const source = { id: 7, slug: 'bitget_futures', adapter_slug: 'bitget' } as SourceRow
    const adapter = {
      getHistory: jest.fn(() => ({ [Symbol.asyncIterator]: jest.fn() })),
      historyTerminalVerifier: jest.fn(() => null),
    } as SourceAdapter
    const runtime: VerifiedPositionHistoryPublisherRuntime = {
      database: { query: (...args) => mockPoolQuery(...args) } as IngestQueryExecutor,
      runTransaction: jest.fn(),
      writeRawArtifact: mockWriteHistoryRawArtifact,
    }

    await expect(
      captureAndPublishVerifiedPositionHistory(
        {
          adapter,
          session: {} as FetchSession,
          source,
          trader: { id: 41, exchange_trader_id: 'leader-1', meta: null },
        },
        runtime
      )
    ).rejects.toBe(upstreamError)
    expect(mockWriteHistoryRawArtifact).toHaveBeenCalledTimes(1)
    expect(mockBuildReviewedEvidence).not.toHaveBeenCalled()
    expect(mockPreparePublication).not.toHaveBeenCalled()
  })

  it('persists RAW before a strict verified capture rejects a missing response page', async () => {
    const artifact = Object.freeze({
      source: { id: 7, slug: 'bitget_futures' },
      pages: Object.freeze([]),
    })
    const rawObject = Object.freeze({
      id: 501,
      storagePath:
        `bitget_futures/history_trust/position_history/${sourceRunId}/` +
        `event_history_${sourceRunId}.json.gz`,
      contentHash: sourceRunId,
    })
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    mockCaptureHistoryAcquisition.mockResolvedValue({
      artifact,
      sourceRunId,
      pages: [],
      error: null,
    })
    mockWriteHistoryRawArtifact.mockResolvedValue(rawObject)
    const source = { id: 7, slug: 'bitget_futures', adapter_slug: 'bitget' } as SourceRow
    const adapter = {
      getHistory: jest.fn(() => ({ [Symbol.asyncIterator]: jest.fn() })),
      historyTerminalVerifier: jest.fn(() => null),
    } as SourceAdapter
    const runtime: VerifiedPositionHistoryPublisherRuntime = {
      database: { query: (...args) => mockPoolQuery(...args) } as IngestQueryExecutor,
      runTransaction: jest.fn(),
      writeRawArtifact: mockWriteHistoryRawArtifact,
    }

    await expect(
      captureAndPublishVerifiedPositionHistory(
        {
          adapter,
          requireResponsePage: true,
          session: {} as FetchSession,
          source,
          trader: { id: 41, exchange_trader_id: 'leader-1', meta: null },
        },
        runtime
      )
    ).rejects.toThrow(
      '[verified-position-history-publisher] bitget_futures position_history returned no upstream response page'
    )
    expect(mockWriteHistoryRawArtifact).toHaveBeenCalledTimes(1)
    expect(mockBuildReviewedEvidence).not.toHaveBeenCalled()
    expect(mockPreparePublication).not.toHaveBeenCalled()
    expect(mockPrepareRpcCall).not.toHaveBeenCalled()
  })

  it('persists RAW before a strict RAW-only capture rejects a missing response page', async () => {
    const artifact = Object.freeze({
      source: { id: 34, slug: 'bingx_futures' },
      pages: Object.freeze([]),
    })
    const rawObject = Object.freeze({
      id: 502,
      storagePath: `bingx_futures/history_trust/orders/${sourceRunId}.json.gz`,
      contentHash: sourceRunId,
    })
    mockCaptureHistoryAcquisition.mockResolvedValue({
      artifact,
      sourceRunId,
      pages: [],
      error: null,
    })
    mockWriteHistoryRawArtifact.mockResolvedValue(rawObject)
    const source = { id: 34, slug: 'bingx_futures', adapter_slug: 'bingx' } as SourceRow
    const adapter = {
      getHistory: jest.fn(() => ({ [Symbol.asyncIterator]: jest.fn() })),
      historyTerminalVerifier: jest.fn(() => null),
    } as SourceAdapter
    const runtime: VerifiedPositionHistoryPublisherRuntime = {
      database: { query: (...args) => mockPoolQuery(...args) } as IngestQueryExecutor,
      runTransaction: jest.fn(),
      writeRawArtifact: mockWriteHistoryRawArtifact,
    }

    await expect(
      captureTierBHistoryRawOnly(
        {
          adapter,
          kind: 'orders',
          requireResponsePage: true,
          session: {} as FetchSession,
          source,
          trader: { id: 41, exchange_trader_id: 'leader-1', meta: null },
        },
        runtime
      )
    ).rejects.toThrow(
      '[verified-position-history-publisher] bingx_futures orders returned no upstream response page'
    )
    expect(mockWriteHistoryRawArtifact).toHaveBeenCalledTimes(1)
    expect(mockBuildReviewedEvidence).not.toHaveBeenCalled()
    expect(mockPreparePublication).not.toHaveBeenCalled()
  })

  it('publishes a verified empty history and binds the head before capture', async () => {
    const publication = preparedPublication(0)
    const canonicalRows = Object.freeze([])
    const artifact = Object.freeze({ source: { id: 7, slug: 'bitget_futures' } })
    const rawObject = Object.freeze({
      id: 501,
      storagePath:
        `bitget_futures/history_trust/position_history/${sourceRunId}/` +
        `event_history_${sourceRunId}.json.gz`,
      contentHash: sourceRunId,
    })
    const emptyReceipt = receipt({ factsAdded: 0, factsReused: 0 })
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ publication_id: 40, cursor_after: '2026-08-03T09:00:00.000Z' }],
    })
    mockCaptureHistoryAcquisition.mockResolvedValue({
      artifact,
      sourceRunId,
      pages: [],
      error: null,
    })
    mockWriteHistoryRawArtifact.mockResolvedValue(rawObject)
    mockBuildReviewedEvidence.mockReturnValue({ artifact, canonicalRows })
    mockPreparePublication.mockReturnValue(publication)
    const getHistory = jest.fn(() => ({ [Symbol.asyncIterator]: jest.fn() }))
    const adapter = {
      getHistory,
      historyTerminalVerifier: jest.fn(() => null),
    } as SourceAdapter
    const operationQuery = jest.fn(async () => ({ rows: [{ receipt: emptyReceipt }] }))
    const runtime: VerifiedPositionHistoryPublisherRuntime = {
      database: { query: (...args) => mockPoolQuery(...args) } as IngestQueryExecutor,
      runTransaction: async (operation) => operation({ query: operationQuery }),
      writeRawArtifact: mockWriteHistoryRawArtifact,
    }
    const source = { id: 7, slug: 'bitget_futures', adapter_slug: 'bitget' } as SourceRow

    await expect(
      captureAndPublishVerifiedPositionHistory(
        {
          adapter,
          session: {} as FetchSession,
          source,
          trader: { id: 41, exchange_trader_id: 'leader-1', meta: null },
        },
        runtime
      )
    ).resolves.toEqual({ rawObject, receipt: emptyReceipt })
    expect(getHistory).toHaveBeenCalledWith(
      expect.anything(),
      source,
      'leader-1',
      'position_history',
      '2026-08-03T09:00:00.000Z',
      null
    )
    expect(mockPoolQuery.mock.invocationCallOrder[0]).toBeLessThan(
      getHistory.mock.invocationCallOrder[0]
    )
    expect(mockWriteHistoryRawArtifact.mock.invocationCallOrder[0]).toBeLessThan(
      mockBuildReviewedEvidence.mock.invocationCallOrder[0]
    )
    expect(mockPreparePublication).toHaveBeenCalledWith(
      expect.objectContaining({
        previousPublicationId: 40,
        rawObject,
        rows: [],
        sourceRunId,
      })
    )
    expect(mockPreparePublication.mock.calls[0][0].rows).toBe(canonicalRows)
    expect(mockPreparePublication).toHaveBeenCalledTimes(1)
    expect(mockPrepareRpcCall).toHaveBeenCalledTimes(1)
  })

  it('reconciles a RAW commit before any typed publication can run', async () => {
    const { input, rawSourceRunId, row, storagePath } = rawReconciliationFixture()
    const client = scriptedClient({ commitError: new Error('RAW commit response lost') })
    // The RAW writer uses the supplied real transaction runner, but its body
    // does not issue the publisher RPC.
    const rawReceipt = { id: 501, storagePath: 'unused', contentHash: rawSourceRunId }
    const rawWriter = jest.fn((_input, transactionRunner) =>
      transactionRunner(async () => rawReceipt)
    )
    mockIngestClientConnect.mockResolvedValue(client)
    mockPoolQuery.mockResolvedValue({ rows: [row] })
    const runtime: VerifiedPositionHistoryPublisherRuntime = {
      database: { query: (...args) => mockPoolQuery(...args) } as IngestQueryExecutor,
      runTransaction: runHistoryTransaction,
      writeRawArtifact: rawWriter,
    }

    await expect(persistHistoryRawArtifactFirst(input, runtime)).resolves.toMatchObject({
      id: 501,
      contentHash: rawSourceRunId,
    })
    expect(rawWriter).toHaveBeenCalledTimes(1)
    expect(mockPoolQuery).toHaveBeenCalledTimes(1)
    const [reconciliationSql, reconciliationValues] = mockPoolQuery.mock.calls[0]
    expect(String(reconciliationSql)).toContain('WHERE storage_path = $1')
    expect(String(reconciliationSql)).not.toContain('source_run_id')
    expect(String(reconciliationSql)).not.toContain('trust_artifact_role')
    expect(reconciliationValues).toEqual([storagePath])
  })

  it('rejects every security-relevant RAW pointer drift during ambiguous reconciliation', async () => {
    const { input, rawSourceRunId, row } = rawReconciliationFixture()
    const attacks = [
      ['source', { source_id: 8 }],
      ['job role', { job_type: 'history:position_history' }],
      ['trader', { trader_id: 42 }],
      ['timeframe', { timeframe: '1h' }],
      ['fetched time', { fetched_at: '2026-08-03T10:00:00.001Z' }],
      ['storage path', { storage_path: `${row.storage_path}.tampered` }],
      ['content hash', { content_hash: 'f'.repeat(64) }],
      ['quarantine state', { quarantined: true }],
      ['metadata source run', { meta: { ...row.meta, source_run_id: 'f'.repeat(64) } }],
      [
        'metadata durable byte count',
        {
          meta: {
            ...row.meta,
            raw_integrity: {
              ...row.meta.raw_integrity,
              compressed_bytes: row.bytes + 1,
            },
          },
        },
      ],
    ] as const

    for (const [label, drift] of attacks) {
      mockIngestClientConnect.mockReset()
      mockPoolQuery.mockReset()
      const client = scriptedClient({ commitError: new Error(`RAW ${label} commit response lost`) })
      const rawReceipt = { id: 501, storagePath: 'unused', contentHash: rawSourceRunId }
      const rawWriter = jest.fn((_input, transactionRunner) =>
        transactionRunner(async () => rawReceipt)
      )
      mockIngestClientConnect.mockResolvedValue(client)
      mockPoolQuery.mockResolvedValue({ rows: [{ ...row, ...drift }] })
      const runtime: VerifiedPositionHistoryPublisherRuntime = {
        database: { query: (...args) => mockPoolQuery(...args) } as IngestQueryExecutor,
        runTransaction: runHistoryTransaction,
        writeRawArtifact: rawWriter,
      }

      await expect(persistHistoryRawArtifactFirst(input, runtime)).rejects.toThrow(
        'RAW source-run reconciliation does not match the captured artifact'
      )
      expect(rawWriter).toHaveBeenCalledTimes(1)
      expect(mockPoolQuery).toHaveBeenCalledTimes(1)
    }
  })

  it('does not turn a not-committed RAW 23505 into success from a superficial pointer hit', async () => {
    const conflict = pgError('23505', 'source-run collision')
    const input = {
      artifact: {} as WriteHistoryRawArtifactInput['artifact'],
      sourceRunId,
    }
    const rawWriter = jest.fn((_input, transactionRunner) =>
      transactionRunner(async () => {
        throw conflict
      })
    )
    const client = scriptedClient()
    mockIngestClientConnect.mockResolvedValue(client)
    mockPoolQuery.mockResolvedValue({ rows: [{ id: 501 }] })
    const runtime: VerifiedPositionHistoryPublisherRuntime = {
      database: { query: (...args) => mockPoolQuery(...args) } as IngestQueryExecutor,
      runTransaction: runHistoryTransaction,
      writeRawArtifact: rawWriter,
    }

    await expect(persistHistoryRawArtifactFirst(input, runtime)).rejects.toBe(conflict)
    expect(rawWriter).toHaveBeenCalledTimes(1)
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })
})
