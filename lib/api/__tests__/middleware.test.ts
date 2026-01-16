/**
 * API 中间件测试
 */

import { NextRequest, NextResponse } from 'next/server'

// Mock Supabase
jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: jest.fn(),
  getSupabaseAdmin: jest.fn(() => ({})),
}))

// Mock rate limit
jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn(() => null),
  RateLimitPresets: {
    public: { requests: 100, window: 60, prefix: 'public' },
    authenticated: { requests: 200, window: 60, prefix: 'auth' },
    write: { requests: 30, window: 60, prefix: 'write' },
  },
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
      const rateLimitResponse = new NextResponse(
        JSON.stringify({ error: 'Rate limited' }),
        { status: 429 }
      )
      ;(checkRateLimit as jest.Mock).mockResolvedValueOnce(rateLimitResponse)
      
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
      ;(error as any).statusCode = 404
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
