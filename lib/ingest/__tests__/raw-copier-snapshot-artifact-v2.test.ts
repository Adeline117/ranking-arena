import '../adapters/register'

import { gzipSync, gunzipSync } from 'node:zlib'

const storedObjects = new Map<string, Buffer>()
const mockUpload = jest.fn(async (path: string, payload: Buffer) => {
  if (storedObjects.has(path)) {
    return { error: { message: 'The resource already exists', statusCode: 409 } }
  }
  storedObjects.set(path, Buffer.from(payload))
  return { error: null }
})
const mockDownload = jest.fn(async (path: string) => {
  const payload = storedObjects.get(path)
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
  writeCopierSnapshotTrustRawArtifactV2,
} from '../raw'
import { STRICT_CANONICAL_JSON_CONTRACT, strictCanonicalJson } from '../strict-canonical-json'

type Candidate = Record<string, unknown>

interface Evidence {
  src: SourceRow
  snapshot: CopierSnapshotArtifact
  expectedSnapshot: CopierSnapshotArtifactAnchor
  candidateLedger: CopierCandidateLedger
  parserProof: CopierParserConservationProof
  rows: ParsedHistoryRow[]
}

const candidateA = {
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

function evidence(options: { lane?: 'tier_b' | 'tier_c' } = {}): Evidence {
  const src = source()
  const lane = options.lane ?? 'tier_c'
  const snapshot = buildCopierSnapshotArtifact({
    src,
    traderId: 101,
    exchangeTraderId: 'private-exchange-trader-101',
    lane,
    requestTimeframe: lane === 'tier_b' ? null : 0,
    pages: [page([candidateA])],
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

function artifactV2(options: { lane?: 'tier_b' | 'tier_c' } = {}): CopierSnapshotArtifactV2Result {
  return buildCopierSnapshotArtifactV2(evidence(options))
}

interface Pointer {
  id: number
  source_id: number
  job_type: string
  trader_id: number | null
  timeframe: number | null
  fetched_at: string
  fetched_at_exact: boolean
  observed_at_not_future: boolean
  storage_path: string
  bytes: number
  content_hash: string
  quarantined: boolean
  meta: unknown
  source_run_id: string | null
  trust_artifact_role: string | null
}

function databaseHarness(
  options: {
    pointerOverride?: Partial<Pointer>
    initialPointers?: Pointer[]
  } = {}
) {
  const pointers: Pointer[] = [...(options.initialPointers ?? [])]
  const events: string[] = []
  const query = jest.fn(async (sqlInput: unknown, values: readonly unknown[] = []) => {
    const sql = String(sqlInput)
    if (sql.includes('pg_advisory_xact_lock')) {
      events.push('advisory')
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('SELECT id, source_id, job_type')) {
      events.push('select')
      const storagePath = String(values[0])
      const sourceRunId = String(values[1])
      const role = String(values[2])
      const selected = pointers
        .filter(
          (pointer) =>
            pointer.storage_path === storagePath ||
            (pointer.source_run_id === sourceRunId && pointer.trust_artifact_role === role)
        )
        .map((pointer) => ({ ...pointer, ...options.pointerOverride }))
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
          fetched_at_exact: true,
          observed_at_not_future: true,
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
      events.push('runner')
      return operation(transaction)
    }
  ) as IngestTransactionRunner
  return { events, pointers, query, runTransaction }
}

function storagePathFor(built: CopierSnapshotArtifactV2Result): string {
  const snapshot = built.artifact.snapshot
  return (
    `${snapshot.source.slug}/copier_snapshot_trust/${snapshot.lane}/${built.sourceRunId}/` +
    `copier_snapshot_trust_${built.sourceRunId}.json.gz`
  )
}

describe('copier snapshot trust RAW artifact v2 writer', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
  })

  beforeEach(() => {
    storedObjects.clear()
    jest.clearAllMocks()
  })

  it('semantically revalidates and durably writes the outer artifact before one transaction', async () => {
    const built = artifactV2()
    const database = databaseHarness()
    const expectedPath = storagePathFor(built)

    await expect(
      writeCopierSnapshotTrustRawArtifactV2(built, database.runTransaction)
    ).resolves.toEqual({
      id: 8001,
      storagePath: expectedPath,
      contentHash: built.sourceRunId,
      sourceRunId: built.sourceRunId,
      snapshotSourceRunId: built.artifact.snapshot_source_run_id,
      candidateLedgerSha256: built.artifact.candidate_ledger_sha256,
      parserConservationSha256: built.artifact.parser_conservation_sha256,
      projectionLedgerSha256: built.artifact.projection_ledger_sha256,
    })

    expect(database.events).toEqual(['runner', 'advisory', 'select', 'insert', 'select'])
    expect(mockUpload.mock.invocationCallOrder[0]).toBeLessThan(
      database.runTransaction.mock.invocationCallOrder[0]
    )
    const [storagePath, compressed, uploadOptions] = mockUpload.mock.calls[0]
    expect(storagePath).toBe(expectedPath)
    expect(uploadOptions).toEqual({ contentType: 'application/gzip', upsert: false })
    expect(gunzipSync(compressed).toString('utf8')).toBe(strictCanonicalJson(built.artifact))

    const pointer = database.pointers[0]
    expect(pointer).toMatchObject({
      source_id: 34,
      job_type: 'tier_c',
      trader_id: 101,
      timeframe: null,
      fetched_at: built.artifact.snapshot.observed_at,
      storage_path: expectedPath,
      content_hash: built.sourceRunId,
      source_run_id: built.sourceRunId,
      trust_artifact_role: COPIER_SNAPSHOT_TRUST_RAW_ARTIFACT_ROLE,
    })
    expect(database.query.mock.calls[0][1]).toEqual([
      `arena.copier-snapshot-trust-raw-artifact:${built.sourceRunId}`,
    ])
    const pointerSelect = database.query.mock.calls.find(([sql]) =>
      String(sql).includes('SELECT id, source_id, job_type')
    )
    expect(String(pointerSelect?.[0])).toContain('storage_path = $1')
    expect(String(pointerSelect?.[0])).toContain('source_run_id = $2')
    expect(pointerSelect?.[1]?.slice(0, 3)).toEqual([
      expectedPath,
      built.sourceRunId,
      COPIER_SNAPSHOT_TRUST_RAW_ARTIFACT_ROLE,
    ])
  })

  it('verifies exact existing bytes and reuses one durable pointer on retry', async () => {
    const built = artifactV2()
    const database = databaseHarness()

    const first = await writeCopierSnapshotTrustRawArtifactV2(built, database.runTransaction)
    const second = await writeCopierSnapshotTrustRawArtifactV2(built, database.runTransaction)

    expect(second).toEqual(first)
    expect(mockUpload).toHaveBeenCalledTimes(2)
    expect(mockDownload).toHaveBeenCalledTimes(1)
    expect(
      database.query.mock.calls.filter(([sql]) =>
        String(sql).includes('INSERT INTO arena.raw_objects')
      )
    ).toHaveLength(1)
  })

  it('accepts an exact canonical object stored with a different gzip representation', async () => {
    const built = artifactV2()
    const database = databaseHarness()
    const jsonBytes = Buffer.from(strictCanonicalJson(built.artifact), 'utf8')
    const alternateGzip = gzipSync(jsonBytes, { level: 0 })
    storedObjects.set(storagePathFor(built), alternateGzip)

    await expect(
      writeCopierSnapshotTrustRawArtifactV2(built, database.runTransaction)
    ).resolves.toMatchObject({ sourceRunId: built.sourceRunId })

    expect(mockDownload).toHaveBeenCalledTimes(1)
    expect(Buffer.from(mockUpload.mock.calls[0][1]).equals(alternateGzip)).toBe(false)
    expect(database.pointers[0].bytes).toBe(alternateGzip.byteLength)
    expect(database.pointers[0].meta).toMatchObject({
      raw_integrity: { compressed_bytes: alternateGzip.byteLength },
    })
  })

  it('retries a transient Storage failure without opening the pointer transaction early', async () => {
    jest.useFakeTimers()
    try {
      const built = artifactV2()
      const database = databaseHarness()
      mockUpload.mockImplementationOnce(async () => ({
        error: { message: 'service unavailable', statusCode: 503 },
      }))

      const pending = writeCopierSnapshotTrustRawArtifactV2(built, database.runTransaction)
      await Promise.resolve()
      expect(database.runTransaction).not.toHaveBeenCalled()
      await jest.advanceTimersByTimeAsync(750)

      await expect(pending).resolves.toMatchObject({ sourceRunId: built.sourceRunId })
      expect(mockUpload).toHaveBeenCalledTimes(2)
      expect(database.runTransaction).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })

  it('rejects corrupt bytes at a deterministic 409 path before opening a transaction', async () => {
    const built = artifactV2()
    const database = databaseHarness()
    storedObjects.set(storagePathFor(built), gzipSync(Buffer.from('{}', 'utf8')))

    await expect(
      writeCopierSnapshotTrustRawArtifactV2(built, database.runTransaction)
    ).rejects.toThrow('existing Storage object')
    expect(mockDownload).toHaveBeenCalledTimes(1)
    expect(database.runTransaction).not.toHaveBeenCalled()
  })

  it('rejects invalid gzip and output larger than the exact expected JSON before a transaction', async () => {
    const built = artifactV2()
    const database = databaseHarness()
    const storagePath = storagePathFor(built)

    storedObjects.set(storagePath, Buffer.from('not-gzip', 'utf8'))
    await expect(
      writeCopierSnapshotTrustRawArtifactV2(built, database.runTransaction)
    ).rejects.toThrow('is not gzip')

    const expected = Buffer.from(strictCanonicalJson(built.artifact), 'utf8')
    storedObjects.set(storagePath, gzipSync(Buffer.concat([expected, Buffer.from(' ')])))
    await expect(
      writeCopierSnapshotTrustRawArtifactV2(built, database.runTransaction)
    ).rejects.toThrow('invalid gzip data')

    expect(database.runTransaction).not.toHaveBeenCalled()
  })

  it('rejects a declared oversized 409 object before reading its body', async () => {
    const built = artifactV2()
    const database = databaseHarness()
    const arrayBuffer = jest.fn(async () => new ArrayBuffer(0))
    storedObjects.set(storagePathFor(built), Buffer.from('occupied'))
    mockDownload.mockImplementationOnce(async () => ({
      data: { size: 2_147_483_648, arrayBuffer },
      error: null,
    }))

    await expect(
      writeCopierSnapshotTrustRawArtifactV2(built, database.runTransaction)
    ).rejects.toThrow('compressed byte limit')
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(database.runTransaction).not.toHaveBeenCalled()
  })

  it('rejects an oversized 409 body even when its declared size is forged smaller', async () => {
    const built = artifactV2()
    const database = databaseHarness()
    const expectedBytes = Buffer.byteLength(strictCanonicalJson(built.artifact), 'utf8')
    const oversized = Buffer.alloc(expectedBytes + 64 * 1024 + 1)
    storedObjects.set(storagePathFor(built), Buffer.from('occupied'))
    mockDownload.mockImplementationOnce(async () => ({
      data: {
        size: 1,
        arrayBuffer: async () =>
          oversized.buffer.slice(oversized.byteOffset, oversized.byteOffset + oversized.byteLength),
      },
      error: null,
    }))

    await expect(
      writeCopierSnapshotTrustRawArtifactV2(built, database.runTransaction)
    ).rejects.toThrow('compressed byte limit')
    expect(database.runTransaction).not.toHaveBeenCalled()
  })

  it('writes Tier-B evidence under its history job and isolated tier path', async () => {
    const built = artifactV2({ lane: 'tier_b' })
    const database = databaseHarness()

    await expect(
      writeCopierSnapshotTrustRawArtifactV2(built, database.runTransaction)
    ).resolves.toMatchObject({
      sourceRunId: built.sourceRunId,
      storagePath:
        `bingx_futures/copier_snapshot_trust/tier_b/${built.sourceRunId}/` +
        `copier_snapshot_trust_${built.sourceRunId}.json.gz`,
    })
    expect(database.pointers[0]).toMatchObject({
      job_type: 'history:copiers',
      timeframe: null,
      trust_artifact_role: COPIER_SNAPSHOT_TRUST_RAW_ARTIFACT_ROLE,
    })
  })

  it.each([
    'snapshot_source_run_id',
    'candidate_ledger_sha256',
    'parser_conservation_sha256',
    'projection_ledger_sha256',
  ] as const)('never accepts nested %s as the outer source-run anchor', async (field) => {
    const built = artifactV2()
    const database = databaseHarness()

    await expect(
      writeCopierSnapshotTrustRawArtifactV2(
        { artifact: built.artifact, sourceRunId: built.artifact[field] },
        database.runTransaction
      )
    ).rejects.toThrow('outer artifact does not match its immutable source-run anchor')
    expect(mockUpload).not.toHaveBeenCalled()
    expect(database.runTransaction).not.toHaveBeenCalled()
  })

  it('requires a caller-owned transaction before reading input or doing Storage I/O', async () => {
    let wrapperTraps = 0
    const wrapped = new Proxy(artifactV2(), {
      getPrototypeOf() {
        wrapperTraps += 1
        return Object.prototype
      },
    })
    await expect(
      Reflect.apply(writeCopierSnapshotTrustRawArtifactV2, undefined, [wrapped, undefined])
    ).rejects.toThrow('a claimed transaction runner is required')
    expect(wrapperTraps).toBe(0)
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('captures the external primitive through data descriptors without coercion or traps', async () => {
    const built = artifactV2()
    const database = databaseHarness()
    let anchorReads = 0
    const accessorInput: { artifact: unknown; sourceRunId: unknown } = {
      artifact: built.artifact,
      sourceRunId: built.sourceRunId,
    }
    Object.defineProperty(accessorInput, 'sourceRunId', {
      enumerable: true,
      get() {
        anchorReads += 1
        return built.sourceRunId
      },
    })
    await expect(
      Reflect.apply(writeCopierSnapshotTrustRawArtifactV2, undefined, [
        accessorInput,
        database.runTransaction,
      ])
    ).rejects.toThrow('enumerable data properties')
    expect(anchorReads).toBe(0)

    let coercions = 0
    await expect(
      Reflect.apply(writeCopierSnapshotTrustRawArtifactV2, undefined, [
        {
          artifact: built.artifact,
          sourceRunId: {
            toString() {
              coercions += 1
              return built.sourceRunId
            },
          },
        },
        database.runTransaction,
      ])
    ).rejects.toThrow('source run id must be a lowercase SHA-256 digest')
    expect(coercions).toBe(0)
    expect(mockUpload).not.toHaveBeenCalled()
    expect(database.runTransaction).not.toHaveBeenCalled()
  })

  it('rejects extra, hidden, symbol, and accessor fields in the exact input envelope', async () => {
    const built = artifactV2()
    const database = databaseHarness()
    const cases: unknown[] = [{ ...built, extra: true }]
    const hidden = { ...built }
    Object.defineProperty(hidden, 'hidden', { enumerable: false, value: true })
    cases.push(hidden)
    const symbol = { ...built }
    Object.defineProperty(symbol, Symbol('hidden'), { enumerable: true, value: true })
    cases.push(symbol)

    for (const value of cases) {
      await expect(
        Reflect.apply(writeCopierSnapshotTrustRawArtifactV2, undefined, [
          value,
          database.runTransaction,
        ])
      ).rejects.toThrow('exact contract fields')
    }

    let artifactReads = 0
    const accessor: { artifact: unknown; sourceRunId: string } = { ...built }
    Object.defineProperty(accessor, 'artifact', {
      enumerable: true,
      get() {
        artifactReads += 1
        return built.artifact
      },
    })
    await expect(
      Reflect.apply(writeCopierSnapshotTrustRawArtifactV2, undefined, [
        accessor,
        database.runTransaction,
      ])
    ).rejects.toThrow('enumerable data properties')
    expect(artifactReads).toBe(0)
    expect(mockUpload).not.toHaveBeenCalled()
    expect(database.runTransaction).not.toHaveBeenCalled()
  })

  it('rejects wrapper and nested artifact proxies without running traps', async () => {
    const built = artifactV2()
    const database = databaseHarness()
    let wrapperTraps = 0
    const wrapper = new Proxy(built, {
      getPrototypeOf() {
        wrapperTraps += 1
        return Object.prototype
      },
    })
    await expect(
      writeCopierSnapshotTrustRawArtifactV2(wrapper, database.runTransaction)
    ).rejects.toThrow('non-proxy plain object')
    expect(wrapperTraps).toBe(0)

    let nestedTraps = 0
    const artifact = new Proxy(built.artifact, {
      getPrototypeOf() {
        nestedTraps += 1
        return Object.prototype
      },
    })
    await expect(
      Reflect.apply(writeCopierSnapshotTrustRawArtifactV2, undefined, [
        { artifact, sourceRunId: built.sourceRunId },
        database.runTransaction,
      ])
    ).rejects.toThrow('proxy objects')
    expect(nestedTraps).toBe(0)
    expect(mockUpload).not.toHaveBeenCalled()
    expect(database.runTransaction).not.toHaveBeenCalled()
  })

  it('fails closed on a competing pointer selected by outer identity', async () => {
    const built = artifactV2()
    const snapshot = built.artifact.snapshot
    const competing: Pointer = {
      id: 7000,
      source_id: snapshot.source.id,
      job_type: 'tier_c',
      trader_id: snapshot.trader.id,
      timeframe: null,
      fetched_at: snapshot.observed_at,
      fetched_at_exact: true,
      observed_at_not_future: true,
      storage_path: `${snapshot.source.slug}/competing.json.gz`,
      bytes: 1,
      content_hash: built.sourceRunId,
      quarantined: false,
      meta: {},
      source_run_id: built.sourceRunId,
      trust_artifact_role: COPIER_SNAPSHOT_TRUST_RAW_ARTIFACT_ROLE,
    }
    const database = databaseHarness({ initialPointers: [competing] })

    await expect(
      writeCopierSnapshotTrustRawArtifactV2(built, database.runTransaction)
    ).rejects.toThrow('does not match the artifact')
    expect(database.events).toEqual(['runner', 'advisory', 'select'])
    expect(
      database.query.mock.calls.some(([sql]) =>
        String(sql).includes('INSERT INTO arena.raw_objects')
      )
    ).toBe(false)
  })

  it.each([
    ['future observation', { observed_at_not_future: false }],
    ['wrong fetched-at', { fetched_at_exact: false }],
    ['quarantined pointer', { quarantined: true }],
    ['wrong source', { source_id: 35 }],
    ['wrong job', { job_type: 'history:copiers' }],
    ['wrong trader', { trader_id: 102 }],
    ['non-null timeframe', { timeframe: 7 }],
    ['wrong path', { storage_path: 'bingx_futures/wrong.json.gz' }],
    ['wrong bytes', { bytes: 1 }],
    ['wrong content hash', { content_hash: 'f'.repeat(64) }],
    ['wrong outer source run', { source_run_id: 'f'.repeat(64) }],
    ['wrong role', { trust_artifact_role: 'copier_snapshot' }],
    ['wrong metadata', { meta: { surface: 'copiers' } }],
  ])('rejects %s pointer drift', async (_label, pointerOverride) => {
    const database = databaseHarness({ pointerOverride })
    await expect(
      writeCopierSnapshotTrustRawArtifactV2(artifactV2(), database.runTransaction)
    ).rejects.toThrow('does not match the artifact')
  })

  it('keeps exact metadata limited to public coordinates, contracts, and nested hashes', async () => {
    const built = artifactV2()
    const database = databaseHarness()
    await writeCopierSnapshotTrustRawArtifactV2(built, database.runTransaction)
    const meta = database.pointers[0].meta as Record<string, unknown>

    expect(Object.keys(meta).sort()).toEqual(
      [
        'surface',
        'data_contract',
        'source_run_id',
        'source_id',
        'source_slug',
        'trader_id',
        'lane',
        'observed_at',
        'snapshot_artifact_contract',
        'snapshot_source_run_id',
        'candidate_ledger_contract',
        'candidate_ledger_sha256',
        'parser_conservation_contract',
        'parser_conservation_sha256',
        'projection_ledger_contract',
        'projection_ledger_sha256',
        'raw_integrity',
      ].sort()
    )
    expect(meta).toMatchObject({
      source_run_id: built.sourceRunId,
      snapshot_source_run_id: built.artifact.snapshot_source_run_id,
      candidate_ledger_sha256: built.artifact.candidate_ledger_sha256,
      parser_conservation_sha256: built.artifact.parser_conservation_sha256,
      projection_ledger_sha256: built.artifact.projection_ledger_sha256,
      raw_integrity: { serialization_contract: STRICT_CANONICAL_JSON_CONTRACT },
    })
    const serializedMeta = strictCanonicalJson(meta)
    for (const forbidden of [
      'private-exchange-trader-101',
      'private-candidate-a',
      'private-name-a',
      'exchange_trader_id',
      'page_count',
      'row_count',
      'scan_terminal_state',
      'caller_limited',
      'source_reported_row_count',
      'complete',
      'rank_eligible',
    ]) {
      expect(serializedMeta).not.toContain(forbidden)
    }
  })
})
