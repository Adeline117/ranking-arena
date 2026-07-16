import { gunzipSync } from 'node:zlib'

const mockUpload = jest.fn()
const mockQuery = jest.fn()

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    storage: {
      from: jest.fn(() => ({ upload: mockUpload })),
    },
  })),
}))

jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: jest.fn(() => ({ query: mockQuery })),
}))

import { writeRawObject } from '@/lib/ingest/raw'

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
