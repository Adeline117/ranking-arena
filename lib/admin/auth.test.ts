/**
 * Admin Auth Tests
 * 测试管理员认证工具
 */

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

// Mock environment variables
const originalEnv = process.env

beforeEach(() => {
  jest.clearAllMocks()
  // Reset modules for fresh import
  jest.resetModules()
  // Set default env for most tests
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
    const { getAdminEmails } = require('./auth')
    const emails = getAdminEmails()
    expect(emails).toContain('admin@example.com')
    expect(emails).toContain('superadmin@example.com')
  })

  test('should return default when no env var set', () => {
    delete process.env.ADMIN_EMAILS
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getAdminEmails } = require('./auth')
    const emails = getAdminEmails()
    expect(emails).toContain('test@example.com')
  })
})

describe('getSupabaseAdmin', () => {
  test('should create admin client with env vars', () => {
    const { getSupabaseAdmin } = require('./auth')
    const { createClient } = require('@supabase/supabase-js')

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
    jest.resetModules()

    const { getSupabaseAdmin } = require('./auth')
    expect(() => getSupabaseAdmin()).toThrow()
  })

  test('should use NEXT_PUBLIC_SUPABASE_URL as fallback', () => {
    delete process.env.SUPABASE_URL
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fallback.supabase.co'
    jest.resetModules()

    const { getSupabaseAdmin } = require('./auth')
    const { createClient } = require('@supabase/supabase-js')

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
    const { verifyAdmin } = require('./auth')
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
    const { verifyAdmin } = require('./auth')
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
    const { verifyAdmin } = require('./auth')
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
    const { verifyAdmin } = require('./auth')
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
    const { verifyAdmin } = require('./auth')
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
    const { verifyAdmin } = require('./auth')
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
    const { verifyAdmin } = require('./auth')
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
