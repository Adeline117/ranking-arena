/**
 * /api/bookmark-folders route tests
 *
 * Tests listing bookmark folders (GET) and creating folders (POST),
 * including auth, validation, and error handling.
 */

// --- Mocks ---

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
    cookies: { get: () => undefined }
    constructor(url: string, opts?: { headers?: Record<string, string>; method?: string; body?: unknown }) {
      this.url = url
      this.nextUrl = new URL(url)
      this.headers = new Map(Object.entries({ 'user-agent': 'Mozilla/5.0 (Jest Test Runner)', ...(opts?.headers || {}) }))
      this.method = opts?.method || 'GET'
      this._body = opts?.body
      this.cookies = { get: () => undefined }
    }
    async json() { return this._body }
  }

  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  checkRateLimitFull: jest.fn().mockResolvedValue({ response: null, meta: null }),
  addRateLimitHeaders: jest.fn(),
  RateLimitPresets: { read: {}, write: {} },
}))

const mockRequireAuth = jest.fn()
const mockGetAuthUser = jest.fn()
let mockSupabaseRpcResult: { data: unknown; error: unknown } = { data: null, error: null }
let mockSupabaseSelectResult: { data: unknown; error: unknown } = { data: [], error: null }
let mockSupabaseInsertResult: { data: unknown; error: unknown } = { data: null, error: null }

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({
    rpc: jest.fn().mockImplementation(() => Promise.resolve(mockSupabaseRpcResult)),
    from: jest.fn(() => {
      const chain: Record<string, jest.Mock> = {}
      chain.select = jest.fn(() => chain)
      chain.eq = jest.fn(() => chain)
      chain.order = jest.fn(() => chain)
      chain.insert = jest.fn(() => chain)
      chain.single = jest.fn(() => Promise.resolve(mockSupabaseInsertResult))
      // Make the chain thenable so `await` resolves to the select result
      chain.then = jest.fn((resolve: (v: unknown) => void) => resolve(mockSupabaseSelectResult)) as jest.Mock
      return chain
    }),
  })),
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getUserHandle: jest.fn(),
  getUserProfile: jest.fn(),
}))

jest.mock('@/lib/utils/csrf', () => ({
  validateCsrfToken: jest.fn().mockReturnValue(true),
  generateCsrfToken: jest.fn().mockReturnValue('test-csrf'),
  CSRF_COOKIE_NAME: 'csrf-token',
  CSRF_HEADER_NAME: 'x-csrf-token',
}))

jest.mock('@/lib/api/correlation', () => ({
  getOrCreateCorrelationId: jest.fn().mockReturnValue('test-cid'),
  runWithCorrelationId: jest.fn((_id: string, fn: () => unknown) => fn()),
  getCorrelationId: jest.fn().mockReturnValue('test-cid'),
}))

jest.mock('@/lib/api/versioning', () => ({
  parseApiVersion: jest.fn().mockReturnValue({ version: 'v1', isDeprecated: false }),
  addVersionHeaders: jest.fn(),
  addDeprecationHeaders: jest.fn(),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  fireAndForget: jest.fn(),
  captureError: jest.fn(),
  captureMessage: jest.fn(),
}))

import { NextRequest } from 'next/server'
import { GET, POST } from '../route'

describe('/api/bookmark-folders', () => {
  const mockUser = { id: 'user-1', email: 'test@test.com' }

  beforeEach(() => {
    jest.clearAllMocks()
    mockRequireAuth.mockResolvedValue(mockUser)
    mockGetAuthUser.mockResolvedValue(mockUser)
    mockSupabaseRpcResult = { data: null, error: null }
    mockSupabaseSelectResult = { data: [], error: null }
    mockSupabaseInsertResult = { data: null, error: null }
  })

  // --- GET: List Bookmark Folders ---

  describe('GET /api/bookmark-folders', () => {
    it('returns 401 when not authenticated', async () => {
      mockGetAuthUser.mockResolvedValue(null)

      const req = new NextRequest('http://localhost/api/bookmark-folders')
      const res = await GET(req)
      const body = await res.json()

      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(body.success).toBe(false)
    })

    it('returns empty folders list for new user', async () => {
      mockSupabaseSelectResult = { data: [], error: null }

      const req = new NextRequest('http://localhost/api/bookmark-folders')
      const res = await GET(req)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.success).toBe(true)
      expect(body.data.folders).toEqual([])
    })

    it('returns user bookmark folders', async () => {
      mockSupabaseSelectResult = {
        data: [
          { id: 'f1', name: 'Default', is_default: true, is_public: false },
          { id: 'f2', name: 'Favorites', is_default: false, is_public: true },
        ],
        error: null,
      }

      const req = new NextRequest('http://localhost/api/bookmark-folders')
      const res = await GET(req)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.data.folders).toHaveLength(2)
    })

    it('handles table not found gracefully', async () => {
      mockSupabaseSelectResult = {
        data: null,
        error: { code: '42P01', message: 'relation does not exist' },
      }

      const req = new NextRequest('http://localhost/api/bookmark-folders')
      const res = await GET(req)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.data.folders).toEqual([])
    })
  })

  // --- POST: Create Bookmark Folder ---

  describe('POST /api/bookmark-folders', () => {
    it('returns 401 when not authenticated', async () => {
      mockGetAuthUser.mockResolvedValue(null)

      const req = new NextRequest('http://localhost/api/bookmark-folders', {
        method: 'POST',
        body: { name: 'My Folder' },
      })
      const res = await POST(req)
      const body = await res.json()

      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(body.success).toBe(false)
    })

    it('returns 400 when name is missing', async () => {
      const req = new NextRequest('http://localhost/api/bookmark-folders', {
        method: 'POST',
        body: {},
      })
      const res = await POST(req)
      const body = await res.json()

      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(body.success).toBe(false)
    })

    it('creates folder successfully with valid name', async () => {
      const mockFolder = { id: 'f-new', name: 'My Folder', is_default: false, is_public: false }
      mockSupabaseInsertResult = { data: mockFolder, error: null }

      const req = new NextRequest('http://localhost/api/bookmark-folders', {
        method: 'POST',
        body: { name: 'My Folder' },
      })
      const res = await POST(req)
      const body = await res.json()

      expect(res.status).toBe(201)
      expect(body.success).toBe(true)
      expect(body.data.folder.name).toBe('My Folder')
    })

    it('handles duplicate folder name error', async () => {
      mockSupabaseInsertResult = {
        data: null,
        error: { code: '23505', message: 'duplicate key value' },
      }

      const req = new NextRequest('http://localhost/api/bookmark-folders', {
        method: 'POST',
        body: { name: 'Existing Folder' },
      })
      const res = await POST(req)
      const body = await res.json()

      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(body.success).toBe(false)
    })
  })
})
