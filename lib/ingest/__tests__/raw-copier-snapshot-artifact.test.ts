import { gunzipSync } from 'node:zlib'

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

import type { SourceRow } from '../core/types'
import type { IngestQueryExecutor } from '../db'
import {
  buildCopierSnapshotArtifact,
  copierSnapshotSourceRunId,
  COPIER_SNAPSHOT_ARTIFACT_CONTRACT,
  COPIER_SNAPSHOT_RAW_ARTIFACT_ROLE,
} from '../copier-snapshot-artifact'
import { type IngestTransactionRunner, writeCopierSnapshotRawArtifact } from '../raw'
import { STRICT_CANONICAL_JSON_CONTRACT, strictCanonicalJson } from '../strict-canonical-json'

const source = {
  id: 34,
  slug: 'gate_futures',
  currency: 'USDT',
  copier_table_depth: 'top10',
  fetch_region: 'local',
  status: 'active',
  serving_mode: 'serving',
} as SourceRow

function artifact() {
  return buildCopierSnapshotArtifact({
    src: source,
    traderId: 101,
    exchangeTraderId: 'trader-101',
    lane: 'tier_c',
    requestTimeframe: 0,
    pages: [
      {
        pageIndex: 1,
        payload: { users: [{ id: 'private-1', pnl: '12.50' }] },
        url: 'https://example.test/copiers?page=1',
        fetchedAt: '2026-08-04T10:00:00.000Z',
      },
    ],
    callerLimited: false,
  })
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

function databaseHarness(overrides: Partial<Pointer> = {}) {
  let pointer: Pointer | null = null
  const events: string[] = []
  const query = jest.fn(async (sqlInput: unknown, values: readonly unknown[] = []) => {
    const sql = String(sqlInput)
    if (sql.includes('pg_advisory_xact_lock')) {
      events.push('advisory')
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('SELECT id, source_id, job_type')) {
      events.push('select')
      return { rows: pointer ? [{ ...pointer, ...overrides }] : [], rowCount: pointer ? 1 : 0 }
    }
    if (sql.includes('INSERT INTO arena.raw_objects')) {
      events.push('insert')
      pointer = {
        id: 7001,
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
  return { events, query, runTransaction, pointer: () => pointer }
}

describe('copier snapshot RAW artifact writer', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
  })

  beforeEach(() => {
    storedObjects.clear()
    jest.clearAllMocks()
  })

  it('uploads strict canonical evidence before one caller-owned pointer transaction', async () => {
    const capture = artifact()
    const sourceRunId = copierSnapshotSourceRunId(capture)
    const database = databaseHarness()

    await expect(
      writeCopierSnapshotRawArtifact({ artifact: capture }, database.runTransaction)
    ).resolves.toEqual({
      id: 7001,
      storagePath: `gate_futures/copier_snapshot/tier_c/1785837600000_${sourceRunId}.json.gz`,
      contentHash: sourceRunId,
    })

    expect(database.events).toEqual(['runner', 'advisory', 'select', 'insert', 'select'])
    expect(mockUpload.mock.invocationCallOrder[0]).toBeLessThan(
      database.runTransaction.mock.invocationCallOrder[0]
    )
    const [storagePath, compressed, uploadOptions] = mockUpload.mock.calls[0]
    expect(storagePath).toContain(sourceRunId)
    expect(uploadOptions).toEqual({ contentType: 'application/gzip', upsert: false })
    expect(gunzipSync(compressed).toString('utf8')).toBe(strictCanonicalJson(capture))

    const pointer = database.pointer()
    expect(pointer).toMatchObject({
      source_id: 34,
      job_type: 'tier_c',
      trader_id: 101,
      timeframe: null,
      fetched_at: capture.observed_at,
      content_hash: sourceRunId,
      source_run_id: sourceRunId,
      trust_artifact_role: COPIER_SNAPSHOT_RAW_ARTIFACT_ROLE,
    })
    expect(pointer?.meta).toMatchObject({
      surface: 'copiers',
      data_contract: COPIER_SNAPSHOT_ARTIFACT_CONTRACT,
      source_run_id: sourceRunId,
      source_id: 34,
      source_slug: 'gate_futures',
      trader_id: 101,
      exchange_trader_id: 'trader-101',
      lane: 'tier_c',
      request_timeframe: 0,
      observed_at: capture.observed_at,
      page_count: 1,
      scan_terminal_state: 'stream_exhausted_unverified',
      caller_limited: false,
      source_reported_row_count: null,
      source_depth: 'top10',
      currency: 'USDT',
      fetch_region: 'local',
      fetch_failed: false,
      raw_integrity: {
        serialization_contract: STRICT_CANONICAL_JSON_CONTRACT,
      },
    })
  })

  it('verifies Storage and reuses the exact durable pointer on retry', async () => {
    const capture = artifact()
    const database = databaseHarness()

    const first = await writeCopierSnapshotRawArtifact(
      { artifact: capture },
      database.runTransaction
    )
    const second = await writeCopierSnapshotRawArtifact(
      { artifact: capture },
      database.runTransaction
    )

    expect(second).toEqual(first)
    expect(mockUpload).toHaveBeenCalledTimes(2)
    expect(mockDownload).toHaveBeenCalledTimes(1)
    expect(
      database.query.mock.calls.filter(([sql]) =>
        String(sql).includes('INSERT INTO arena.raw_objects')
      )
    ).toHaveLength(1)
  })

  it('rejects forged artifacts before Storage or transaction work', async () => {
    const capture = artifact()
    const forged = { ...capture, page_count: 2 }
    const database = databaseHarness()

    await expect(
      writeCopierSnapshotRawArtifact({ artifact: forged }, database.runTransaction)
    ).rejects.toThrow('artifact is not the exact canonical contract')
    expect(mockUpload).not.toHaveBeenCalled()
    expect(database.runTransaction).not.toHaveBeenCalled()
  })

  it('requires a caller-owned transaction before any Storage I/O', async () => {
    const unsafeWriter = writeCopierSnapshotRawArtifact as unknown as (
      input: unknown,
      runner?: unknown
    ) => Promise<unknown>
    await expect(unsafeWriter({ artifact: artifact() })).rejects.toThrow(
      'a claimed transaction runner is required'
    )
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it.each([
    ['future observation', { observed_at_not_future: false }],
    ['quarantined pointer', { quarantined: true }],
    ['wrong source', { source_id: 35 }],
    ['wrong trader', { trader_id: 102 }],
    ['wrong role', { trust_artifact_role: 'event_history' }],
    ['wrong hash', { source_run_id: 'f'.repeat(64) }],
    ['wrong metadata', { meta: { surface: 'copiers' } }],
  ])('rejects a %s database pointer', async (_label, pointerOverride) => {
    const database = databaseHarness(pointerOverride)
    await expect(
      writeCopierSnapshotRawArtifact({ artifact: artifact() }, database.runTransaction)
    ).rejects.toThrow('does not match the artifact')
  })
})
