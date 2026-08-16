import '../adapters/register'

import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'

const storage = new Map<string, Buffer>()
const mockUpload = jest.fn(async (path: string, payload: Buffer) => {
  if (storage.has(path)) {
    return { error: { message: 'already exists', statusCode: 409 } }
  }
  storage.set(path, Buffer.from(payload))
  return { error: null }
})

function streamFromChunks(chunks: readonly Uint8Array[]) {
  let index = 0
  const read = jest.fn(async () =>
    index < chunks.length
      ? { done: false as const, value: chunks[index++] }
      : { done: true as const, value: undefined }
  )
  const cancel = jest.fn(async () => undefined)
  const releaseLock = jest.fn()
  return {
    stream: { getReader: () => ({ read, cancel, releaseLock }) },
    read,
    cancel,
    releaseLock,
  }
}

const mockBlobDownload = jest.fn(async (path: string) => {
  const payload = storage.get(path)
  return payload
    ? {
        data: {
          size: payload.byteLength,
          arrayBuffer: async () =>
            payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
        },
        error: null,
      }
    : { data: null, error: { message: 'not found', statusCode: 404 } }
})
const mockAsStream = jest.fn(async (path: string) => {
  const payload = storage.get(path)
  return payload
    ? { data: streamFromChunks([Buffer.from(payload)]).stream, error: null }
    : { data: null, error: { message: 'not found', statusCode: 404 } }
})
const mockDownload = jest.fn((path: string) => ({
  asStream: () => mockAsStream(path),
  then: (
    resolve: (value: Awaited<ReturnType<typeof mockBlobDownload>>) => unknown,
    reject?: (reason: unknown) => unknown
  ) => mockBlobDownload(path).then(resolve, reject),
}))

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    storage: {
      from: jest.fn(() => ({ upload: mockUpload, download: mockDownload })),
    },
  })),
}))

jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: jest.fn(),
  ingestClientConnect: jest.fn(),
}))

import { getAdapter } from '../core/adapter'
import type { IngestQueryExecutor } from '../db'
import type { ParsedHistoryRow, RawPage, SourceRow } from '../core/types'
import {
  buildCopierSnapshotArtifact,
  copierSnapshotSourceRunId,
  type CopierSnapshotArtifact,
} from '../copier-snapshot-artifact'
import {
  buildCopierSnapshotArtifactV2,
  type CopierSnapshotArtifactAnchor,
  type CopierSnapshotArtifactV2Result,
} from '../copier-snapshot-artifact-v2'
import {
  buildCopierCandidateLedger,
  verifyCopierParserConservation,
  type CopierCandidateLedger,
  type CopierParserConservationProof,
} from '../copier-candidate-conservation'
import {
  COPIER_SNAPSHOT_TRUST_RAW_ARTIFACT_ROLE,
  type IngestTransactionRunner,
  type LockedVerifiedCopierSnapshotTrustRawArtifactV2,
  type ReadVerifiedCopierSnapshotTrustRawArtifactV2Input,
  withVerifiedCopierSnapshotTrustRawArtifactV2,
  writeCopierSnapshotTrustRawArtifactV2,
} from '../raw'
import { strictCanonicalJson } from '../strict-canonical-json'

type Candidate = Record<string, unknown>

interface Evidence {
  src: SourceRow
  snapshot: CopierSnapshotArtifact
  expectedSnapshot: CopierSnapshotArtifactAnchor
  candidateLedger: CopierCandidateLedger
  parserProof: CopierParserConservationProof
  rows: ParsedHistoryRow[]
}

interface Pointer {
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

const candidate = {
  uid: 'private-candidate-a',
  nickName: 'private-name-a',
  followingProfitLoss: '1.25',
  copyAmount: '10',
  followingDays: 2,
}

function source(): SourceRow {
  return {
    id: 34,
    slug: 'bingx_futures',
    exchange_id: 3,
    product_type: 'futures',
    trader_kind_scope: 'human',
    adapter_slug: 'bingx',
    leaderboard_url: 'https://example.test/leaderboard',
    timeframes_native: [7, 30, 90],
    timeframes_derived: [],
    tf_label_map: {},
    expected_count: null,
    deep_profile_topn: 20,
    positions_topn: 20,
    profile_cache_ttl: '15 minutes',
    copier_table_depth: 'full',
    currency: 'USDT',
    page_size: 20,
    pagination_kind: 'numeric',
    cadence_tier_a: '15 minutes',
    cadence_tier_b: '1 hour',
    cadence_tier_d: '5 minutes',
    fetch_region: 'local',
    rate_budget_ms: 250,
    phase: 1,
    serving_mode: 'serving',
    status: 'active',
    meta: {},
  }
}

function page(candidates: Candidate[]): RawPage {
  return {
    pageIndex: 1,
    payload: { code: 0, data: { followerDetailsVoList: candidates } },
    url: 'https://example.test/copiers?page=1',
    fetchedAt: '2026-08-08T12:00:01.000Z',
  }
}

function snapshotAnchor(snapshot: CopierSnapshotArtifact): CopierSnapshotArtifactAnchor {
  return {
    sourceRunId: copierSnapshotSourceRunId(snapshot),
    sourceId: snapshot.source.id,
    sourceSlug: snapshot.source.slug,
    traderId: snapshot.trader.id,
    exchangeTraderId: snapshot.trader.exchange_trader_id,
  }
}

function evidence(lane: 'tier_b' | 'tier_c' = 'tier_c'): Evidence {
  const src = source()
  const snapshot = buildCopierSnapshotArtifact({
    src,
    traderId: 101,
    exchangeTraderId: 'private-exchange-trader-101',
    lane,
    requestTimeframe: lane === 'tier_b' ? null : 0,
    pages: [page([candidate])],
    callerLimited: false,
  })
  const candidateLedger = buildCopierCandidateLedger({
    src,
    exchangeTraderId: snapshot.trader.exchange_trader_id,
    pages: snapshot.pages,
  })
  const rows = snapshot.pages.flatMap((capturedPage) =>
    getAdapter(src.adapter_slug).parseHistory(capturedPage.payload, 'copiers', {
      sourceSlug: snapshot.source.slug,
      currency: snapshot.source.currency,
      tfLabelMap: {},
      scrapedAt: snapshot.observed_at,
      meta: {},
    })
  )
  const parserProof = verifyCopierParserConservation({ ledger: candidateLedger, rows })
  return {
    src,
    snapshot,
    expectedSnapshot: snapshotAnchor(snapshot),
    candidateLedger,
    parserProof,
    rows,
  }
}

function artifactV2(lane: 'tier_b' | 'tier_c' = 'tier_c'): CopierSnapshotArtifactV2Result {
  return buildCopierSnapshotArtifactV2(evidence(lane))
}

function clonePointer(pointer: Pointer): Pointer {
  return { ...pointer, meta: JSON.parse(JSON.stringify(pointer.meta)) }
}

function databaseHarness(options: { exactInstant?: boolean; notFuture?: boolean } = {}) {
  const pointers: Pointer[] = []
  const gcPendingPaths = new Set<string>()
  const events: string[] = []
  const query = jest.fn(async (sqlInput: unknown, values: readonly unknown[] = []) => {
    const sql = String(sqlInput)
    if (sql.includes('pg_advisory_xact_lock')) {
      events.push('advisory')
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith('SELECT fetched_at =')) {
      events.push('time')
      const pointer = pointers.find((row) => row.id === values[0])
      return {
        rows: pointer
          ? [
              {
                exact_instant:
                  options.exactInstant ??
                  Date.parse(pointer.fetched_at) === Date.parse(String(values[1])),
                not_future: options.notFuture ?? true,
              },
            ]
          : [],
        rowCount: pointer ? 1 : 0,
      }
    }
    if (sql.includes('SELECT id, source_id, job_type')) {
      if (sql.includes('AS gc_pending')) {
        events.push('locked-select')
        const selected = pointers
          .filter(
            (pointer) =>
              pointer.id === values[0] ||
              (pointer.source_run_id === values[1] && pointer.trust_artifact_role === values[2])
          )
          .map((pointer) => ({
            ...clonePointer(pointer),
            gc_pending: gcPendingPaths.has(pointer.storage_path),
          }))
        return { rows: selected, rowCount: selected.length }
      }
      events.push('writer-select')
      const selected = pointers
        .filter(
          (pointer) =>
            pointer.storage_path === values[0] ||
            (pointer.source_run_id === values[1] && pointer.trust_artifact_role === values[2])
        )
        .map((pointer) => ({
          ...clonePointer(pointer),
          fetched_at_exact: Date.parse(pointer.fetched_at) === Date.parse(String(values[3])),
          observed_at_not_future: true,
        }))
      return { rows: selected, rowCount: selected.length }
    }
    if (sql.includes('INSERT INTO arena.raw_objects')) {
      events.push('insert')
      if (!pointers.some((pointer) => pointer.storage_path === String(values[4]))) {
        pointers.push({
          id: 8001,
          source_id: Number(values[0]),
          job_type: String(values[1]),
          trader_id: Number(values[2]),
          timeframe: null,
          fetched_at: String(values[3]),
          storage_path: String(values[4]),
          bytes: Number(values[5]),
          content_hash: String(values[6]),
          quarantined: false,
          meta: JSON.parse(String(values[7])),
          source_run_id: String(values[8]),
          trust_artifact_role: String(values[9]),
        })
      }
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected query: ${sql}`)
  })
  const transaction = { query } as IngestQueryExecutor
  const runTransaction = jest.fn(
    async <T>(operation: (executor: IngestQueryExecutor) => Promise<T>): Promise<T> => {
      const pointerSnapshot = pointers.map(clonePointer)
      const gcSnapshot = new Set(gcPendingPaths)
      try {
        return await operation(transaction)
      } catch (error) {
        pointers.splice(0, pointers.length, ...pointerSnapshot.map(clonePointer))
        gcPendingPaths.clear()
        for (const path of gcSnapshot) gcPendingPaths.add(path)
        throw error
      }
    }
  ) as IngestTransactionRunner
  return { events, gcPendingPaths, pointers, query, runTransaction, transaction }
}

function readInput(
  built: CopierSnapshotArtifactV2Result,
  rawObjectId = 8001
): ReadVerifiedCopierSnapshotTrustRawArtifactV2Input {
  const artifact = built.artifact
  return {
    rawObjectId,
    expectedSourceId: artifact.snapshot.source.id,
    expectedSourceSlug: artifact.snapshot.source.slug,
    expectedTraderId: artifact.snapshot.trader.id,
    expectedExchangeTraderId: artifact.snapshot.trader.exchange_trader_id,
    expectedLane: artifact.snapshot.lane,
    expectedSourceRunId: built.sourceRunId,
    expectedSnapshotSourceRunId: artifact.snapshot_source_run_id,
    expectedCandidateLedgerSha256: artifact.candidate_ledger_sha256,
    expectedParserConservationSha256: artifact.parser_conservation_sha256,
    expectedProjectionLedgerSha256: artifact.projection_ledger_sha256,
  }
}

async function storedFixture(lane: 'tier_b' | 'tier_c' = 'tier_c') {
  const built = artifactV2(lane)
  const database = databaseHarness()
  const receipt = await writeCopierSnapshotTrustRawArtifactV2(built, database.runTransaction)
  database.events.splice(0)
  database.query.mockClear()
  mockDownload.mockClear()
  mockUpload.mockClear()
  return { built, database, input: readInput(built, receipt.id), receipt }
}

describe('locked copier snapshot trust RAW artifact v2 reader', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
  })

  beforeEach(() => {
    storage.clear()
    jest.clearAllMocks()
  })

  it.each(['tier_c', 'tier_b'] as const)(
    'locks, replays, and consumes %s evidence under only the narrow binding scope',
    async (lane) => {
      const { built, database, input, receipt } = await storedFixture(lane)
      let captured: LockedVerifiedCopierSnapshotTrustRawArtifactV2 | null = null
      const consume = jest.fn(
        async (
          transaction: IngestQueryExecutor,
          evidenceValue: LockedVerifiedCopierSnapshotTrustRawArtifactV2
        ) => {
          expect(transaction).toBe(database.transaction)
          captured = evidenceValue
          return { projection: 'ok' }
        }
      )

      await expect(
        withVerifiedCopierSnapshotTrustRawArtifactV2(input, database.runTransaction, consume)
      ).resolves.toEqual({ projection: 'ok' })

      expect(captured).toEqual({
        contract: built.artifact.contract,
        trustScope: 'raw_candidate_parser_projection_binding',
        pointerSnapshot: {
          rawObjectId: receipt.id,
          sourceRunId: built.sourceRunId,
          storagePath: receipt.storagePath,
          observedAt: built.artifact.snapshot.observed_at,
        },
        snapshotSourceRunId: built.artifact.snapshot_source_run_id,
        candidateLedgerSha256: built.artifact.candidate_ledger_sha256,
        parserConservationSha256: built.artifact.parser_conservation_sha256,
        projectionLedgerSha256: built.artifact.projection_ledger_sha256,
        artifact: built.artifact,
      })
      expect(Object.isFrozen(captured)).toBe(true)
      expect(Object.isFrozen(captured!.pointerSnapshot)).toBe(true)
      expect(Object.isFrozen(captured!.artifact)).toBe(true)
      for (const forbidden of [
        'complete',
        'rankEligible',
        'publicationAuthorized',
        'currentSourceAuthorized',
      ]) {
        expect(captured).not.toHaveProperty(forbidden)
      }
      expect(mockDownload).toHaveBeenCalledTimes(1)
      expect(database.events).toEqual(['advisory', 'locked-select', 'time', 'locked-select'])
      const lockedReads = database.query.mock.calls.filter(([sql]) =>
        String(sql).includes('AS gc_pending')
      )
      expect(lockedReads).toHaveLength(2)
      expect(lockedReads.every(([sql]) => String(sql).includes('FOR SHARE'))).toBe(true)
      expect(lockedReads[0][1]).toEqual([
        receipt.id,
        built.sourceRunId,
        COPIER_SNAPSHOT_TRUST_RAW_ARTIFACT_ROLE,
      ])
    }
  )

  it('fails closed on swapped outer and child anchors before Storage download', async () => {
    const { built, database, input } = await storedFixture()
    const hashes = [
      built.artifact.snapshot_source_run_id,
      built.artifact.candidate_ledger_sha256,
      built.artifact.parser_conservation_sha256,
      built.artifact.projection_ledger_sha256,
      built.sourceRunId,
    ]
    const invalid: ReadVerifiedCopierSnapshotTrustRawArtifactV2Input[] = [
      { ...input, expectedSourceRunId: hashes[0] },
      { ...input, expectedSnapshotSourceRunId: hashes[1] },
      { ...input, expectedCandidateLedgerSha256: hashes[2] },
      { ...input, expectedParserConservationSha256: hashes[3] },
      { ...input, expectedProjectionLedgerSha256: hashes[4] },
      { ...input, rawObjectId: input.rawObjectId + 1 },
      { ...input, expectedSourceId: input.expectedSourceId + 1 },
      { ...input, expectedSourceSlug: 'other_source' },
      { ...input, expectedTraderId: input.expectedTraderId + 1 },
      { ...input, expectedLane: 'tier_b' },
    ]

    for (const badInput of invalid) {
      await expect(
        withVerifiedCopierSnapshotTrustRawArtifactV2(
          badInput,
          database.runTransaction,
          async () => null
        )
      ).rejects.toThrow(/locked pointer|expected one locked pointer/)
    }
    expect(mockDownload).not.toHaveBeenCalled()

    await expect(
      withVerifiedCopierSnapshotTrustRawArtifactV2(
        { ...input, expectedExchangeTraderId: 'other-private-account' },
        database.runTransaction,
        async () => null
      )
    ).rejects.toThrow('coordinates or child anchors')
    expect(mockDownload).toHaveBeenCalledTimes(1)
  })

  it('rejects role, path, coordinate, quarantine, GC, time, and exact metadata drift', async () => {
    const { database, input } = await storedFixture()
    const original = clonePointer(database.pointers[0])
    const mutations: Array<(pointer: Pointer) => void> = [
      (pointer) => {
        pointer.source_id += 1
      },
      (pointer) => {
        pointer.job_type = 'history:orders'
      },
      (pointer) => {
        pointer.trader_id = Number(pointer.trader_id) + 1
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
        pointer.source_run_id = 'f'.repeat(64)
      },
      (pointer) => {
        pointer.trust_artifact_role = 'copier_snapshot'
      },
      (pointer) => {
        pointer.quarantined = true
      },
      (pointer) => {
        ;(pointer.meta as Record<string, unknown>).extra = true
      },
      (pointer) => {
        const meta = pointer.meta as Record<string, unknown>
        delete meta.projection_ledger_sha256
      },
      (pointer) => {
        const integrity = (pointer.meta as Record<string, unknown>).raw_integrity as Record<
          string,
          unknown
        >
        integrity.uncompressed_bytes = 256 * 1024 * 1024 + 1
      },
    ]

    for (const mutate of mutations) {
      database.pointers.splice(0, 1, clonePointer(original))
      mutate(database.pointers[0])
      await expect(
        withVerifiedCopierSnapshotTrustRawArtifactV2(
          input,
          database.runTransaction,
          async () => null
        )
      ).rejects.toThrow('locked pointer does not match')
    }
    expect(mockDownload).not.toHaveBeenCalled()

    database.pointers.splice(0, 1, clonePointer(original))
    database.gcPendingPaths.add(original.storage_path)
    await expect(
      withVerifiedCopierSnapshotTrustRawArtifactV2(input, database.runTransaction, async () => null)
    ).rejects.toThrow('locked pointer does not match')
    expect(mockDownload).not.toHaveBeenCalled()

    const exactTimeDatabase = databaseHarness({ exactInstant: false })
    exactTimeDatabase.pointers.push(clonePointer(original))
    await expect(
      withVerifiedCopierSnapshotTrustRawArtifactV2(
        input,
        exactTimeDatabase.runTransaction,
        async () => null
      )
    ).rejects.toThrow('observation clock')

    const futureDatabase = databaseHarness({ notFuture: false })
    futureDatabase.pointers.push(clonePointer(original))
    await expect(
      withVerifiedCopierSnapshotTrustRawArtifactV2(
        input,
        futureDatabase.runTransaction,
        async () => null
      )
    ).rejects.toThrow('observation clock')
  })

  it('streams the exact compressed boundary without materializing a Blob', async () => {
    const { database, input, receipt } = await storedFixture()
    const gzip = Buffer.from(storage.get(receipt.storagePath)!)
    const split = Math.max(1, Math.floor(gzip.byteLength / 2))
    const controlled = streamFromChunks([gzip.subarray(0, split), gzip.subarray(split)])
    mockAsStream.mockImplementationOnce(async () => ({ data: controlled.stream, error: null }))

    await expect(
      withVerifiedCopierSnapshotTrustRawArtifactV2(
        input,
        database.runTransaction,
        async () => 'exact'
      )
    ).resolves.toBe('exact')

    expect(controlled.read).toHaveBeenCalledTimes(3)
    expect(controlled.cancel).not.toHaveBeenCalled()
    expect(controlled.releaseLock).toHaveBeenCalledTimes(1)
    expect(mockBlobDownload).not.toHaveBeenCalled()
  })

  it('cancels on limit plus one without consuming a later sentinel chunk', async () => {
    const { database, input, receipt } = await storedFixture()
    const gzip = Buffer.from(storage.get(receipt.storagePath)!)
    let ordinal = 0
    const sentinel = jest.fn()
    const read = jest.fn(async () => {
      ordinal += 1
      if (ordinal === 1) return { done: false as const, value: gzip }
      if (ordinal === 2) return { done: false as const, value: Buffer.from([0]) }
      sentinel()
      return { done: true as const, value: undefined }
    })
    const cancel = jest.fn(async () => undefined)
    const releaseLock = jest.fn()
    mockAsStream.mockImplementationOnce(async () => ({
      data: { getReader: () => ({ read, cancel, releaseLock }) },
      error: null,
    }))

    await expect(
      withVerifiedCopierSnapshotTrustRawArtifactV2(input, database.runTransaction, async () => null)
    ).rejects.toThrow('compressed byte limit')

    expect(read).toHaveBeenCalledTimes(2)
    expect(sentinel).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(releaseLock).toHaveBeenCalledTimes(1)
    expect(mockBlobDownload).not.toHaveBeenCalled()
  })

  it('fails closed on a stream read error, Storage error, and null stream body', async () => {
    const { database, input } = await storedFixture()
    const read = jest.fn(async () => {
      throw new Error('stream reset')
    })
    const cancel = jest.fn(async () => undefined)
    const releaseLock = jest.fn()
    mockAsStream.mockImplementationOnce(async () => ({
      data: { getReader: () => ({ read, cancel, releaseLock }) },
      error: null,
    }))
    await expect(
      withVerifiedCopierSnapshotTrustRawArtifactV2(input, database.runTransaction, async () => null)
    ).rejects.toThrow('RAW stream body failed')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(releaseLock).toHaveBeenCalledTimes(1)

    mockAsStream.mockImplementationOnce(async () => ({
      data: null,
      error: { message: 'stream denied' },
    }))
    await expect(
      withVerifiedCopierSnapshotTrustRawArtifactV2(input, database.runTransaction, async () => null)
    ).rejects.toThrow('stream denied')

    mockAsStream.mockImplementationOnce(async () => ({ data: null, error: null }))
    await expect(
      withVerifiedCopierSnapshotTrustRawArtifactV2(input, database.runTransaction, async () => null)
    ).rejects.toThrow('empty stream body')
    expect(mockBlobDownload).not.toHaveBeenCalled()
  })

  it('bounds Storage before allocation/decompression and rejects byte or semantic tampering', async () => {
    const { built, database, input, receipt } = await storedFixture()
    const originalPointer = clonePointer(database.pointers[0])
    const originalGzip = Buffer.from(storage.get(receipt.storagePath)!)
    const consume = jest.fn(async () => null)

    storage.set(receipt.storagePath, Buffer.concat([originalGzip, Buffer.from([0])]))
    await expect(
      withVerifiedCopierSnapshotTrustRawArtifactV2(input, database.runTransaction, consume)
    ).rejects.toThrow('compressed byte limit')

    storage.set(receipt.storagePath, Buffer.from([0, 0, 0]))
    database.pointers[0].bytes = 3
    const headerMeta = database.pointers[0].meta as Record<string, unknown>
    ;(headerMeta.raw_integrity as Record<string, unknown>).compressed_bytes = 3
    await expect(
      withVerifiedCopierSnapshotTrustRawArtifactV2(input, database.runTransaction, consume)
    ).rejects.toThrow('invalid gzip header')

    database.pointers.splice(0, 1, clonePointer(originalPointer))
    const expectedJson = Buffer.from(strictCanonicalJson(built.artifact), 'utf8')
    const oversizedJson = Buffer.concat([expectedJson, Buffer.from(' ')])
    const oversizedGzip = gzipSync(oversizedJson)
    storage.set(receipt.storagePath, oversizedGzip)
    database.pointers[0].bytes = oversizedGzip.byteLength
    const oversizedMeta = database.pointers[0].meta as Record<string, unknown>
    const oversizedIntegrity = oversizedMeta.raw_integrity as Record<string, unknown>
    oversizedIntegrity.compressed_bytes = oversizedGzip.byteLength
    await expect(
      withVerifiedCopierSnapshotTrustRawArtifactV2(input, database.runTransaction, consume)
    ).rejects.toThrow('gzip payload or trailer is corrupt')

    database.pointers.splice(0, 1, clonePointer(originalPointer))
    const tampered = Buffer.from(strictCanonicalJson({ contract: built.artifact.contract }), 'utf8')
    const tamperedGzip = gzipSync(tampered)
    storage.set(receipt.storagePath, tamperedGzip)
    database.pointers[0].bytes = tamperedGzip.byteLength
    const tamperedMeta = database.pointers[0].meta as Record<string, unknown>
    const tamperedIntegrity = tamperedMeta.raw_integrity as Record<string, unknown>
    tamperedIntegrity.compressed_bytes = tamperedGzip.byteLength
    tamperedIntegrity.uncompressed_bytes = tampered.byteLength
    await expect(
      withVerifiedCopierSnapshotTrustRawArtifactV2(input, database.runTransaction, consume)
    ).rejects.toThrow('SHA-256 checksum mismatch')
    expect(consume).not.toHaveBeenCalled()
  })

  it('rechecks pointer and GC state after the consumer and rolls back mutations', async () => {
    const { database, input } = await storedFixture()
    const original = clonePointer(database.pointers[0])
    const mutations: Array<() => void> = [
      () => {
        ;(database.pointers[0].meta as Record<string, unknown>).consumer_mutation = true
      },
      () => {
        database.pointers[0].quarantined = true
      },
      () => {
        database.pointers.splice(0, 1)
      },
      () => {
        database.pointers.push({
          ...clonePointer(original),
          id: original.id + 1,
          storage_path: `${original.storage_path}.duplicate`,
        })
      },
      () => {
        database.gcPendingPaths.add(original.storage_path)
      },
    ]

    for (const mutate of mutations) {
      await expect(
        withVerifiedCopierSnapshotTrustRawArtifactV2(input, database.runTransaction, async () =>
          mutate()
        )
      ).rejects.toThrow(/locked pointer/)
      expect(database.pointers).toEqual([original])
      expect(database.gcPendingPaths).toEqual(new Set())
    }
  })

  it('captures exact primitive anchors and validates runner/consumer before input inspection', async () => {
    const { built, database, input } = await storedFixture()
    let traps = 0
    const proxy = new Proxy(input, {
      getPrototypeOf() {
        traps += 1
        return Object.prototype
      },
    })
    await expect(
      Reflect.apply(withVerifiedCopierSnapshotTrustRawArtifactV2, undefined, [proxy])
    ).rejects.toThrow('transaction runner')
    await expect(
      Reflect.apply(withVerifiedCopierSnapshotTrustRawArtifactV2, undefined, [
        proxy,
        database.runTransaction,
      ])
    ).rejects.toThrow('locked consumer')
    expect(traps).toBe(0)

    await expect(
      Reflect.apply(withVerifiedCopierSnapshotTrustRawArtifactV2, undefined, [
        proxy,
        database.runTransaction,
        async () => null,
      ])
    ).rejects.toThrow('non-proxy plain object')
    expect(traps).toBe(0)

    let anchorReads = 0
    const accessor = { ...input }
    Object.defineProperty(accessor, 'expectedSourceRunId', {
      enumerable: true,
      get() {
        anchorReads += 1
        return built.sourceRunId
      },
    })
    await expect(
      Reflect.apply(withVerifiedCopierSnapshotTrustRawArtifactV2, undefined, [
        accessor,
        database.runTransaction,
        async () => null,
      ])
    ).rejects.toThrow('enumerable data properties')
    expect(anchorReads).toBe(0)

    const mutableInput = { ...input }
    await expect(
      withVerifiedCopierSnapshotTrustRawArtifactV2(
        mutableInput,
        database.runTransaction,
        async () => {
          mutableInput.expectedSourceRunId = 'f'.repeat(64)
          mutableInput.expectedSourceSlug = 'mutated_source'
          return 'captured'
        }
      )
    ).resolves.toBe('captured')

    const extra = { ...input, rankEligible: true }
    await expect(
      Reflect.apply(withVerifiedCopierSnapshotTrustRawArtifactV2, undefined, [
        extra,
        database.runTransaction,
        async () => null,
      ])
    ).rejects.toThrow('exact anchor fields')

    const hidden = { ...input }
    Object.defineProperty(hidden, 'hidden', { enumerable: false, value: true })
    const symbol = { ...input }
    Object.defineProperty(symbol, Symbol('hidden'), { enumerable: true, value: true })
    for (const invalidEnvelope of [hidden, symbol]) {
      await expect(
        Reflect.apply(withVerifiedCopierSnapshotTrustRawArtifactV2, undefined, [
          invalidEnvelope,
          database.runTransaction,
          async () => null,
        ])
      ).rejects.toThrow('exact anchor fields')
    }

    let coercions = 0
    await expect(
      Reflect.apply(withVerifiedCopierSnapshotTrustRawArtifactV2, undefined, [
        {
          ...input,
          expectedSourceRunId: {
            toString() {
              coercions += 1
              return built.sourceRunId
            },
          },
        },
        database.runTransaction,
        async () => null,
      ])
    ).rejects.toThrow('outer source run id is invalid')
    expect(coercions).toBe(0)
  })

  it('preserves consumer errors while the caller-owned transaction rolls back', async () => {
    const { database, input } = await storedFixture()
    const consumerError = new Error('projection consumer failed')
    await expect(
      withVerifiedCopierSnapshotTrustRawArtifactV2(input, database.runTransaction, async () => {
        throw consumerError
      })
    ).rejects.toBe(consumerError)
  })

  it('rejects fully rehashed foreign canonical Storage as the anchored outer bytes', async () => {
    const { database, input, receipt } = await storedFixture()
    const foreignJson = Buffer.from(strictCanonicalJson({ foreign: true }), 'utf8')
    const foreignGzip = gzipSync(foreignJson)
    const foreignSourceRunId = createHash('sha256').update(foreignJson).digest('hex')
    const foreignInput = { ...input, expectedSourceRunId: foreignSourceRunId }
    const pointer = database.pointers[0]
    storage.delete(receipt.storagePath)
    pointer.storage_path =
      `${input.expectedSourceSlug}/copier_snapshot_trust/${input.expectedLane}/` +
      `${foreignSourceRunId}/copier_snapshot_trust_${foreignSourceRunId}.json.gz`
    pointer.bytes = foreignGzip.byteLength
    pointer.content_hash = foreignSourceRunId
    pointer.source_run_id = foreignSourceRunId
    const meta = pointer.meta as Record<string, unknown>
    meta.source_run_id = foreignSourceRunId
    const integrity = meta.raw_integrity as Record<string, unknown>
    integrity.compressed_bytes = foreignGzip.byteLength
    integrity.uncompressed_bytes = foreignJson.byteLength
    storage.set(pointer.storage_path, foreignGzip)

    await expect(
      withVerifiedCopierSnapshotTrustRawArtifactV2(
        foreignInput,
        database.runTransaction,
        async () => null
      )
    ).rejects.toThrow('artifact@2 semantic replay failed')
  })
})
