import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'

const mockUpload = jest.fn()
const mockDownload = jest.fn()
const mockQuery = jest.fn()

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    storage: {
      from: jest.fn(() => ({ upload: mockUpload, download: mockDownload })),
    },
  })),
}))

jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: jest.fn(() => ({ query: mockQuery })),
}))

import { readRawObject, writeRawObject } from '@/lib/ingest/raw'

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

    await expect(result).resolves.toBe(42)
    expect(mockUpload).toHaveBeenCalledTimes(2)
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('treats an already-exists response after a timeout as an idempotent success', async () => {
    mockUpload
      .mockResolvedValueOnce({ error: { message: 'Gateway timeout', statusCode: 504 } })
      .mockResolvedValueOnce({ error: { message: 'The resource already exists', statusCode: 409 } })

    const result = writeRawObject(input)
    await jest.advanceTimersByTimeAsync(750)

    await expect(result).resolves.toBe(42)
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
    ).resolves.toBe(42)

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
        compressed_bytes: compressedPayload.byteLength,
        uncompressed_bytes: Buffer.byteLength(expectedJson, 'utf8'),
      },
    })
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
