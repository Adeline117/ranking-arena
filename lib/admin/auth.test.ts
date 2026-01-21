/**
 * Admin Auth Tests
 * 测试管理员认证工具
 */

import { verifyAdmin, getAdminEmails, getSupabaseAdmin } from './auth'

// Mock createClient
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    auth: {
      getUser: jest.fn(),
    },
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn(),
  })),
}))

import { createClient } from '@supabase/supabase-js'

// Mock environment variables
const originalEnv = process.env

beforeEach(() => {
  jest.clearAllMocks()
  process.env = {
    ...originalEnv,
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
    ADMIN_EMAILS: 'admin@example.com,superadmin@example.com',
  }
})

afterAll(() => {
  process.env = originalEnv
})

describe('getAdminEmails', () => {
  test('should return admin emails from environment', () => {
    const emails = getAdminEmails()
    expect(emails).toContain('admin@example.com')
    expect(emails).toContain('superadmin@example.com')
  })

  test('should return default when no env var set', () => {
    delete process.env.ADMIN_EMAILS
    // Need to reimport to get fresh module
    jest.resetModules()
    const { getAdminEmails: getEmails } = require('./auth')
    const emails = getEmails()
    expect(emails).toContain('test@example.com')
  })
})

describe('getSupabaseAdmin', () => {
  test('should create admin client with env vars', () => {
    getSupabaseAdmin()
    expect(createClient).toHaveBeenCalledWith(
      'https://test.supabase.co',
      'test-service-key',
      { auth: { persistSession: false } }
    )
  })

  test('should throw when env vars missing', () => {
    delete process.env.SUPABASE_URL
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY

    expect(() => getSupabaseAdmin()).toThrow()
  })

  test('should use NEXT_PUBLIC_SUPABASE_URL as fallback', () => {
    delete process.env.SUPABASE_URL
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fallback.supabase.co'

    getSupabaseAdmin()
    expect(createClient).toHaveBeenCalledWith(
      'https://fallback.supabase.co',
      'test-service-key',
      expect.any(Object)
    )
  })
})

describe('verifyAdmin', () => {
  test('should return null for missing auth header', async () => {
    const mockSupabase = {
      auth: { getUser: jest.fn() },
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn(),
    }

    const result = await verifyAdmin(mockSupabase as any, null)
    expect(result).toBeNull()
  })

  test('should return null for invalid auth header format', async () => {
    const mockSupabase = {
      auth: { getUser: jest.fn() },
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn(),
    }

    const result = await verifyAdmin(mockSupabase as any, 'InvalidToken')
    expect(result).toBeNull()
  })

  test('should return null when getUser fails', async () => {
    const mockSupabase = {
      auth: {
        getUser: jest.fn().mockResolvedValue({ data: { user: null }, error: new Error('Invalid') }),
      },
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn(),
    }

    const result = await verifyAdmin(mockSupabase as any, 'Bearer validtoken')
    expect(result).toBeNull()
  })

  test('should verify admin by email whitelist', async () => {
    const mockUser = {
      id: 'user123',
      email: 'admin@example.com',
    }

    const mockSupabase = {
      auth: {
        getUser: jest.fn().mockResolvedValue({ data: { user: mockUser }, error: null }),
      },
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: { role: 'user' }, error: null }),
    }

    const result = await verifyAdmin(mockSupabase as any, 'Bearer validtoken')
    expect(result).toEqual({ id: 'user123', email: 'admin@example.com' })
  })

  test('should verify admin by database role', async () => {
    const mockUser = {
      id: 'user123',
      email: 'notadmin@example.com',
    }

    const mockSupabase = {
      auth: {
        getUser: jest.fn().mockResolvedValue({ data: { user: mockUser }, error: null }),
      },
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: { role: 'admin' }, error: null }),
    }

    const result = await verifyAdmin(mockSupabase as any, 'Bearer validtoken')
    expect(result).toEqual({ id: 'user123', email: 'notadmin@example.com' })
  })

  test('should return null when user is not admin', async () => {
    const mockUser = {
      id: 'user123',
      email: 'notadmin@example.com',
    }

    const mockSupabase = {
      auth: {
        getUser: jest.fn().mockResolvedValue({ data: { user: mockUser }, error: null }),
      },
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: { role: 'user' }, error: null }),
    }

    const result = await verifyAdmin(mockSupabase as any, 'Bearer validtoken')
    expect(result).toBeNull()
  })

  test('should handle user without email', async () => {
    const mockUser = {
      id: 'user123',
      email: undefined,
    }

    const mockSupabase = {
      auth: {
        getUser: jest.fn().mockResolvedValue({ data: { user: mockUser }, error: null }),
      },
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: { role: 'admin' }, error: null }),
    }

    const result = await verifyAdmin(mockSupabase as any, 'Bearer validtoken')
    expect(result).toEqual({ id: 'user123', email: '' })
  })
})
