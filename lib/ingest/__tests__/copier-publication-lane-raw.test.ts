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

import type { IngestQueryExecutor } from '../db'
import {
  buildCopierPublicationLaneArtifact,
  copierPublicationLaneSourceRunId,
  COPIER_PUBLICATION_LANE_ARTIFACT_CONTRACT,
  COPIER_PUBLICATION_LANE_RAW_ARTIFACT_ROLE,
  type CopierPublicationLane,
  type CopierPublicationLaneArtifact,
} from '../copier-publication-lane-artifact'
import {
  COPIER_PUBLICATION_LANE_RAW_EVIDENCE_CONTRACT,
  type CopierPublicationLaneTransactionRunner,
  writeCopierPublicationLaneRawArtifact,
} from '../copier-publication-lane-raw'
import {
  captureHistoryAcquisition,
  HISTORY_ACQUISITION_ARTIFACT_CONTRACT,
  HISTORY_TERMINAL_CLAIM_CONTRACT,
  type HistoryTerminalClaim,
} from '../history-acquisition'
import { STRICT_CANONICAL_JSON_CONTRACT, strictCanonicalJson } from '../strict-canonical-json'

interface Pointer {
  id: number
  source_id: number
  job_type: string
  trader_id: number | null
  timeframe: number | null
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

type PointerOverride = Partial<Pointer> | ((pointer: Readonly<Pointer>) => Readonly<Pointer>)

const attemptStartedAt = '2026-08-03T10:00:00.000Z'
const observedAt = '2026-08-03T10:00:01.000Z'

function terminalClaim(): HistoryTerminalClaim {
  return {
    contract: HISTORY_TERMINAL_CLAIM_CONTRACT,
    observations: [{ segment_id: 'followers', reason: 'reported_end', page_ordinal: 1 }],
  }
}

async function artifact(
  lane: CopierPublicationLane = 'tier_b',
  fetchedAt = observedAt
): Promise<CopierPublicationLaneArtifact> {
  async function* stream() {
    yield {
      pageIndex: 1,
      payload: { data: [{ followerId: 'private-1', pnl: '12.50' }], total: 1 },
      url: 'https://example.test/copiers?page=1',
      fetchedAt,
    }
    return terminalClaim()
  }
  const captured = await captureHistoryAcquisition({
    source: { id: 34, slug: 'gate_futures' },
    traderId: 101,
    exchangeTraderId: 'trader-101',
    kind: 'copiers',
    cursor: null,
    attemptStartedAt:
      Date.parse(fetchedAt) < Date.parse(attemptStartedAt) ? fetchedAt : attemptStartedAt,
    stream: stream(),
    terminalVerifier: {
      contract: 'arena.ingest.history-terminal-verifier.gate_futures.copiers@1',
      verify: () => ({ verified: true, scanTerminalState: 'exhausted' }),
    },
  })
  return buildCopierPublicationLaneArtifact({ lane, acquisition: captured.artifact })
}

function applyOverride(pointer: Pointer, override: PointerOverride | undefined): Pointer {
  if (typeof override === 'function') return { ...override(pointer) }
  return { ...pointer, ...override }
}

function databaseHarness(override?: PointerOverride, options: { competingReplay?: boolean } = {}) {
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
      if (!pointer) return { rows: [], rowCount: 0 }
      const selected = applyOverride(pointer, override)
      return {
        rows: options.competingReplay
          ? [
              selected,
              { ...selected, id: selected.id + 1, storage_path: `${selected.storage_path}.other` },
            ]
          : [selected],
        rowCount: options.competingReplay ? 2 : 1,
      }
    }
    if (sql.includes('INSERT INTO arena.raw_objects')) {
      events.push('insert')
      pointer = {
        id: 7001,
        source_id: Number(values[0]),
        job_type: String(values[1]),
        trader_id: Number(values[2]),
        timeframe: null,
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
  ) as CopierPublicationLaneTransactionRunner & jest.Mock
  return { events, pointer: () => pointer, query, runTransaction }
}

describe('copier publication lane RAW writer', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
  })

  beforeEach(() => {
    storedObjects.clear()
    jest.clearAllMocks()
  })

  it.each([
    ['tier_b' as const, 'history:copiers'],
    ['tier_c' as const, 'tier_c'],
  ])('stores the entire %s wrapper before its exact pointer', async (lane, expectedJobType) => {
    const wrapper = await artifact(lane)
    const sourceRunId = copierPublicationLaneSourceRunId(wrapper)
    const database = databaseHarness()

    await expect(
      writeCopierPublicationLaneRawArtifact({ artifact: wrapper }, database.runTransaction)
    ).resolves.toEqual({
      id: 7001,
      storagePath:
        `gate_futures/copier_publication/${lane}/${sourceRunId}/` +
        `copier_snapshot_${sourceRunId}.json.gz`,
      contentHash: sourceRunId,
    })

    expect(database.events).toEqual(['runner', 'advisory', 'select', 'insert', 'select'])
    expect(mockUpload.mock.invocationCallOrder[0]).toBeLessThan(
      database.runTransaction.mock.invocationCallOrder[0]
    )
    const [storagePath, compressed, uploadOptions] = mockUpload.mock.calls[0]
    expect(storagePath).toContain(sourceRunId)
    expect(uploadOptions).toEqual({ contentType: 'application/gzip', upsert: false })
    expect(gunzipSync(compressed).toString('utf8')).toBe(strictCanonicalJson(wrapper))

    const pointer = database.pointer()
    expect(pointer).toMatchObject({
      source_id: 34,
      job_type: expectedJobType,
      trader_id: 101,
      timeframe: null,
      content_hash: sourceRunId,
      source_run_id: sourceRunId,
      trust_artifact_role: COPIER_PUBLICATION_LANE_RAW_ARTIFACT_ROLE,
    })
    const meta = pointer?.meta as Record<string, unknown>
    expect(Object.keys(meta).sort()).toEqual([
      'acquisition_contract',
      'acquisition_source_run_id',
      'attempt_started_at',
      'capture_config',
      'data_contract',
      'exchange_trader_id',
      'history_kind',
      'observed_at',
      'page_count',
      'publication_eligible',
      'publication_evidence_contract',
      'publication_lane',
      'raw_integrity',
      'scan_terminal_state',
      'source_id',
      'source_run_id',
      'source_slug',
      'starting_cursor',
      'surface',
      'terminal_evidence_state',
      'termination',
      'trader_id',
      'verifier_contract',
    ])
    expect(meta).toMatchObject({
      surface: 'copiers',
      publication_eligible: true,
      publication_evidence_contract: COPIER_PUBLICATION_LANE_RAW_EVIDENCE_CONTRACT,
      data_contract: COPIER_PUBLICATION_LANE_ARTIFACT_CONTRACT,
      publication_lane: lane,
      source_run_id: sourceRunId,
      acquisition_contract: HISTORY_ACQUISITION_ARTIFACT_CONTRACT,
      acquisition_source_run_id: wrapper.acquisition_source_run_id,
      source_id: 34,
      source_slug: 'gate_futures',
      trader_id: 101,
      exchange_trader_id: 'trader-101',
      history_kind: 'copiers',
      attempt_started_at: attemptStartedAt,
      starting_cursor: null,
      capture_config: { caller_page_cap: null },
      observed_at: observedAt,
      page_count: 1,
      terminal_evidence_state: 'verified',
      scan_terminal_state: 'exhausted',
      verifier_contract: 'arena.ingest.history-terminal-verifier.gate_futures.copiers@1',
      termination: wrapper.acquisition.termination,
      raw_integrity: {
        version: 1,
        content_type: 'application/json',
        encoding: 'utf-8',
        compression: 'gzip',
        hash_algorithm: 'sha256',
        hash_scope: 'json_utf8',
        serialization_contract: STRICT_CANONICAL_JSON_CONTRACT,
        compressed_bytes: pointer?.bytes,
        uncompressed_bytes: Buffer.byteLength(strictCanonicalJson(wrapper), 'utf8'),
      },
    })
  })

  it('verifies Storage bytes and returns only the exact durable pointer on replay', async () => {
    const wrapper = await artifact()
    const database = databaseHarness()

    const first = await writeCopierPublicationLaneRawArtifact(
      { artifact: wrapper },
      database.runTransaction
    )
    const second = await writeCopierPublicationLaneRawArtifact(
      { artifact: wrapper },
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

  it('rejects different existing Storage content on replay', async () => {
    const wrapper = await artifact()
    const database = databaseHarness()
    const first = await writeCopierPublicationLaneRawArtifact(
      { artifact: wrapper },
      database.runTransaction
    )
    storedObjects.set(first.storagePath, gzipSync(Buffer.from('{"forged":true}', 'utf8')))

    await expect(
      writeCopierPublicationLaneRawArtifact({ artifact: wrapper }, database.runTransaction)
    ).rejects.toThrow('has different content')
  })

  it('rejects forged wrappers and missing transaction authority before Storage I/O', async () => {
    const wrapper = await artifact()
    const forged = { ...wrapper, publication_ready: true }
    const database = databaseHarness()

    await expect(
      writeCopierPublicationLaneRawArtifact(
        { artifact: forged as CopierPublicationLaneArtifact },
        database.runTransaction
      )
    ).rejects.toThrow('artifact contract is invalid')
    const unsafeCall = Reflect.apply(writeCopierPublicationLaneRawArtifact, null, [
      { artifact: wrapper },
    ])
    await expect(unsafeCall).rejects.toThrow('a claimed transaction runner is required')
    expect(mockUpload).not.toHaveBeenCalled()
    expect(database.runTransaction).not.toHaveBeenCalled()
  })

  it('fails closed on a future observation before creating RAW state', async () => {
    const wrapper = await artifact('tier_b', '2099-08-03T10:00:01.000Z')
    const database = databaseHarness()

    await expect(
      writeCopierPublicationLaneRawArtifact({ artifact: wrapper }, database.runTransaction)
    ).rejects.toThrow('observed_at is more than five minutes in the future')
    expect(mockUpload).not.toHaveBeenCalled()
    expect(database.runTransaction).not.toHaveBeenCalled()
  })

  it.each([
    ['wrong job', { job_type: 'tier_c' }],
    ['wrong role', { trust_artifact_role: 'event_history' }],
    ['wrong content hash', { content_hash: 'f'.repeat(64) }],
    ['wrong source-run hash', { source_run_id: 'f'.repeat(64) }],
    ['wrong path', { storage_path: 'gate_futures/forged.json.gz' }],
    ['wrong receipt', { id: 0 }],
    ['wrong byte receipt', { bytes: 1 }],
    ['wrong timestamp', { fetched_at_exact: false }],
    ['future database clock evidence', { observed_at_not_future: false }],
    ['quarantined pointer', { quarantined: true }],
    ['wrong source', { source_id: 35 }],
    ['wrong trader', { trader_id: 102 }],
    ['wrong timeframe', { timeframe: 30 }],
    ['wrong metadata', { meta: { surface: 'copiers' } }],
  ])('rejects a %s pointer', async (_label, pointerOverride) => {
    const database = databaseHarness(pointerOverride)
    await expect(
      writeCopierPublicationLaneRawArtifact({ artifact: await artifact() }, database.runTransaction)
    ).rejects.toThrow(/database pointer|positive safe integer/)
  })

  it('rejects a metadata lane mismatch and a competing replay receipt', async () => {
    const wrongLane = databaseHarness((pointer) => ({
      ...pointer,
      meta: {
        ...(pointer.meta as Record<string, unknown>),
        publication_lane: 'tier_c',
      },
    }))
    await expect(
      writeCopierPublicationLaneRawArtifact(
        { artifact: await artifact('tier_b') },
        wrongLane.runTransaction
      )
    ).rejects.toThrow('does not match the exact wrapper')

    storedObjects.clear()
    const competing = databaseHarness(undefined, { competingReplay: true })
    await expect(
      writeCopierPublicationLaneRawArtifact(
        { artifact: await artifact('tier_c') },
        competing.runTransaction
      )
    ).rejects.toThrow('expected one exact database pointer, found 2')
  })
})
