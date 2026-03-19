/**
 * API 中间件测试
 */

// Mock next/server for Node.js test environment
jest.mock('next/server', () => {
  class MockNextRequest {
    url: string
    headers: Map<string, string>
    method: string
    cookies: { get: () => undefined }

    constructor(url: string, init?: { method?: string; headers?: Record<string, string> }) {
      this.url = url
      this.method = init?.method || 'GET'
      // Include a default user-agent so bot-protection check passes
      this.headers = new Map(Object.entries({
        'user-agent': 'Mozilla/5.0 (Test)',
        ...(init?.headers || {}),
      }))
      this.cookies = { get: () => undefined }
    }

    get nextUrl() {
      return new URL(this.url)
    }
  }

  class MockNextResponse {
    body: string
    status: number
    headers: Map<string, string>

    constructor(body?: string | null, init?: { status?: number; headers?: Record<string, string> }) {
      this.body = body || ''
      this.status = init?.status || 200
      const entries = Object.entries(init?.headers || {})
      const map = new Map(entries)
      // Add set/get methods so middleware can call response.headers.set(...)
      ;(map as Map<string, string> & { set: (k: string, v: string) => void; get: (k: string) => string | undefined }).set = map.set.bind(map)
      ;(map as Map<string, string> & { get: (k: string) => string | undefined }).get = map.get.bind(map)
      this.headers = map
    }

    json() {
      return JSON.parse(this.body)
    }

    static json(data: unknown, init?: { status?: number }) {
      return new MockNextResponse(JSON.stringify(data), init)
    }
  }

  return {
    NextRequest: MockNextRequest,
    NextResponse: MockNextResponse,
  }
})

import { NextRequest, NextResponse } from 'next/server'

// Mock Supabase
jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: jest.fn(),
  getSupabaseAdmin: jest.fn(() => ({})),
}))

// Mock rate limit — checkRateLimit now returns { response, meta }
jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn(() => ({ response: null, meta: null })),
  addRateLimitHeaders: jest.fn(),
  RateLimitPresets: {
    public: { requests: 100, window: 60, prefix: 'public' },
    authenticated: { requests: 200, window: 60, prefix: 'auth' },
    write: { requests: 30, window: 60, prefix: 'write' },
  },
}))

// Mock CSRF
jest.mock('@/lib/utils/csrf', () => ({
  validateCsrfToken: jest.fn().mockReturnValue(true),
  generateCsrfToken: jest.fn().mockReturnValue('test-csrf-token'),
  CSRF_COOKIE_NAME: 'csrf-token',
  CSRF_HEADER_NAME: 'x-csrf-token',
}))

// Mock correlation ID module
jest.mock('@/lib/api/correlation', () => ({
  getOrCreateCorrelationId: jest.fn().mockReturnValue('test-cid'),
  runWithCorrelationId: jest.fn((_id: string, fn: () => unknown) => fn()),
  getCorrelationId: jest.fn().mockReturnValue('test-cid'),
}))

// Mock versioning
jest.mock('@/lib/api/versioning', () => ({
  parseApiVersion: jest.fn().mockReturnValue({ version: 'v1', deprecated: false }),
  addVersionHeaders: jest.fn(),
  addDeprecationHeaders: jest.fn(),
}))

// Mock logger
jest.mock('@/lib/utils/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  })),
}))

import { withApiMiddleware, withAuth, withPublic } from '../middleware'
import { getAuthUser } from '@/lib/supabase/server'
import { checkRateLimit } from '@/lib/utils/rate-limit'

describe('API 中间件', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('withApiMiddleware', () => {
    it('应该执行处理函数并返回响应', async () => {
      const handler = jest.fn().mockResolvedValue({ message: 'success' })
      const wrapped = withApiMiddleware(handler)
      
      const request = new NextRequest('http://localhost/api/test')
      const response = await wrapped(request)
      
      expect(handler).toHaveBeenCalled()
      expect(response).toBeInstanceOf(NextResponse)
    })

    it('应该在限流时返回 429', async () => {
      const rateLimitResponse = NextResponse.json(
        { error: 'Rate limited' },
        { status: 429 }
      )
      ;(checkRateLimit as jest.Mock).mockResolvedValueOnce({ response: rateLimitResponse, meta: null })
      
      const handler = jest.fn()
      const wrapped = withApiMiddleware(handler)
      
      const request = new NextRequest('http://localhost/api/test')
      const response = await wrapped(request)
      
      expect(response.status).toBe(429)
      expect(handler).not.toHaveBeenCalled()
    })

    it('需要认证时未登录应该返回 401', async () => {
      ;(getAuthUser as jest.Mock).mockResolvedValueOnce(null)
      
      const handler = jest.fn()
      const wrapped = withApiMiddleware(handler, { requireAuth: true })
      
      const request = new NextRequest('http://localhost/api/test')
      const response = await wrapped(request)
      
      expect(response.status).toBe(401)
      expect(handler).not.toHaveBeenCalled()
    })

    it('应该正确传递用户信息到处理函数', async () => {
      const mockUser = { id: 'user123', email: 'test@example.com' }
      ;(getAuthUser as jest.Mock).mockResolvedValueOnce(mockUser)
      
      const handler = jest.fn().mockResolvedValue({ success: true })
      const wrapped = withApiMiddleware(handler, { requireAuth: true })
      
      const request = new NextRequest('http://localhost/api/test')
      await wrapped(request)
      
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          user: mockUser,
        })
      )
    })

    it('应该处理处理函数抛出的错误', async () => {
      const handler = jest.fn().mockRejectedValue(new Error('Test error'))
      const wrapped = withApiMiddleware(handler)
      
      const request = new NextRequest('http://localhost/api/test')
      const response = await wrapped(request)
      
      expect(response.status).toBe(500)
    })

    it('应该处理带状态码的错误', async () => {
      const error = new Error('Not found')
      ;(error as Error & { statusCode?: number }).statusCode = 404
      const handler = jest.fn().mockRejectedValue(error)
      const wrapped = withApiMiddleware(handler)
      
      const request = new NextRequest('http://localhost/api/test')
      const response = await wrapped(request)
      
      expect(response.status).toBe(404)
    })
  })

  describe('withAuth', () => {
    it('应该强制要求认证', async () => {
      ;(getAuthUser as jest.Mock).mockResolvedValueOnce(null)
      
      const handler = jest.fn()
      const wrapped = withAuth(handler)
      
      const request = new NextRequest('http://localhost/api/test')
      const response = await wrapped(request)
      
      expect(response.status).toBe(401)
    })
  })

  describe('withPublic', () => {
    it('不需要认证也能访问', async () => {
      ;(getAuthUser as jest.Mock).mockResolvedValueOnce(null)
      
      const handler = jest.fn().mockResolvedValue({ public: true })
      const wrapped = withPublic(handler)
      
      const request = new NextRequest('http://localhost/api/test')
      const response = await wrapped(request)
      
      expect(response.status).toBe(200)
      expect(handler).toHaveBeenCalled()
    })
  })
})
