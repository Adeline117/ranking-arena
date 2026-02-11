import type { SupabaseClient } from "@supabase/supabase-js"
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Admin Auth Tests
 * 测试管理员认证工具
 */

import { verifyAdmin, getSupabaseAdmin } from './auth'

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
    // ADMIN_EMAILS is initialized at module load time
    // Need to reset modules and re-import with env set
    jest.resetModules()
    process.env.ADMIN_EMAILS = 'admin@example.com,superadmin@example.com'
     
    const { getAdminEmails: freshGetAdminEmails } = require('./auth')
    const emails = freshGetAdminEmails()
    expect(emails).toContain('admin@example.com')
    expect(emails).toContain('superadmin@example.com')
  })

  test('should return empty array when no env var set (secure default)', () => {
    delete process.env.ADMIN_EMAILS
    // Need to reimport to get fresh module
    jest.resetModules()
     
    const { getAdminEmails: freshGetAdminEmails } = require('./auth')
    const emails = freshGetAdminEmails()
    // Secure default: empty array (no default admins)
    expect(emails).toEqual([])
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

    const result = await verifyAdmin(mockSupabase as unknown as SupabaseClient, null)
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

    const result = await verifyAdmin(mockSupabase as unknown as SupabaseClient, 'InvalidToken')
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

    const result = await verifyAdmin(mockSupabase as unknown as SupabaseClient, 'Bearer validtoken')
    expect(result).toBeNull()
  })

  test('should verify admin by email whitelist', async () => {
    // Reset modules to load with proper ADMIN_EMAILS
    jest.resetModules()
    process.env.ADMIN_EMAILS = 'admin@example.com,superadmin@example.com'
     
    const { verifyAdmin: freshVerifyAdmin } = require('./auth')

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

    const result = await freshVerifyAdmin(mockSupabase as unknown as SupabaseClient, 'Bearer validtoken')
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

    const result = await verifyAdmin(mockSupabase as unknown as SupabaseClient, 'Bearer validtoken')
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

    const result = await verifyAdmin(mockSupabase as unknown as SupabaseClient, 'Bearer validtoken')
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

    const result = await verifyAdmin(mockSupabase as unknown as SupabaseClient, 'Bearer validtoken')
    expect(result).toEqual({ id: 'user123', email: '' })
  })
})
