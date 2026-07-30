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
    async json() {
      return this._body
    }
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
    constructor(
      url: string,
      opts?: { headers?: Record<string, string>; method?: string; body?: unknown }
    ) {
      this.url = url
      this.nextUrl = new URL(url)
      this.headers = new Map(
        Object.entries({ 'user-agent': 'Mozilla/5.0 (Jest Test Runner)', ...(opts?.headers || {}) })
      )
      this.method = opts?.method || 'GET'
      this._body = opts?.body
      this.cookies = { get: () => undefined }
    }
    async json() {
      return this._body
    }
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
const mockSupabaseRpc = jest.fn()
const mockUserScopedRpc = jest.fn()
const mockCreateUserScopedServerClient = jest.fn()
const mockSupabaseFrom = jest.fn()
let mockAdminRpcResult: { data: unknown; error: unknown } = { data: null, error: null }
let mockUserRpcResult: { data: unknown; error: unknown } = { data: null, error: null }
let mockSupabaseSelectResult: { data: unknown; error: unknown } = { data: [], error: null }
let mockSupabaseTableResults: Record<string, { data: unknown; error: unknown }> = {}

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({
    rpc: (...args: unknown[]) => mockSupabaseRpc(...args),
    from: (...args: unknown[]) => mockSupabaseFrom(...args),
  })),
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getUserHandle: jest.fn(),
  getUserProfile: jest.fn(),
}))

jest.mock('@/lib/supabase/user-scoped-server', () => ({
  createUserScopedServerClient: (...args: unknown[]) => mockCreateUserScopedServerClient(...args),
}))

mockSupabaseRpc.mockImplementation(() => Promise.resolve(mockAdminRpcResult))
mockSupabaseFrom.mockImplementation((table: string) => {
  const chain: Record<string, jest.Mock> = {}
  chain.select = jest.fn(() => chain)
  chain.eq = jest.fn(() => chain)
  chain.order = jest.fn(() => chain)
  chain.insert = jest.fn(() => chain)
  chain.single = jest.fn(() =>
    Promise.resolve(mockSupabaseTableResults[table] ?? mockSupabaseSelectResult)
  )
  // Make the chain thenable so `await` resolves to the select result
  chain.then = jest.fn((resolve: (v: unknown) => void) =>
    resolve(mockSupabaseTableResults[table] ?? mockSupabaseSelectResult)
  ) as jest.Mock
  return chain
})

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
  const USER_ID = '11111111-1111-4111-8111-111111111111'
  const FOLDER_ID = '22222222-2222-4222-8222-222222222222'
  const mockUser = { id: USER_ID, email: 'test@test.com' }

  function mutationFolder(overrides: Record<string, unknown> = {}) {
    return {
      id: FOLDER_ID,
      user_id: USER_ID,
      name: 'My Folder',
      description: null,
      avatar_url: null,
      is_public: false,
      is_default: false,
      post_count: 0,
      subscriber_count: 0,
      created_at: '2026-07-29T00:00:00Z',
      updated_at: '2026-07-29T00:00:00Z',
      ...overrides,
    }
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockSupabaseRpc.mockImplementation(() => Promise.resolve(mockAdminRpcResult))
    mockUserScopedRpc.mockImplementation(() => Promise.resolve(mockUserRpcResult))
    mockCreateUserScopedServerClient.mockReturnValue({ rpc: mockUserScopedRpc })
    mockSupabaseFrom.mockImplementation((table: string) => {
      const chain: Record<string, jest.Mock> = {}
      chain.select = jest.fn(() => chain)
      chain.eq = jest.fn(() => chain)
      chain.order = jest.fn(() => chain)
      chain.insert = jest.fn(() => chain)
      chain.single = jest.fn(() =>
        Promise.resolve(mockSupabaseTableResults[table] ?? mockSupabaseSelectResult)
      )
      chain.then = jest.fn((resolve: (v: unknown) => void) =>
        resolve(mockSupabaseTableResults[table] ?? mockSupabaseSelectResult)
      ) as jest.Mock
      return chain
    })
    mockRequireAuth.mockResolvedValue(mockUser)
    mockGetAuthUser.mockResolvedValue(mockUser)
    mockAdminRpcResult = { data: null, error: null }
    mockUserRpcResult = { data: null, error: null }
    mockSupabaseSelectResult = { data: [], error: null }
    mockSupabaseTableResults = {}
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
      mockAdminRpcResult = {
        data: { status: 'ok', actor_id: USER_ID, folders: [] },
        error: null,
      }

      const req = new NextRequest('http://localhost/api/bookmark-folders')
      const res = await GET(req)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.success).toBe(true)
      expect(body.data.folders).toEqual([])
      expect(mockCreateUserScopedServerClient).toHaveBeenCalledWith(req)
      expect(mockUserScopedRpc).toHaveBeenCalledWith('ensure_default_bookmark_folder', {
        p_user_id: USER_ID,
      })
      expect(mockSupabaseRpc).toHaveBeenCalledWith('read_owned_bookmark_folders_snapshot', {
        p_actor_id: USER_ID,
      })
      expect(mockSupabaseFrom).not.toHaveBeenCalled()
    })

    it('returns user bookmark folders', async () => {
      mockAdminRpcResult = {
        data: {
          status: 'ok',
          actor_id: USER_ID,
          folders: [
            mutationFolder({ is_default: true, name: 'Default' }),
            mutationFolder({
              id: '33333333-3333-4333-8333-333333333333',
              is_public: true,
              name: 'Favorites',
            }),
          ],
        },
        error: null,
      }

      const req = new NextRequest('http://localhost/api/bookmark-folders')
      const res = await GET(req)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.data.folders).toHaveLength(2)
    })

    it('fails closed when the folder table is unavailable', async () => {
      mockAdminRpcResult = {
        data: null,
        error: { code: '42P01', message: 'relation does not exist' },
      }

      const req = new NextRequest('http://localhost/api/bookmark-folders')
      const res = await GET(req)
      const body = await res.json()

      expect(res.status).toBe(503)
      expect(body.success).toBe(false)
    })

    it('fails closed when the default-folder authority is unavailable', async () => {
      mockUserRpcResult = {
        data: null,
        error: { code: 'PGRST202', message: 'function is not in the schema cache' },
      }

      const req = new NextRequest('http://localhost/api/bookmark-folders')
      const res = await GET(req)
      const body = await res.json()

      expect(res.status).toBeGreaterThanOrEqual(500)
      expect(body.success).toBe(false)
    })

    it('fails closed if the default-folder authority has no verified bearer to forward', async () => {
      mockCreateUserScopedServerClient.mockImplementationOnce(() => {
        throw new Error('A verified bearer token is required for an RLS-scoped query')
      })

      const req = new NextRequest('http://localhost/api/bookmark-folders')
      const res = await GET(req)

      expect(res.status).toBe(500)
      expect(mockUserScopedRpc).not.toHaveBeenCalled()
      expect(mockSupabaseRpc).not.toHaveBeenCalled()
      expect(mockSupabaseFrom).not.toHaveBeenCalled()
    })

    it('does not turn an invalid count snapshot into zero items in every folder', async () => {
      mockAdminRpcResult = {
        data: {
          status: 'ok',
          actor_id: USER_ID,
          folders: [mutationFolder({ post_count: null })],
        },
        error: null,
      }

      const req = new NextRequest('http://localhost/api/bookmark-folders')
      const res = await GET(req)
      const body = await res.json()

      expect(res.status).toBe(500)
      expect(body.success).toBe(false)
      expect(mockSupabaseFrom).not.toHaveBeenCalled()
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
      const mockFolder = mutationFolder()
      mockUserRpcResult = {
        data: { status: 'created', user_id: USER_ID, folder: mockFolder },
        error: null,
      }

      const req = new NextRequest('http://localhost/api/bookmark-folders', {
        method: 'POST',
        body: { name: 'My Folder' },
      })
      const res = await POST(req)
      const body = await res.json()

      expect(res.status).toBe(201)
      expect(body.success).toBe(true)
      expect(body.data.folder.name).toBe('My Folder')
      expect(mockCreateUserScopedServerClient).toHaveBeenCalledWith(req)
      expect(mockUserScopedRpc).toHaveBeenCalledWith('mutate_bookmark_folder_atomic', {
        p_action: 'create',
        p_folder_id: null,
        p_name: 'My Folder',
        p_description: null,
        p_avatar_url: null,
        p_is_public: false,
        p_set_name: true,
        p_set_description: true,
        p_set_avatar_url: true,
        p_set_is_public: true,
      })
      expect(mockSupabaseRpc).not.toHaveBeenCalled()
      expect(mockSupabaseFrom).not.toHaveBeenCalled()
    })

    it('handles duplicate folder name error', async () => {
      mockUserRpcResult = { data: { status: 'name_conflict' }, error: null }

      const req = new NextRequest('http://localhost/api/bookmark-folders', {
        method: 'POST',
        body: { name: 'Existing Folder' },
      })
      const res = await POST(req)
      const body = await res.json()

      expect(res.status).toBe(409)
      expect(body.success).toBe(false)
    })

    it('returns 503 when the lifecycle authority is not deployed', async () => {
      mockUserRpcResult = {
        data: null,
        error: { code: 'PGRST202', message: 'Could not find the function' },
      }

      const req = new NextRequest('http://localhost/api/bookmark-folders', {
        method: 'POST',
        body: { name: 'My Folder' },
      })
      const res = await POST(req)
      const body = await res.json()

      expect(res.status).toBe(503)
      expect(body.success).toBe(false)
      expect(body.error.code).toBe('SERVICE_UNAVAILABLE')
    })

    it('fails closed on a forged or malformed create acknowledgement', async () => {
      mockUserRpcResult = {
        data: {
          status: 'created',
          user_id: USER_ID,
          folder: mutationFolder({ user_id: '99999999-9999-4999-8999-999999999999' }),
        },
        error: null,
      }

      const req = new NextRequest('http://localhost/api/bookmark-folders', {
        method: 'POST',
        body: { name: 'My Folder' },
      })
      const res = await POST(req)
      const body = await res.json()

      expect(res.status).toBe(500)
      expect(body.success).toBe(false)
    })

    it.each([null, [], 'folder'])('rejects a non-object JSON body: %p', async (bodyValue) => {
      const req = new NextRequest('http://localhost/api/bookmark-folders', {
        method: 'POST',
        body: bodyValue,
      })
      const res = await POST(req)

      expect(res.status).toBe(400)
      expect(mockUserScopedRpc).not.toHaveBeenCalled()
    })

    it('rejects control characters before invoking the authority', async () => {
      const req = new NextRequest('http://localhost/api/bookmark-folders', {
        method: 'POST',
        body: { name: 'My\u0000Folder' },
      })
      const res = await POST(req)

      expect(res.status).toBe(400)
      expect(mockUserScopedRpc).not.toHaveBeenCalled()
    })

    it('fails closed if a post-auth handler has no verified bearer to forward', async () => {
      mockCreateUserScopedServerClient.mockImplementationOnce(() => {
        throw new Error('A verified bearer token is required for an RLS-scoped query')
      })

      const req = new NextRequest('http://localhost/api/bookmark-folders', {
        method: 'POST',
        body: { name: 'My Folder' },
      })
      const res = await POST(req)

      expect(res.status).toBe(500)
      expect(mockUserScopedRpc).not.toHaveBeenCalled()
      expect(mockSupabaseRpc).not.toHaveBeenCalled()
    })
  })
})
