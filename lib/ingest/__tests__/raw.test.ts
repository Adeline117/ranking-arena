import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'

const mockUpload = jest.fn()
const mockDownload = jest.fn()
const mockRemove = jest.fn()
const mockQuery = jest.fn()
const mockClientQuery = jest.fn()
const mockClientRelease = jest.fn()

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    storage: {
      from: jest.fn(() => ({ upload: mockUpload, download: mockDownload, remove: mockRemove })),
    },
  })),
}))

jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: jest.fn(() => ({ query: mockQuery })),
  ingestClientConnect: jest.fn(async () => ({
    query: mockClientQuery,
    release: mockClientRelease,
  })),
}))

import {
  RAW_JSON_STRINGIFY_CONTRACT,
  cleanupRawObjects,
  readRawObject,
  writeRawObject,
} from '@/lib/ingest/raw'
import { STRICT_CANONICAL_JSON_CONTRACT } from '@/lib/ingest/strict-canonical-json'

const input = {
  sourceId: 7,
  sourceSlug: 'test_source',
  jobType: 'tier_b',
  traderId: 11,
  timeframe: 30,
  payload: { roi: 12.5 },
}

describe('writeRawObject storage retries', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
  })

  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    mockQuery.mockResolvedValue({ rows: [{ id: 42 }] })
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('retries a transient Storage timeout before publishing the pointer row', async () => {
    mockUpload
      .mockResolvedValueOnce({
        error: { message: 'The connection to the database timed out', statusCode: '500' },
      })
      .mockResolvedValueOnce({ error: null })

    const result = writeRawObject(input)
    await jest.advanceTimersByTimeAsync(750)

    await expect(result).resolves.toEqual({
      id: 42,
      storagePath: expect.stringMatching(/\.json\.gz$/),
      contentHash: 'f2d0bb204039f952e467902406c9f5d82f6a1567c329df3be83af227a4fb76f0',
    })
    expect(mockUpload).toHaveBeenCalledTimes(2)
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('treats an already-exists response after a timeout as an idempotent success', async () => {
    mockUpload
      .mockResolvedValueOnce({ error: { message: 'Gateway timeout', statusCode: 504 } })
      .mockResolvedValueOnce({ error: { message: 'The resource already exists', statusCode: 409 } })

    const result = writeRawObject(input)
    await jest.advanceTimersByTimeAsync(750)

    await expect(result).resolves.toEqual({
      id: 42,
      storagePath: expect.stringMatching(/\.json\.gz$/),
      contentHash: 'f2d0bb204039f952e467902406c9f5d82f6a1567c329df3be83af227a4fb76f0',
    })
    expect(mockUpload).toHaveBeenCalledTimes(2)
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('fails immediately for a permanent Storage rejection', async () => {
    mockUpload.mockResolvedValueOnce({
      error: { message: 'Invalid bucket', statusCode: 400 },
    })

    await expect(writeRawObject(input)).rejects.toThrow('Invalid bucket')
    expect(mockUpload).toHaveBeenCalledTimes(1)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('publishes a full SHA-256 checksum and computed integrity metadata', async () => {
    mockUpload.mockResolvedValueOnce({ error: null })
    const expectedJson = '{"roi":12.5}'
    const expectedHash = 'f2d0bb204039f952e467902406c9f5d82f6a1567c329df3be83af227a4fb76f0'

    await expect(
      writeRawObject({
        ...input,
        meta: {
          surface: 'board',
          pageCount: 2,
          raw_integrity: { version: 999, compressed_bytes: -1 },
        },
      })
    ).resolves.toEqual({
      id: 42,
      storagePath: expect.stringMatching(new RegExp(`_${expectedHash}\\.json\\.gz$`)),
      contentHash: expectedHash,
    })

    const [storagePath, compressedPayload, uploadOptions] = mockUpload.mock.calls[0]
    expect(storagePath).toMatch(new RegExp(`_${expectedHash}\\.json\\.gz$`))
    expect(uploadOptions).toEqual({ contentType: 'application/gzip', upsert: false })
    expect(gunzipSync(compressedPayload).toString('utf8')).toBe(expectedJson)

    const queryArgs = mockQuery.mock.calls[0][1]
    expect(queryArgs[4]).toBe(storagePath)
    expect(queryArgs[5]).toBe(compressedPayload.byteLength)
    expect(queryArgs[6]).toBe(expectedHash)
    expect(JSON.parse(queryArgs[7])).toEqual({
      surface: 'board',
      pageCount: 2,
      raw_integrity: {
        version: 1,
        content_type: 'application/json',
        encoding: 'utf-8',
        compression: 'gzip',
        hash_algorithm: 'sha256',
        hash_scope: 'json_utf8',
        serialization_contract: RAW_JSON_STRINGIFY_CONTRACT,
        compressed_bytes: compressedPayload.byteLength,
        uncompressed_bytes: Buffer.byteLength(expectedJson, 'utf8'),
      },
    })
  })

  it('hashes and uploads the exact strict canonical UTF-8 bytes', async () => {
    mockUpload.mockResolvedValueOnce({ error: null })
    const payload = { a: 1, Z: 2 }
    const expectedJson = '{"Z":2,"a":1}'
    const expectedHash = fullHash(Buffer.from(expectedJson, 'utf8'))

    await expect(
      writeRawObject({
        ...input,
        payload,
        serialization: STRICT_CANONICAL_JSON_CONTRACT,
      })
    ).resolves.toEqual({
      id: 42,
      storagePath: expect.stringMatching(new RegExp(`_${expectedHash}\\.json\\.gz$`)),
      contentHash: expectedHash,
    })

    const [, compressedPayload] = mockUpload.mock.calls[0]
    expect(gunzipSync(compressedPayload).toString('utf8')).toBe(expectedJson)
    const queryMeta = JSON.parse(mockQuery.mock.calls[0][1][7])
    expect(queryMeta.raw_integrity.serialization_contract).toBe(STRICT_CANONICAL_JSON_CONTRACT)
  })

  it.each([
    ['undefined', { value: undefined }],
    ['negative zero', { value: -0 }],
    ['date', { value: new Date(0) }],
  ])('rejects strict canonical %s before Storage or DB writes', async (_label, payload) => {
    await expect(
      writeRawObject({
        ...input,
        payload,
        serialization: STRICT_CANONICAL_JSON_CONTRACT,
      })
    ).rejects.toThrow('strict canonical JSON rejects')

    expect(mockUpload).not.toHaveBeenCalled()
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it.each([
    ['unknown', 'arena.unknown-json@1'],
    ['null', null],
  ])('rejects %s runtime serialization contract before Storage', async (_label, contract) => {
    await expect(
      writeRawObject({
        ...input,
        serialization: contract as never,
      })
    ).rejects.toThrow('unsupported RAW serialization contract')
    expect(mockUpload).not.toHaveBeenCalled()
  })
})

function asDownloadBody(payload: Buffer) {
  return {
    arrayBuffer: async () =>
      payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
  }
}

function fullHash(payload: Buffer): string {
  return createHash('sha256').update(payload).digest('hex')
}

function integrityMetadata(jsonBytes: Buffer, gz: Buffer, overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    content_type: 'application/json',
    encoding: 'utf-8',
    compression: 'gzip',
    hash_algorithm: 'sha256',
    hash_scope: 'json_utf8',
    compressed_bytes: gz.byteLength,
    uncompressed_bytes: jsonBytes.byteLength,
    ...overrides,
  }
}

function mockRawPointer({
  json = '{"roi":12.5}',
  contentHash,
  bytes,
  meta = {},
  compressed,
}: {
  json?: string
  contentHash?: string
  bytes?: number
  meta?: unknown
  compressed?: Buffer
} = {}) {
  const jsonBytes = Buffer.from(json, 'utf8')
  const gz = compressed ?? gzipSync(jsonBytes)
  mockQuery.mockResolvedValueOnce({
    rows: [
      {
        storage_path: 'test_source/tier_b/raw.json.gz',
        bytes: bytes ?? gz.byteLength,
        content_hash: contentHash ?? fullHash(jsonBytes),
        meta,
      },
    ],
  })
  mockDownload.mockResolvedValueOnce({ data: asDownloadBody(gz), error: null })
  return { gz, jsonBytes }
}

describe('readRawObject integrity verification', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('accepts a fully verified 64-character SHA-256 payload', async () => {
    const json = '{"roi":12.5}'
    const jsonBytes = Buffer.from(json, 'utf8')
    const gz = gzipSync(jsonBytes)
    mockRawPointer({
      json,
      compressed: gz,
      meta: {
        surface: 'board',
        raw_integrity: integrityMetadata(jsonBytes, gz),
      },
    })

    await expect(readRawObject(42)).resolves.toEqual({ roi: 12.5 })
  })

  it('accepts exact strict canonical bytes and rejects reordered equivalents', async () => {
    const canonicalJson = '{"Z":2,"a":1}'
    const canonicalBytes = Buffer.from(canonicalJson, 'utf8')
    const canonicalGz = gzipSync(canonicalBytes)
    mockRawPointer({
      json: canonicalJson,
      compressed: canonicalGz,
      meta: {
        raw_integrity: integrityMetadata(canonicalBytes, canonicalGz, {
          serialization_contract: STRICT_CANONICAL_JSON_CONTRACT,
        }),
      },
    })
    await expect(readRawObject(42)).resolves.toEqual({ Z: 2, a: 1 })

    const reorderedJson = '{"a":1,"Z":2}'
    const reorderedBytes = Buffer.from(reorderedJson, 'utf8')
    const reorderedGz = gzipSync(reorderedBytes)
    mockRawPointer({
      json: reorderedJson,
      compressed: reorderedGz,
      meta: {
        raw_integrity: integrityMetadata(reorderedBytes, reorderedGz, {
          serialization_contract: STRICT_CANONICAL_JSON_CONTRACT,
        }),
      },
    })
    await expect(readRawObject(42)).rejects.toThrow('strict canonical serialization mismatch')
  })

  it('rejects an unknown stored serialization contract', async () => {
    const json = '{"roi":12.5}'
    const jsonBytes = Buffer.from(json, 'utf8')
    const gz = gzipSync(jsonBytes)
    mockRawPointer({
      json,
      compressed: gz,
      meta: {
        raw_integrity: integrityMetadata(jsonBytes, gz, {
          serialization_contract: 'arena.unknown-json@1',
        }),
      },
    })

    await expect(readRawObject(42)).rejects.toThrow('raw_integrity.serialization_contract mismatch')
  })

  it('accepts the historical 32-character SHA-256 prefix', async () => {
    const jsonBytes = Buffer.from('{"roi":12.5}', 'utf8')
    mockRawPointer({ contentHash: fullHash(jsonBytes).slice(0, 32) })

    await expect(readRawObject(42)).resolves.toEqual({ roi: 12.5 })
  })

  it('rejects a compressed byte-count mismatch before decompression', async () => {
    const { gz } = mockRawPointer({ bytes: 1 })

    await expect(readRawObject(42)).rejects.toThrow(
      `compressed byte count mismatch (expected 1, received ${gz.byteLength})`
    )
  })

  it('rejects a non-gzip object even when its stored size matches', async () => {
    mockRawPointer({ compressed: Buffer.from('not gzip') })

    await expect(readRawObject(42)).rejects.toThrow('invalid gzip header')
  })

  it('rejects a corrupted gzip trailer', async () => {
    const gz = gzipSync(Buffer.from('{"roi":12.5}', 'utf8'))
    gz[gz.length - 1] ^= 0xff
    mockRawPointer({ compressed: gz })

    await expect(readRawObject(42)).rejects.toThrow('gzip payload or trailer is corrupt')
  })

  it('rejects integrity metadata with a wrong uncompressed size', async () => {
    const json = '{"roi":12.5}'
    const jsonBytes = Buffer.from(json, 'utf8')
    const gz = gzipSync(jsonBytes)
    mockRawPointer({
      json,
      compressed: gz,
      meta: {
        raw_integrity: integrityMetadata(jsonBytes, gz, { uncompressed_bytes: 99 }),
      },
    })

    await expect(readRawObject(42)).rejects.toThrow('raw_integrity.uncompressed_bytes mismatch')
  })

  it.each([
    ['full SHA-256', '0'.repeat(64)],
    ['legacy SHA-256 prefix', '0'.repeat(32)],
  ])('rejects a mismatched %s', async (_label, contentHash) => {
    mockRawPointer({ contentHash })

    await expect(readRawObject(42)).rejects.toThrow('SHA-256 checksum mismatch')
  })

  it.each(['abc', 'A'.repeat(64), '0'.repeat(48), 'g'.repeat(64)])(
    'rejects malformed stored checksum %s',
    async (contentHash) => {
      mockRawPointer({ contentHash })

      await expect(readRawObject(42)).rejects.toThrow('stored SHA-256 format is invalid')
    }
  )

  it('does not parse JSON until every integrity check passes', async () => {
    const json = 'not-json'
    const jsonBytes = Buffer.from(json, 'utf8')
    mockRawPointer({ json, contentHash: fullHash(jsonBytes) })

    await expect(readRawObject(42)).rejects.toThrow('payload is not valid JSON')
  })

  it('rejects non-UTF-8 bytes after their checksum is verified', async () => {
    const invalidUtf8 = Buffer.from([0xff, 0xfe, 0xfd])
    mockRawPointer({
      compressed: gzipSync(invalidUtf8),
      contentHash: fullHash(invalidUtf8),
    })

    await expect(readRawObject(42)).rejects.toThrow('payload is not valid UTF-8')
  })
})

describe('cleanupRawObjects fail-closed garbage collection', () => {
  function useRawGcQueryPlan({
    acquired = true,
    pending = [],
    afterRetire = [],
    retireError,
    acknowledgementError,
    unlockError,
  }: {
    acquired?: boolean
    pending?: string[]
    afterRetire?: string[]
    retireError?: Error
    acknowledgementError?: Error
    unlockError?: Error
  } = {}) {
    let queueReads = 0
    mockClientQuery.mockImplementation(async (sqlInput: unknown) => {
      const sql = String(sqlInput)
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired }] }
      if (sql.includes('pg_advisory_unlock')) {
        if (unlockError) throw unlockError
        return { rows: [{ unlocked: true }] }
      }
      if (sql.includes('SELECT storage_path')) {
        const paths = queueReads++ === 0 ? pending : afterRetire
        return { rows: paths.map((storage_path) => ({ storage_path })) }
      }
      if (sql.includes('WITH candidates AS MATERIALIZED')) {
        if (retireError) throw retireError
        return { rows: [], rowCount: afterRetire.length }
      }
      if (sql.includes('UPDATE arena.raw_object_gc_queue')) {
        return { rows: [], rowCount: pending.length }
      }
      if (sql.includes('DELETE FROM arena.raw_object_gc_queue')) {
        if (acknowledgementError) throw acknowledgementError
        return { rows: [], rowCount: pending.length || afterRetire.length }
      }
      throw new Error(`Unexpected RAW GC SQL: ${sql}`)
    })
  }

  function rawGcQueryIndex(fragment: string): number {
    return mockClientQuery.mock.calls.findIndex(([sql]) => String(sql).includes(fragment))
  }

  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockClientQuery.mockReset()
    mockClientRelease.mockReset()
    mockRemove.mockReset()
    useRawGcQueryPlan()
  })

  it('atomically queues and deletes DB evidence before removing its Storage object', async () => {
    useRawGcQueryPlan({ afterRetire: ['raw/older.json.gz', 'raw/newer.json.gz'] })
    mockRemove.mockResolvedValueOnce({ error: null })

    await expect(cleanupRawObjects(30)).resolves.toBe(2)

    const retireIndex = rawGcQueryIndex('WITH candidates AS MATERIALIZED')
    const retireSql = String(mockClientQuery.mock.calls[retireIndex][0])
    expect(retireSql).toContain('INSERT INTO arena.raw_object_gc_queue')
    expect(retireSql).toContain('DELETE FROM arena.raw_objects AS raw')
    expect(retireSql).toContain('FOR UPDATE SKIP LOCKED')
    expect(retireSql).toContain('ORDER BY fetched_at, id')
    expect(retireSql).toContain('LIMIT 500')
    expect(mockClientQuery.mock.calls[retireIndex][1]).toEqual([30])
    expect(mockClientQuery.mock.invocationCallOrder[retireIndex]).toBeLessThan(
      mockRemove.mock.invocationCallOrder[0]
    )
    expect(mockRemove).toHaveBeenCalledWith(['raw/older.json.gz', 'raw/newer.json.gz'])
    expect(rawGcQueryIndex('DELETE FROM arena.raw_object_gc_queue')).toBeGreaterThan(retireIndex)
    expect(rawGcQueryIndex('pg_advisory_unlock')).toBeGreaterThan(retireIndex)
    expect(mockClientRelease).toHaveBeenCalledTimes(1)
  })

  it('drains a prior durable queue before retiring more DB evidence', async () => {
    useRawGcQueryPlan({ pending: ['raw/retry.json.gz'] })
    mockRemove.mockResolvedValueOnce({ error: null })

    await expect(cleanupRawObjects()).resolves.toBe(1)

    expect(mockClientQuery).toHaveBeenCalledTimes(4)
    expect(rawGcQueryIndex('SELECT storage_path')).toBeGreaterThanOrEqual(0)
    expect(rawGcQueryIndex('DELETE FROM arena.raw_object_gc_queue')).toBeGreaterThanOrEqual(0)
    expect(
      mockClientQuery.mock.calls.some(([sql]) =>
        String(sql).includes('DELETE FROM arena.raw_objects')
      )
    ).toBe(false)
    expect(mockClientRelease).toHaveBeenCalledTimes(1)
  })

  it('does not touch Storage when durable queueing or DB deletion fails', async () => {
    useRawGcQueryPlan({ retireError: new Error('database transaction failed') })

    await expect(cleanupRawObjects()).rejects.toThrow('database transaction failed')
    expect(mockRemove).not.toHaveBeenCalled()
    expect(rawGcQueryIndex('pg_advisory_unlock')).toBeGreaterThanOrEqual(0)
    expect(mockClientRelease).toHaveBeenCalledTimes(1)
  })

  it('retains and annotates the durable queue when Storage deletion fails', async () => {
    useRawGcQueryPlan({ pending: ['raw/retry.json.gz'] })
    mockRemove.mockResolvedValueOnce({ error: { message: 'Storage unavailable' } })

    await expect(cleanupRawObjects()).rejects.toThrow(
      'RAW cleanup remove failed; durable queue retained: Storage unavailable'
    )

    const updateIndex = rawGcQueryIndex('attempts = attempts + 1')
    expect(updateIndex).toBeGreaterThanOrEqual(0)
    expect(mockClientQuery.mock.calls[updateIndex][1]).toEqual([
      ['raw/retry.json.gz'],
      'Storage unavailable',
    ])
    expect(
      mockClientQuery.mock.calls.some(([sql]) =>
        String(sql).includes('DELETE FROM arena.raw_object_gc_queue')
      )
    ).toBe(false)
    expect(mockClientRelease).toHaveBeenCalledTimes(1)
  })

  it('keeps the durable queue when Storage succeeds but acknowledgement fails', async () => {
    useRawGcQueryPlan({
      pending: ['raw/retry.json.gz'],
      acknowledgementError: new Error('acknowledgement failed'),
    })
    mockRemove.mockResolvedValueOnce({ error: null })

    await expect(cleanupRawObjects()).rejects.toThrow('acknowledgement failed')
    expect(mockRemove).toHaveBeenCalledTimes(1)
    expect(mockClientRelease).toHaveBeenCalledTimes(1)
  })

  it('returns zero without calling Storage when there is no pending or expired RAW', async () => {
    await expect(cleanupRawObjects()).resolves.toBe(0)
    expect(mockRemove).not.toHaveBeenCalled()
    expect(mockClientRelease).toHaveBeenCalledTimes(1)
  })

  it('does not claim or remove outbox work while another node holds the GC lock', async () => {
    useRawGcQueryPlan({ acquired: false })

    await expect(cleanupRawObjects()).resolves.toBe(0)

    expect(mockClientQuery).toHaveBeenCalledTimes(1)
    expect(String(mockClientQuery.mock.calls[0][0])).toContain('pg_try_advisory_lock')
    expect(mockRemove).not.toHaveBeenCalled()
    expect(mockClientRelease).toHaveBeenCalledTimes(1)
  })

  it('destroys a pooled session when explicit advisory unlock fails', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    useRawGcQueryPlan({
      pending: ['raw/retry.json.gz'],
      unlockError: new Error('unlock query cancelled'),
    })
    mockRemove.mockResolvedValueOnce({ error: null })

    try {
      await expect(cleanupRawObjects()).resolves.toBe(1)
    } finally {
      errorSpy.mockRestore()
    }

    expect(mockClientRelease).toHaveBeenCalledWith(true)
  })
})
