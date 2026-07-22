import { gzipSync, gunzipSync } from 'node:zlib'
import type { PoolClient } from 'pg'

const mockUpload = jest.fn()
const mockDownload = jest.fn()
const mockConnect = jest.fn()

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    storage: {
      from: jest.fn(() => ({ upload: mockUpload, download: mockDownload })),
    },
  })),
}))

jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: jest.fn(),
  ingestClientConnect: (...args: unknown[]) => mockConnect(...args),
}))

import {
  buildLeaderboardAcquisitionManifest,
  buildLeaderboardAcquisitionManifestV3,
  LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
} from '@/lib/ingest/acquisition-manifest'
import {
  ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT,
  type LeaderboardAcquisitionAttempt,
} from '@/lib/ingest/acquisition-attempts'
import {
  writeAttemptBoundLeaderboardRawArtifactSet,
  writeLeaderboardRawArtifactSet,
} from '@/lib/ingest/raw'
import type { RawPage } from '@/lib/ingest/core/types'
import { strictCanonicalJson, strictCanonicalSha256 } from '@/lib/ingest/strict-canonical-json'

interface PointerRow {
  id: number
  source_id: number
  job_type: string
  trader_id: number | null
  timeframe: number
  fetched_at: string
  storage_path: string
  bytes: number
  content_hash: string
  quarantined: boolean
  meta: unknown
  source_run_id: string | null
  trust_artifact_role: string | null
}

const sourcePages: RawPage[] = [
  {
    pageIndex: 1,
    payload: { data: [{ id: 'one' }, { id: 'two' }], total: 3 },
    url: 'https://example.test/board?page=1',
    fetchedAt: '2026-07-21T10:00:01.000Z',
  },
  {
    pageIndex: 2,
    payload: { data: [{ id: 'three' }], total: 3 },
    url: 'https://example.test/board?page=2',
    fetchedAt: '2026-07-21T10:00:02.000Z',
  },
]

const attemptId = '00000000-0000-4000-8000-000000000001'
const observationCycleId = 'tier-a:binance_futures:job-1:1784628000000'
const captureStartedAt = '2026-07-21T10:00:00.000Z'
const captureCompletedAt = '2026-07-21T10:00:03.000Z'

function manifestBuildInput(): Parameters<typeof buildLeaderboardAcquisitionManifest>[0] {
  return {
    source: {
      id: 1,
      slug: 'binance_futures',
      adapter_slug: 'binance',
      configured_page_size: 2,
      configured_pagination_kind: 'numeric',
    },
    surface: 'tier_a_leaderboard',
    timeframe: 30,
    started_at: captureStartedAt,
    completed_at: captureCompletedAt,
    runner_git_sha: 'a'.repeat(40),
    observation_cycle_id: observationCycleId,
    capture_evidence_state: 'verified',
    termination_reason: 'reported_population_reached',
    capture_config: { caller_page_cap: null, safety_page_cap: 5_000 },
    source_pages: [
      {
        raw_page: sourcePages[0],
        source_row_count: 2,
        request_sha256: 'b'.repeat(64),
        http_status: 200,
        pagination_position: { kind: 'page_index', request_page_index: 1 },
        source_reports: {
          population: { state: 'reported', value: 3 },
          page_count: { state: 'not_reported' },
          current_page: { state: 'not_reported' },
          page_size: { state: 'not_reported' },
        },
      },
      {
        raw_page: sourcePages[1],
        source_row_count: 1,
        request_sha256: 'c'.repeat(64),
        http_status: 200,
        pagination_position: { kind: 'page_index', request_page_index: 2 },
        source_reports: {
          population: { state: 'reported', value: 3 },
          page_count: { state: 'not_reported' },
          current_page: { state: 'not_reported' },
          page_size: { state: 'not_reported' },
        },
      },
    ],
    parse_pages: sourcePages,
    parser_transformation: {
      kind: 'identity_projection',
      source_page_ordinals: [1, 2],
    },
    accepted_population: 3,
    rejected_row_count: 0,
  }
}

function artifactInput() {
  const built = buildLeaderboardAcquisitionManifest(manifestBuildInput())
  return {
    sourceId: 1,
    sourceSlug: 'binance_futures',
    timeframe: 30 as const,
    sourceRunId: built.sourceRunId,
    sourcePages: sourcePages.map((page) => ({ ...page })),
    manifest: built.manifest,
    observationCycleId,
  }
}

function acquisitionAttempt(
  overrides: Partial<LeaderboardAcquisitionAttempt> = {}
): LeaderboardAcquisitionAttempt {
  return {
    attemptSeq: 41,
    attemptId,
    sourceId: 1,
    sourceSlug: 'binance_futures',
    adapterSlug: 'binance',
    timeframe: 30,
    observationCycleId,
    queueJobId: 'job-1',
    queueAttempt: 1,
    captureContract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT,
    attemptBindingContract: LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
    runnerGitSha: 'a'.repeat(40),
    workerRegion: 'vps_sg',
    sourceStatus: 'active',
    sourceServingMode: 'serving',
    sourceCurrency: 'USDT',
    sourceFetchRegion: 'vps_sg',
    recordedStartedAt: captureStartedAt,
    replayed: false,
    ...overrides,
  }
}

function attemptBoundArtifactInput(
  options: {
    attempt?: Partial<LeaderboardAcquisitionAttempt>
    binding?: Partial<{
      binding_contract: typeof LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT
      attempt_id: string
      attempt_seq: number
    }>
    manifest?: Partial<ReturnType<typeof manifestBuildInput>>
  } = {}
) {
  const attempt = acquisitionAttempt(options.attempt)
  const built = buildLeaderboardAcquisitionManifestV3({
    ...manifestBuildInput(),
    ...options.manifest,
    acquisition_attempt: {
      binding_contract: LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
      attempt_id: attempt.attemptId,
      attempt_seq: attempt.attemptSeq,
      ...options.binding,
    },
  })
  return { attempt, built, sourcePages: sourcePages.map((page) => ({ ...page })) }
}

function downloadBody(payload: Buffer) {
  return {
    arrayBuffer: async () =>
      payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
  }
}

function makeDatabaseHarness(
  options: {
    commitError?: Error
    insertErrorRole?: 'source_payload' | 'population_manifest'
    rollbackError?: Error
    initialRows?: PointerRow[]
    reconcileRows?: PointerRow[]
  } = {}
) {
  const pointers: PointerRow[] = options.initialRows ? [...options.initialRows] : []
  let transactionSnapshot: PointerRow[] | null = null
  let nextId = 101
  const query = jest.fn(async (sqlInput: unknown, params: unknown[] = []) => {
    const sql = String(sqlInput)
    if (sql === 'BEGIN') {
      transactionSnapshot = pointers.map((pointer) => ({ ...pointer }))
      return { rows: [] }
    }
    if (sql.startsWith('SET LOCAL') || sql.includes('pg_advisory_xact_lock')) {
      return { rows: [] }
    }
    if (sql === 'ROLLBACK') {
      if (options.rollbackError) throw options.rollbackError
      pointers.splice(0, pointers.length, ...(transactionSnapshot ?? []))
      transactionSnapshot = null
      return { rows: [] }
    }
    if (sql === 'COMMIT') {
      if (options.commitError) throw options.commitError
      transactionSnapshot = null
      return { rows: [] }
    }
    if (sql.startsWith('SELECT id, source_id')) {
      const paths = params[0] as string[]
      const sourceRunId = params[1] as string
      return {
        rows: pointers.filter(
          (pointer) =>
            paths.includes(pointer.storage_path) ||
            (pointer.source_run_id === sourceRunId &&
              (pointer.trust_artifact_role === 'population_manifest' ||
                (pointer.trust_artifact_role === 'source_payload' &&
                  pointer.job_type === 'tier_a' &&
                  pointer.trader_id === null)))
        ),
      }
    }
    if (sql.startsWith('INSERT INTO arena.raw_objects')) {
      const role = params[9] as PointerRow['trust_artifact_role']
      if (role === options.insertErrorRole) throw new Error(`insert ${role} failed`)
      if (
        !pointers.some(
          (pointer) => pointer.source_run_id === params[8] && pointer.trust_artifact_role === role
        )
      ) {
        pointers.push({
          id: nextId++,
          source_id: params[0] as number,
          job_type: params[1] as string,
          trader_id: null,
          timeframe: params[2] as number,
          fetched_at: params[3] as string,
          storage_path: params[4] as string,
          bytes: params[5] as number,
          content_hash: params[6] as string,
          quarantined: false,
          meta: JSON.parse(params[7] as string),
          source_run_id: params[8] as string,
          trust_artifact_role: role,
        })
      }
      return { rows: [] }
    }
    if (sql.startsWith('UPDATE arena.raw_objects')) {
      const [sourceRunId, sourcePath, manifestPath, rawIds] = params as [
        string,
        string,
        string,
        number[],
      ]
      const updated: Array<{ id: number }> = []
      for (const pointer of pointers) {
        if (
          rawIds.includes(pointer.id) &&
          pointer.source_run_id === null &&
          pointer.trust_artifact_role === null
        ) {
          pointer.source_run_id = sourceRunId
          pointer.trust_artifact_role =
            pointer.storage_path === sourcePath
              ? 'source_payload'
              : pointer.storage_path === manifestPath
                ? 'population_manifest'
                : null
          updated.push({ id: pointer.id })
        }
      }
      return { rows: updated }
    }
    throw new Error(`Unexpected SQL: ${sql}`)
  })
  const release = jest.fn()
  const client = { query, release } as unknown as PoolClient

  const reconcileQuery = jest.fn(async (sqlInput: unknown, params: unknown[] = []) => {
    const sql = String(sqlInput)
    if (sql.startsWith('SELECT id, source_id')) {
      if (options.reconcileRows) return { rows: options.reconcileRows }
      const paths = params[0] as string[]
      const sourceRunId = params[1] as string
      return {
        rows: pointers.filter(
          (pointer) =>
            paths.includes(pointer.storage_path) ||
            (pointer.source_run_id === sourceRunId &&
              (pointer.trust_artifact_role === 'population_manifest' ||
                (pointer.trust_artifact_role === 'source_payload' &&
                  pointer.job_type === 'tier_a' &&
                  pointer.trader_id === null)))
        ),
      }
    }
    throw new Error(`Unexpected reconcile SQL: ${sql}`)
  })
  const reconcileRelease = jest.fn()
  const reconcileClient = {
    query: reconcileQuery,
    release: reconcileRelease,
  } as unknown as PoolClient

  return { pointers, query, release, client, reconcileQuery, reconcileRelease, reconcileClient }
}

describe('writeLeaderboardRawArtifactSet', () => {
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

  it('writes one deterministic pair and returns the same pointers on an exact retry', async () => {
    const database = makeDatabaseHarness()
    mockConnect.mockResolvedValue(database.client)
    const input = artifactInput()

    const first = await writeLeaderboardRawArtifactSet(input)
    const second = await writeLeaderboardRawArtifactSet(input)

    expect(second).toEqual(first)
    expect(database.pointers).toHaveLength(2)
    expect(first.sourcePayload.id).not.toBe(first.populationManifest.id)
    expect(first.populationManifest.contentHash).toBe(input.sourceRunId)
    expect(first.sourcePayload.storagePath).toContain(`${input.sourceRunId}/source_payload_`)
    expect(first.populationManifest.storagePath).toContain(
      `${input.sourceRunId}/population_manifest_${input.sourceRunId}.json.gz`
    )
    expect(first).not.toHaveProperty('projection')
    expect(
      database.pointers.every(
        (pointer) => !Object.hasOwn(pointer.meta as Record<string, unknown>, 'acquisition_attempt')
      )
    ).toBe(true)
    expect(database.pointers.map((pointer) => pointer.fetched_at)).toEqual([
      input.manifest.completed_at,
      input.manifest.completed_at,
    ])
    expect(
      database.pointers.find((pointer) => pointer.trust_artifact_role === 'source_payload')?.meta
    ).toMatchObject({
      pageCount: 2,
      parserPageCount: 2,
      parserSourcePageOrdinals: [1, 2],
    })
    expect(mockUpload).toHaveBeenCalledTimes(4)
    expect(mockDownload).toHaveBeenCalledTimes(2)
    const insertSql = database.query.mock.calls
      .filter(([sql]) => String(sql).startsWith('INSERT INTO arena.raw_objects'))
      .map(([sql]) => String(sql))
    expect(insertSql).toHaveLength(2)
    expect(insertSql[0]).toContain("trust_artifact_role = 'source_payload'")
    expect(insertSql[0]).toContain("job_type = 'tier_a'")
    expect(insertSql[0]).toContain('trader_id IS NULL')
    expect(insertSql[1]).toContain("trust_artifact_role = 'population_manifest'")
  })

  it('writes one attempt-bound pair with the same complete identity summary on both RAW objects', async () => {
    const database = makeDatabaseHarness()
    mockConnect.mockResolvedValue(database.client)
    const input = attemptBoundArtifactInput()

    const first = await writeAttemptBoundLeaderboardRawArtifactSet(input)
    const second = await writeAttemptBoundLeaderboardRawArtifactSet(input)

    expect(second).toEqual(first)
    expect(database.pointers).toHaveLength(2)
    expect(Object.isFrozen(first.projection)).toBe(true)
    expect(Object.isFrozen(first.projection.binding)).toBe(true)
    expect(first.populationManifest.contentHash).toBe(input.built.sourceRunId)
    expect(first.sourcePayload.storagePath).toContain(`${input.built.sourceRunId}/source_payload_`)
    expect(first.populationManifest.storagePath).toContain(
      `${input.built.sourceRunId}/population_manifest_${input.built.sourceRunId}.json.gz`
    )

    const expectedAttemptMeta = {
      binding_contract: LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
      attempt_id: attemptId,
      attempt_seq: 41,
      runner_git_sha: 'a'.repeat(40),
      capture_started_at: captureStartedAt,
      capture_completed_at: captureCompletedAt,
      capture_evidence_state: 'verified',
      termination_reason: 'reported_population_reached',
      source_page_count: 2,
      population_report_state: 'consistent',
      reported_population: 3,
      page_count_report_state: 'unknown',
      reported_page_count: null,
      observed_population: 3,
      accepted_population: 3,
      rejected_row_count: 0,
      deduplicated_row_count: 0,
      caller_limited: false,
      safety_limited: false,
      acquisition_state: 'complete',
      population_state: 'verified',
    }
    const attemptMetas = database.pointers.map(
      (pointer) => (pointer.meta as Record<string, unknown>).acquisition_attempt
    )
    expect(attemptMetas).toStrictEqual([expectedAttemptMeta, expectedAttemptMeta])
    expect(strictCanonicalJson(attemptMetas[0])).toBe(strictCanonicalJson(attemptMetas[1]))
    expect(database.pointers.map((pointer) => pointer.fetched_at)).toStrictEqual([
      captureCompletedAt,
      captureCompletedAt,
    ])

    const sourcePointer = database.pointers.find(
      (pointer) => pointer.trust_artifact_role === 'source_payload'
    )!
    const manifestPointer = database.pointers.find(
      (pointer) => pointer.trust_artifact_role === 'population_manifest'
    )!
    expect(sourcePointer.meta).toMatchObject({
      pageCount: 2,
      parserPageCount: 2,
      parserSourcePageOrdinals: [1, 2],
    })
    expect(manifestPointer.meta).toMatchObject({
      data_contract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT,
    })
    expect(mockUpload).toHaveBeenCalledTimes(4)
    expect(mockDownload).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['attempt id', { attemptId: '00000000-0000-4000-8000-000000000002' }],
    ['attempt sequence', { attemptSeq: 42 }],
  ] as const)(
    'uses different physical RAW paths when only the %s changes',
    async (_label, attemptOverride) => {
      const database = makeDatabaseHarness()
      mockConnect.mockResolvedValue(database.client)
      const firstInput = attemptBoundArtifactInput()
      const secondInput = attemptBoundArtifactInput({ attempt: attemptOverride })

      const first = await writeAttemptBoundLeaderboardRawArtifactSet(firstInput)
      const second = await writeAttemptBoundLeaderboardRawArtifactSet(secondInput)

      expect(secondInput.built.sourceRunId).not.toBe(firstInput.built.sourceRunId)
      expect(second.sourcePayload.contentHash).toBe(first.sourcePayload.contentHash)
      expect(second.sourcePayload.storagePath).not.toBe(first.sourcePayload.storagePath)
      expect(second.populationManifest.storagePath).not.toBe(first.populationManifest.storagePath)
      expect(database.pointers).toHaveLength(4)
    }
  )

  it.each([
    [
      'manifest attempt id',
      () =>
        attemptBoundArtifactInput({
          binding: { attempt_id: '00000000-0000-4000-8000-000000000002' },
        }),
    ],
    [
      'manifest attempt sequence',
      () => attemptBoundArtifactInput({ binding: { attempt_seq: 42 } }),
    ],
    [
      'capture contract',
      () =>
        attemptBoundArtifactInput({
          attempt: { captureContract: 'arena.ingest.leaderboard-acquisition-manifest@2' },
        }),
    ],
    ['runner SHA', () => attemptBoundArtifactInput({ attempt: { runnerGitSha: 'b'.repeat(40) } })],
    [
      'database start',
      () =>
        attemptBoundArtifactInput({
          attempt: { recordedStartedAt: '2026-07-21T10:00:00.001Z' },
        }),
    ],
    [
      'canonical manifest JSON',
      () => {
        const input = attemptBoundArtifactInput()
        return { ...input, built: { ...input.built, canonicalJson: 'forged' } }
      },
    ],
    [
      'source run id',
      () => {
        const input = attemptBoundArtifactInput()
        return { ...input, built: { ...input.built, sourceRunId: 'd'.repeat(64) } }
      },
    ],
  ] as const)('rejects %s drift before Storage or database I/O', async (_label, buildInput) => {
    await expect(writeAttemptBoundLeaderboardRawArtifactSet(buildInput())).rejects.toThrow(
      /attempt|bind|digest/
    )
    expect(mockUpload).not.toHaveBeenCalled()
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('rejects a forged attempt-bound source page before Storage or database I/O', async () => {
    const input = attemptBoundArtifactInput()

    await expect(
      writeAttemptBoundLeaderboardRawArtifactSet({
        ...input,
        sourcePages: [{ ...input.sourcePages[0], payload: { forged: true } }, input.sourcePages[1]],
      })
    ).rejects.toThrow('source payload page 1 does not match the manifest')
    expect(mockUpload).not.toHaveBeenCalled()
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it.each(['source_payload', 'population_manifest'] as const)(
    'rejects an exact retry when the %s pointer carries foreign attempt metadata',
    async (role) => {
      const database = makeDatabaseHarness()
      mockConnect.mockResolvedValue(database.client)
      const input = attemptBoundArtifactInput()
      await writeAttemptBoundLeaderboardRawArtifactSet(input)
      const pointer = database.pointers.find((candidate) => candidate.trust_artifact_role === role)!
      const meta = pointer.meta as Record<string, unknown>
      pointer.meta = {
        ...meta,
        acquisition_attempt: {
          ...(meta.acquisition_attempt as Record<string, unknown>),
          attempt_id: '00000000-0000-4000-8000-000000000002',
        },
      }

      await expect(writeAttemptBoundLeaderboardRawArtifactSet(input)).rejects.toThrow(
        new RegExp(`database pointer \\d+ does not match ${role}`)
      )
      expect(database.query).toHaveBeenCalledWith('ROLLBACK')
    }
  )

  it('snapshots attempt, manifest, and source pages before the first Storage await', async () => {
    const database = makeDatabaseHarness()
    mockConnect.mockResolvedValue(database.client)
    let releaseFirstUpload: (() => void) | undefined
    mockUpload.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirstUpload = () => resolve({ error: null })
        })
    )
    const input = attemptBoundArtifactInput()

    const pending = writeAttemptBoundLeaderboardRawArtifactSet(input)
    expect(releaseFirstUpload).toBeDefined()
    input.attempt.attemptId = '00000000-0000-4000-8000-000000000002'
    input.built.manifest.acquisition_attempt.attempt_id = '00000000-0000-4000-8000-000000000002'
    input.sourcePages[0].payload = { forged: true }
    releaseFirstUpload!()

    const receipt = await pending
    expect(receipt.projection.binding.attemptId).toBe(attemptId)
    const persistedSourcePages = JSON.parse(
      gunzipSync(mockUpload.mock.calls[0][1] as Buffer).toString('utf8')
    ) as RawPage[]
    const persistedManifest = JSON.parse(
      gunzipSync(mockUpload.mock.calls[1][1] as Buffer).toString('utf8')
    ) as { acquisition_attempt: { attempt_id: string } }
    expect(persistedSourcePages[0].payload).toStrictEqual({
      data: [{ id: 'one' }, { id: 'two' }],
      total: 3,
    })
    expect(persistedManifest.acquisition_attempt.attempt_id).toBe(attemptId)
    expect(
      database.pointers.map(
        (pointer) =>
          ((pointer.meta as Record<string, unknown>).acquisition_attempt as Record<string, unknown>)
            .attempt_id
      )
    ).toStrictEqual([attemptId, attemptId])
  })

  it('uses the verified existing gzip length after a first-attempt 409', async () => {
    const database = makeDatabaseHarness()
    mockConnect.mockResolvedValue(database.client)
    mockUpload.mockResolvedValue({ error: { message: 'duplicate', statusCode: 409 } })
    const input = artifactInput()
    const sourceJson = Buffer.from(strictCanonicalJson(input.sourcePages), 'utf8')
    const manifestJson = Buffer.from(strictCanonicalJson(input.manifest), 'utf8')
    const sourceGzip = gzipSync(sourceJson, { level: 1 })
    const manifestGzip = gzipSync(manifestJson, { level: 1 })
    mockDownload
      .mockResolvedValueOnce({ data: downloadBody(sourceGzip), error: null })
      .mockResolvedValueOnce({ data: downloadBody(manifestGzip), error: null })

    await writeLeaderboardRawArtifactSet(input)

    expect(database.pointers.map((pointer) => pointer.bytes)).toEqual([
      sourceGzip.byteLength,
      manifestGzip.byteLength,
    ])
    expect(
      database.pointers.map(
        (pointer) =>
          (pointer.meta as { raw_integrity: { compressed_bytes: number } }).raw_integrity
            .compressed_bytes
      )
    ).toEqual([sourceGzip.byteLength, manifestGzip.byteLength])
  })

  it('rejects a 409 collision whose stored JSON bytes differ', async () => {
    mockUpload.mockResolvedValueOnce({ error: { message: 'duplicate', statusCode: 409 } })
    mockDownload.mockResolvedValueOnce({
      data: downloadBody(gzipSync(Buffer.from('{"different":true}', 'utf8'))),
      error: null,
    })

    await expect(writeLeaderboardRawArtifactSet(artifactInput())).rejects.toThrow(
      'has different content'
    )
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('does not open a database transaction when the second upload fails', async () => {
    mockUpload
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { message: 'bucket unavailable', statusCode: 400 } })

    await expect(writeLeaderboardRawArtifactSet(artifactInput())).rejects.toThrow(
      'bucket unavailable'
    )
    expect(mockConnect).not.toHaveBeenCalled()
    expect(mockDownload).not.toHaveBeenCalled()
  })

  it('rolls back instead of repairing a partial database pointer pair', async () => {
    const database = makeDatabaseHarness({
      initialRows: [
        {
          id: 99,
          source_id: 1,
          job_type: 'tier_a',
          trader_id: null,
          timeframe: 30,
          fetched_at: artifactInput().manifest.completed_at,
          storage_path: 'foreign',
          bytes: 1,
          content_hash: 'f'.repeat(64),
          quarantined: false,
          meta: {},
          source_run_id: artifactInput().sourceRunId,
          trust_artifact_role: 'source_payload',
        },
      ],
    })
    mockConnect.mockResolvedValue(database.client)

    await expect(writeLeaderboardRawArtifactSet(artifactInput())).rejects.toThrow(
      'only part of the expected RAW pointer pair'
    )
    expect(database.query).toHaveBeenCalledWith('ROLLBACK')
    expect(database.query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT'))).toBe(false)
  })

  it('rolls back the first pointer when the second database insert fails', async () => {
    const database = makeDatabaseHarness({ insertErrorRole: 'population_manifest' })
    mockConnect.mockResolvedValue(database.client)

    await expect(writeLeaderboardRawArtifactSet(artifactInput())).rejects.toThrow(
      'insert population_manifest failed'
    )

    expect(database.query).toHaveBeenCalledWith('ROLLBACK')
    expect(database.pointers).toHaveLength(0)
    expect(storage).toHaveProperty('size', 2)
  })

  it('atomically binds an exact pair of pre-existing unbound pointers', async () => {
    const database = makeDatabaseHarness()
    mockConnect.mockResolvedValue(database.client)
    const input = artifactInput()
    const first = await writeLeaderboardRawArtifactSet(input)
    for (const pointer of database.pointers) {
      pointer.source_run_id = null
      pointer.trust_artifact_role = null
    }

    const second = await writeLeaderboardRawArtifactSet(input)

    expect(second).toEqual(first)
    expect(database.pointers.every((pointer) => pointer.source_run_id === input.sourceRunId)).toBe(
      true
    )
    expect(
      database.query.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE arena.raw_objects'))
    ).toBe(true)
  })

  it('rejects a mixed bound and unbound pointer pair without repairing either row', async () => {
    const database = makeDatabaseHarness()
    mockConnect.mockResolvedValue(database.client)
    const input = artifactInput()
    await writeLeaderboardRawArtifactSet(input)
    database.pointers[0].source_run_id = null
    database.pointers[0].trust_artifact_role = null
    const updateCountBeforeRetry = database.query.mock.calls.filter(([sql]) =>
      String(sql).startsWith('UPDATE arena.raw_objects')
    ).length

    await expect(writeLeaderboardRawArtifactSet(input)).rejects.toThrow(
      'database pointers are only partially bound'
    )

    expect(
      database.query.mock.calls.filter(([sql]) =>
        String(sql).startsWith('UPDATE arena.raw_objects')
      )
    ).toHaveLength(updateCountBeforeRetry)
    expect(database.query).toHaveBeenCalledWith('ROLLBACK')
    expect(database.pointers[0].source_run_id).toBeNull()
    expect(database.pointers[1].source_run_id).toBe(input.sourceRunId)
  })

  it('preserves both the transaction and ROLLBACK failures and destroys the connection', async () => {
    const rollbackError = new Error('connection lost during ROLLBACK')
    const database = makeDatabaseHarness({
      insertErrorRole: 'population_manifest',
      rollbackError,
    })
    mockConnect.mockResolvedValue(database.client)

    let failure: unknown
    try {
      await writeLeaderboardRawArtifactSet(artifactInput())
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors[0].message).toBe('insert population_manifest failed')
    expect((failure as AggregateError).errors[1]).toBe(rollbackError)
    expect(database.release).toHaveBeenCalledWith(true)
  })

  it('reconciles an exact pair after an uncertain COMMIT without deleting Storage', async () => {
    const commitError = new Error('connection lost during COMMIT')
    const database = makeDatabaseHarness({ commitError })
    mockConnect
      .mockResolvedValueOnce(database.client)
      .mockResolvedValueOnce(database.reconcileClient)

    await expect(writeLeaderboardRawArtifactSet(artifactInput())).resolves.toEqual({
      sourcePayload: expect.objectContaining({ id: 101 }),
      populationManifest: expect.objectContaining({ id: 102 }),
    })

    expect(database.release).toHaveBeenCalledWith(true)
    expect(database.reconcileQuery).toHaveBeenCalledTimes(1)
    expect(database.reconcileRelease).toHaveBeenCalledTimes(1)
  })

  it('keeps both COMMIT and reconciliation failures in the final error', async () => {
    const commitError = new Error('connection lost during COMMIT')
    const database = makeDatabaseHarness({ commitError, reconcileRows: [] })
    mockConnect
      .mockResolvedValueOnce(database.client)
      .mockResolvedValueOnce(database.reconcileClient)

    let failure: unknown
    try {
      await writeLeaderboardRawArtifactSet(artifactInput())
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors[0]).toBe(commitError)
    expect((failure as AggregateError).errors[1].message).toContain('expected 2 database pointers')
    expect(database.release).toHaveBeenCalledWith(true)
    expect(database.reconcileRelease).toHaveBeenCalledTimes(1)
  })

  it('rejects a source payload that does not match its canonical manifest before I/O', async () => {
    const input = artifactInput()

    await expect(
      writeLeaderboardRawArtifactSet({
        ...input,
        sourcePages: [{ ...input.sourcePages[0], payload: { forged: true } }, input.sourcePages[1]],
      })
    ).rejects.toThrow('source payload page 1 does not match the manifest')

    expect(mockUpload).not.toHaveBeenCalled()
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('rejects extra source-page fields and a forged parser digest before I/O', async () => {
    const input = artifactInput()
    const pageWithExtraField = {
      ...input.sourcePages[0],
      unboundEvidence: true,
    } as RawPage

    await expect(
      writeLeaderboardRawArtifactSet({
        ...input,
        sourcePages: [pageWithExtraField, input.sourcePages[1]],
      })
    ).rejects.toThrow('source payload page 1 does not match the manifest')

    const forgedManifest: typeof input.manifest = {
      ...input.manifest,
      parser_input: {
        ...input.manifest.parser_input,
        sha256: 'f'.repeat(64),
      },
    }
    await expect(
      writeLeaderboardRawArtifactSet({
        ...input,
        manifest: forgedManifest,
        sourceRunId: strictCanonicalSha256(forgedManifest),
      })
    ).rejects.toThrow('parser input digest does not match the persisted source pages')

    expect(mockUpload).not.toHaveBeenCalled()
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('fails closed on dedupe/rechunk evidence until its parser payload is persisted', async () => {
    const input = artifactInput()
    const dedupeManifest: typeof input.manifest = {
      ...input.manifest,
      parser_input: {
        ...input.manifest.parser_input,
        transformation: {
          kind: 'dedupe_rechunk',
          source_page_ordinals: [1, 2],
          algorithm_contract: 'arena.test.dedupe-rechunk@1',
          output_row_count: 3,
          output_page_size: 2,
        },
      },
    }

    await expect(
      writeLeaderboardRawArtifactSet({
        ...input,
        manifest: dedupeManifest,
        sourceRunId: strictCanonicalSha256(dedupeManifest),
      })
    ).rejects.toThrow(
      'dedupe/rechunk parser evidence requires a separately persisted parser payload'
    )

    expect(mockUpload).not.toHaveBeenCalled()
    expect(mockConnect).not.toHaveBeenCalled()
  })
})
