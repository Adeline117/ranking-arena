/**
 * /api/upload route tests
 *
 * Tests authentication, rate limiting, file validation,
 * magic-byte sniffing, and Supabase storage upload for the upload API.
 */

// --- Mocks (must be before imports) ---

jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers: Map<string, string>
    constructor(body?: unknown, init: { status?: number } = {}) {
      this._body = body
      this.status = init.status || 200
      this.headers = new Map()
    }
    async json() { return this._body }
    static json(data: unknown, init?: { status?: number }) {
      return new MockNextResponse(data, init)
    }
  }

  class MockNextRequest {
    url: string
    nextUrl: URL
    headers: Map<string, string>
    method: string
    _body: unknown
    constructor(url: string, opts?: { headers?: Record<string, string>; method?: string; body?: unknown }) {
      this.url = url
      this.nextUrl = new URL(url)
      this.headers = new Map(Object.entries({ 'user-agent': 'Mozilla/5.0 (Jest Test Runner)', ...opts?.headers }))
      this.method = opts?.method || 'POST'
      this._body = opts?.body
    }
    async json() { return this._body }
    async formData() { return this._body }
  }

  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  checkRateLimitFull: jest.fn().mockResolvedValue({ response: null, meta: null }),
  addRateLimitHeaders: jest.fn(),
  RateLimitPresets: { read: {}, write: {}, public: {}, sensitive: {}, authenticated: {} },
}))

const mockGetAuthUser = jest.fn()
const mockUpload = jest.fn()
const mockGetPublicUrl = jest.fn()

const mockStorageFrom = jest.fn(() => ({
  upload: mockUpload,
  getPublicUrl: mockGetPublicUrl,
}))

const mockSupabase = {
  from: jest.fn(),
  storage: { from: mockStorageFrom },
}

jest.mock('@/lib/api/middleware', () => ({
  withAuth: (handler: Function, _opts?: unknown) => async (req: unknown) => {
    const user = await mockGetAuthUser(req)
    if (!user) {
      const { NextResponse: NR } = require('next/server') // eslint-disable-line @typescript-eslint/no-require-imports
      return NR.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }
    return handler({ user, supabase: mockSupabase, request: req, version: { current: 'v1' } })
  },
  withPublic: (handler: Function) => handler,
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => mockSupabase),
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
}))

const mockSniffImageFile = jest.fn()
jest.mock('@/lib/utils/image-magic-bytes', () => ({
  sniffImageFile: (...args: unknown[]) => mockSniffImageFile(...args),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })),
  fireAndForget: jest.fn(),
}))

jest.mock('@/lib/api/versioning', () => ({
  parseApiVersion: jest.fn().mockReturnValue({ version: 'v1', deprecated: false }),
  addVersionHeaders: jest.fn(),
  addDeprecationHeaders: jest.fn(),
}))

jest.mock('@/lib/api/correlation', () => ({
  getOrCreateCorrelationId: jest.fn().mockReturnValue('test-cid'),
  runWithCorrelationId: jest.fn((_id: string, fn: () => unknown) => fn()),
}))

jest.mock('@/lib/utils/csrf', () => ({
  validateCsrfToken: jest.fn().mockReturnValue(true),
  CSRF_COOKIE_NAME: 'csrf',
  CSRF_HEADER_NAME: 'x-csrf-token',
}))

import { NextRequest } from 'next/server'
import { POST } from '../route'

// Helper: create a mock File-like object with arrayBuffer support
function createMockFile(
  content: Uint8Array,
  name: string,
  type: string,
  size?: number
) {
  return {
    name,
    type,
    size: size ?? content.byteLength,
    arrayBuffer: jest.fn().mockResolvedValue(content.buffer),
    slice: jest.fn(),
  }
}

// Helper: create a mock FormData with a file
function createMockFormData(file: ReturnType<typeof createMockFile> | null, bucket?: string) {
  const map = new Map<string, unknown>()
  if (file) map.set('file', file)
  if (bucket) map.set('bucket', bucket)
  return {
    get: (key: string) => map.get(key) ?? null,
  }
}

describe('POST /api/upload', () => {
  const mockUser = { id: 'user-123', email: 'test@test.com' }

  // JPEG magic bytes: FF D8 FF E0
  const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  const jpegSniffResult = { kind: 'jpeg', mime: 'image/jpeg', extension: 'jpg' }

  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue(mockUser)
    mockSniffImageFile.mockResolvedValue(jpegSniffResult)
    mockUpload.mockResolvedValue({ error: null })
    mockGetPublicUrl.mockReturnValue({ data: { publicUrl: 'https://storage.test/reports/user-123/abc123.jpg' } })
  })

  // --- Authentication ---

  it('returns 401 when not authenticated', async () => {
    mockGetAuthUser.mockResolvedValue(null)

    const file = createMockFile(jpegBytes, 'test.jpg', 'image/jpeg')
    const formData = createMockFormData(file)

    const req = new NextRequest('http://localhost/api/upload', {
      method: 'POST',
      body: formData as unknown,
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.error).toBeDefined()
  })

  // --- Input Validation ---

  it('returns 400 when no file is provided', async () => {
    const formData = createMockFormData(null)

    const req = new NextRequest('http://localhost/api/upload', {
      method: 'POST',
      body: formData as unknown,
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error?.message ?? body.error).toMatch(/No file/i)
  })

  it('returns 400 when file exceeds 2MB', async () => {
    const file = createMockFile(jpegBytes, 'big.jpg', 'image/jpeg', 3 * 1024 * 1024)
    const formData = createMockFormData(file)

    const req = new NextRequest('http://localhost/api/upload', {
      method: 'POST',
      body: formData as unknown,
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error?.message ?? body.error).toMatch(/too large|2MB/i)
  })

  it('returns 400 when bucket is invalid', async () => {
    const file = createMockFile(jpegBytes, 'test.jpg', 'image/jpeg')
    const formData = createMockFormData(file, 'malicious-bucket')

    const req = new NextRequest('http://localhost/api/upload', {
      method: 'POST',
      body: formData as unknown,
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error?.message ?? body.error).toMatch(/Invalid bucket/i)
  })

  it('returns 400 when file type is not allowed (magic byte sniff fails)', async () => {
    mockSniffImageFile.mockResolvedValue(null)

    const badBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 0, 0, 0, 0, 0, 0, 0]) // PDF signature
    const file = createMockFile(badBytes, 'evil.pdf', 'application/pdf')
    const formData = createMockFormData(file)

    const req = new NextRequest('http://localhost/api/upload', {
      method: 'POST',
      body: formData as unknown,
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error?.message ?? body.error).toMatch(/Invalid file type/i)
  })

  // --- Success Cases ---

  it('uploads file successfully to default reports bucket', async () => {
    const file = createMockFile(jpegBytes, 'screenshot.jpg', 'image/jpeg')
    const formData = createMockFormData(file)

    const req = new NextRequest('http://localhost/api/upload', {
      method: 'POST',
      body: formData as unknown,
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.url).toBe('https://storage.test/reports/user-123/abc123.jpg')
    expect(mockStorageFrom).toHaveBeenCalledWith('reports')
    expect(mockUpload).toHaveBeenCalledWith(
      expect.stringContaining('user-123/'),
      expect.any(Buffer),
      expect.objectContaining({ contentType: 'image/jpeg', upsert: false })
    )
  })

  it('uploads file to avatars bucket when specified', async () => {
    const file = createMockFile(jpegBytes, 'avatar.jpg', 'image/jpeg')
    const formData = createMockFormData(file, 'avatars')

    const req = new NextRequest('http://localhost/api/upload', {
      method: 'POST',
      body: formData as unknown,
    })
    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(mockStorageFrom).toHaveBeenCalledWith('avatars')
  })

  it('uploads file to posts bucket when specified', async () => {
    const file = createMockFile(jpegBytes, 'post-image.jpg', 'image/jpeg')
    const formData = createMockFormData(file, 'posts')

    const req = new NextRequest('http://localhost/api/upload', {
      method: 'POST',
      body: formData as unknown,
    })
    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(mockStorageFrom).toHaveBeenCalledWith('posts')
  })

  it('uses sniffed extension (not client filename) for uploaded file path', async () => {
    // Client says PNG but magic bytes say JPEG
    mockSniffImageFile.mockResolvedValue({ kind: 'jpeg', mime: 'image/jpeg', extension: 'jpg' })

    const file = createMockFile(jpegBytes, 'image.png', 'image/png')
    const formData = createMockFormData(file)

    const req = new NextRequest('http://localhost/api/upload', {
      method: 'POST',
      body: formData as unknown,
    })
    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(mockUpload).toHaveBeenCalledWith(
      expect.stringMatching(/\.jpg$/),
      expect.any(Buffer),
      expect.objectContaining({ contentType: 'image/jpeg' })
    )
  })

  // --- Storage Error ---

  it('returns 500 when Supabase storage upload fails', async () => {
    mockUpload.mockResolvedValue({ error: { message: 'Storage quota exceeded' } })

    const file = createMockFile(jpegBytes, 'test.jpg', 'image/jpeg')
    const formData = createMockFormData(file)

    const req = new NextRequest('http://localhost/api/upload', {
      method: 'POST',
      body: formData as unknown,
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.error?.message ?? body.error).toMatch(/Upload failed/i)
  })
})
