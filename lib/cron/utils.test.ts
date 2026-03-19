import type { SupabaseClient } from "@supabase/supabase-js"
/**
 * Cron Utils Tests
 * 测试 Cron 任务工具函数
 */

import {
  SCRIPT_TIMEOUT,
  PLATFORM_SCRIPTS,
  getSupabaseEnv,
  isAuthorized,
  createSupabaseAdmin,
  executeScript,
  executePlatformScripts,
  logCronExecution,
  getSupportedPlatforms,
  sendScrapeSummaryAlert,
  ScriptResult,
} from './utils'

// Mock child_process
jest.mock('child_process', () => ({
  exec: jest.fn(),
}))

// Mock util
jest.mock('util', () => ({
  promisify: jest.fn((fn) => {
    return jest.fn().mockImplementation((...args) => {
      return new Promise((resolve, reject) => {
        fn(...args, (err: Error | null, result: unknown) => {
          if (err) reject(err)
          else resolve(result)
        })
      })
    })
  }),
}))

// Mock Supabase
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn().mockReturnThis(),
    insert: jest.fn().mockResolvedValue({ data: null, error: null }),
  })),
}))

// Override global @/lib/supabase/server mock so createSupabaseAdmin
// (which calls getSupabaseAdmin) behaves based on env vars.
jest.mock('@/lib/supabase/server', () => {
  const { createClient: mockCreate } = jest.requireMock('@supabase/supabase-js') as { createClient: jest.Mock }
  return {
    getSupabaseAdmin: jest.fn(() => {
      const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
      if (!url || !key) throw new Error('Missing Supabase env vars')
      return mockCreate(url, key, { auth: { persistSession: false } })
    }),
    getAuthUser: jest.fn().mockResolvedValue(null),
  }
})

import { createClient } from '@supabase/supabase-js'

// Mock circuit breaker
jest.mock('@/lib/utils/circuit-breaker', () => ({
  getCircuitBreaker: jest.fn(() => ({
    execute: jest.fn((fn) => fn()),
    getState: jest.fn(() => 'CLOSED'),
  })),
  withRetry: jest.fn((fn) => fn()),
  RetryPresets: { fast: { maxRetries: 3 } },
  isTransientError: jest.fn(() => false),
  getAllCircuitBreakerStats: jest.fn(() => ({})),
}))

import { getCircuitBreaker, withRetry } from '@/lib/utils/circuit-breaker'

// Mock environment variables
const originalEnv = process.env

beforeEach(() => {
  jest.clearAllMocks()
  process.env = {
    ...originalEnv,
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
    CRON_SECRET: 'test-secret',
    NODE_ENV: 'production',
  }
})

afterAll(() => {
  process.env = originalEnv
})

describe('Constants', () => {
  test('SCRIPT_TIMEOUT should be 3 minutes', () => {
    expect(SCRIPT_TIMEOUT).toBe(180000)
  })

  test('PLATFORM_SCRIPTS should have binance_futures', () => {
    expect(PLATFORM_SCRIPTS.binance_futures).toBeDefined()
    expect(PLATFORM_SCRIPTS.binance_futures.length).toBe(3)
  })

  test('PLATFORM_SCRIPTS should have bybit', () => {
    expect(PLATFORM_SCRIPTS.bybit).toBeDefined()
    expect(PLATFORM_SCRIPTS.bybit.length).toBe(3)
  })

  test('PLATFORM_SCRIPTS should have multiple platforms', () => {
    const platforms = Object.keys(PLATFORM_SCRIPTS)
    expect(platforms).toContain('binance_futures')
    // binance_spot permanently removed (2026-03-14) — blocks pipeline
    // bitget_futures disabled 2026-03-18 EMERGENCY (VPS scraper repeatedly hangs)
    expect(platforms).toContain('bybit')
    expect(platforms).toContain('mexc')
  })

  test('each platform script should have name, script, and args', () => {
    Object.values(PLATFORM_SCRIPTS).forEach(scripts => {
      scripts.forEach(script => {
        expect(script.name).toBeDefined()
        expect(script.script).toBeDefined()
        expect(script.args).toBeDefined()
        expect(Array.isArray(script.args)).toBe(true)
      })
    })
  })
})

describe('getSupabaseEnv', () => {
  test('should return env vars when set', () => {
    const { url, serviceKey } = getSupabaseEnv()
    expect(url).toBe('https://test.supabase.co')
    expect(serviceKey).toBe('test-service-key')
  })

  test('should use NEXT_PUBLIC_SUPABASE_URL as fallback', () => {
    delete process.env.SUPABASE_URL
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://next-public.supabase.co'

    const { url } = getSupabaseEnv()
    expect(url).toBe('https://next-public.supabase.co')
  })

  test('should return empty strings when not set', () => {
    delete process.env.SUPABASE_URL
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY

    const { url, serviceKey } = getSupabaseEnv()
    expect(url).toBe('')
    expect(serviceKey).toBe('')
  })
})

describe('isAuthorized', () => {
  test('should return true when header matches secret', () => {
    const req = {
      headers: {
        get: jest.fn().mockReturnValue('Bearer test-secret'),
      },
    } as unknown as Request

    expect(isAuthorized(req)).toBe(true)
  })

  test('should return false when header does not match', () => {
    const req = {
      headers: {
        get: jest.fn().mockReturnValue('wrong-secret'),
      },
    } as unknown as Request

    expect(isAuthorized(req)).toBe(false)
  })

  test('should return false when header is missing', () => {
    const req = {
      headers: {
        get: jest.fn().mockReturnValue(''),
      },
    } as unknown as Request

    expect(isAuthorized(req)).toBe(false)
  })

  test('should deny access in development without secret (security fix)', () => {
    delete process.env.CRON_SECRET
    process.env.NODE_ENV = 'development'

    const req = {
      headers: {
        get: jest.fn().mockReturnValue(''),
      },
    } as unknown as Request

    // No longer allows bypass in dev - CRON_SECRET is always required
    expect(isAuthorized(req)).toBe(false)
  })

  test('should not allow access in production without secret', () => {
    delete process.env.CRON_SECRET
    process.env.NODE_ENV = 'production'

    const req = {
      headers: {
        get: jest.fn().mockReturnValue(''),
      },
    } as unknown as Request

    expect(isAuthorized(req)).toBe(false)
  })
})

describe('createSupabaseAdmin', () => {
  test('should create client when env vars are set', () => {
    const client = createSupabaseAdmin()
    expect(client).not.toBeNull()
    expect(createClient).toHaveBeenCalledWith(
      'https://test.supabase.co',
      'test-service-key',
      { auth: { persistSession: false } }
    )
  })

  test('should return null when url is missing', () => {
    delete process.env.SUPABASE_URL
    delete process.env.NEXT_PUBLIC_SUPABASE_URL

    const client = createSupabaseAdmin()
    expect(client).toBeNull()
  })

  test('should return null when service key is missing', () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY

    const client = createSupabaseAdmin()
    expect(client).toBeNull()
  })
})

describe('executeScript', () => {
  test('should execute script successfully', async () => {
    ;(withRetry as jest.Mock).mockResolvedValue({
      stdout: 'Script executed successfully',
      stderr: '',
    })

    const result = await executeScript(
      { name: 'test_script', script: 'test.mjs', args: ['7D'] },
      { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'key' }
    )

    expect(result.success).toBe(true)
    expect(result.name).toBe('test_script')
    expect(result.output).toContain('Script executed successfully')
    expect(result.duration).toBeDefined()
  })

  test('should handle script failure', async () => {
    ;(withRetry as jest.Mock).mockRejectedValue(new Error('Script failed'))

    const result = await executeScript(
      { name: 'failing_script', script: 'fail.mjs', args: [] },
      {}
    )

    expect(result.success).toBe(false)
    expect(result.name).toBe('failing_script')
    expect(result.error).toContain('Script failed')
  })

  test('should truncate long output', async () => {
    const longOutput = 'x'.repeat(1000)
    ;(withRetry as jest.Mock).mockResolvedValue({
      stdout: longOutput,
      stderr: '',
    })

    const result = await executeScript(
      { name: 'long_output_script', script: 'long.mjs', args: [] },
      {}
    )

    expect(result.success).toBe(true)
    expect(result.output?.length).toBeLessThanOrEqual(500)
  })
})

describe('executePlatformScripts', () => {
  beforeEach(() => {
    ;(withRetry as jest.Mock).mockResolvedValue({
      stdout: 'Success',
      stderr: '',
    })
    ;(getCircuitBreaker as jest.Mock).mockReturnValue({
      execute: jest.fn((fn) => fn()),
      getState: jest.fn(() => 'CLOSED'),
    })
  })

  test('should execute all scripts for a platform', async () => {
    const result = await executePlatformScripts('bybit')

    expect(result.platform).toBe('bybit')
    expect(result.results.length).toBeGreaterThan(0)
    expect(result.ran_at).toBeDefined()
    expect(result.circuitBreakerState).toBe('CLOSED')
  })

  test('should throw error for unknown platform', async () => {
    await expect(executePlatformScripts('unknown_platform')).rejects.toThrow('未知平台: unknown_platform')
  })

  test('should handle circuit breaker open state', async () => {
    ;(getCircuitBreaker as jest.Mock).mockReturnValue({
      execute: jest.fn().mockRejectedValue(new Error('Circuit breaker is open')),
      getState: jest.fn(() => 'OPEN'),
    })

    const result = await executePlatformScripts('bybit')

    expect(result.circuitBreakerState).toBe('OPEN')
    expect(result.results.some(r => !r.success)).toBe(true)
  })

  test('should record failed scripts', async () => {
    ;(getCircuitBreaker as jest.Mock).mockReturnValue({
      execute: jest.fn((fn) => fn()),
      getState: jest.fn(() => 'CLOSED'),
    })
    ;(withRetry as jest.Mock).mockRejectedValue(new Error('Script failed'))

    const result = await executePlatformScripts('bybit')

    expect(result.results.some(r => !r.success)).toBe(true)
  })
})

describe('logCronExecution', () => {
  test('should insert log when supabase is provided', async () => {
    const mockInsert = jest.fn().mockResolvedValue({ data: null, error: null })
    const mockSupabase = {
      from: jest.fn().mockReturnValue({
        insert: mockInsert,
      }),
    }

    const results: ScriptResult[] = [
      { name: 'test', success: true, output: 'done' },
    ]

    await logCronExecution(mockSupabase as unknown as SupabaseClient, 'test_cron', results)

    expect(mockSupabase.from).toHaveBeenCalledWith('cron_logs')
    expect(mockInsert).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'test_cron',
        result: JSON.stringify(results),
      }),
    ])
  })

  test('should not throw when supabase is null', async () => {
    await expect(logCronExecution(null, 'test', [])).resolves.not.toThrow()
  })

  test('should handle insert errors gracefully', async () => {
    const mockSupabase = {
      from: jest.fn().mockReturnValue({
        insert: jest.fn().mockRejectedValue(new Error('Insert failed')),
      }),
    }

    // Should not throw
    await expect(
      logCronExecution(mockSupabase as unknown as SupabaseClient, 'test', [])
    ).resolves.not.toThrow()
  })
})

describe('getSupportedPlatforms', () => {
  test('should return all platform keys', () => {
    const platforms = getSupportedPlatforms()

    expect(platforms).toContain('binance_futures')
    // binance_spot permanently removed (2026-03-14) — blocks pipeline
    // bitget_futures disabled 2026-03-18 EMERGENCY (VPS scraper repeatedly hangs)
    expect(platforms).toContain('bybit')
    expect(platforms).toContain('mexc')
    expect(platforms).toContain('coinex')
    expect(platforms).toContain('okx_web3')
    // kucoin dead — removed from platform list
    expect(platforms).toContain('gmx')
  })

  test('should match PLATFORM_SCRIPTS keys', () => {
    const platforms = getSupportedPlatforms()
    const scriptKeys = Object.keys(PLATFORM_SCRIPTS)

    expect(platforms).toEqual(scriptKeys)
  })
})

describe('sendScrapeSummaryAlert', () => {
  test('should log success summary', async () => {
    // cronLogger is mocked — verify the function completes without throwing
    await expect(sendScrapeSummaryAlert({
      totalPlatforms: 5,
      successPlatforms: 5,
      failedPlatforms: 0,
      totalScripts: 15,
      successScripts: 15,
      failedScripts: 0,
      duration: 60000,
    })).resolves.not.toThrow()
  })

  test('should log failure summary with details', async () => {
    // cronLogger is mocked — verify the function completes without throwing
    await expect(sendScrapeSummaryAlert({
      totalPlatforms: 5,
      successPlatforms: 3,
      failedPlatforms: 2,
      totalScripts: 15,
      successScripts: 10,
      failedScripts: 5,
      duration: 60000,
      failedDetails: [
        { platform: 'binance', scripts: ['binance_7d', 'binance_30d'] },
        { platform: 'bybit', scripts: ['bybit_7d'] },
      ],
    })).resolves.not.toThrow()
  })

  test('should handle missing failed details', async () => {
    // cronLogger is mocked — verify the function completes without throwing
    await expect(sendScrapeSummaryAlert({
      totalPlatforms: 5,
      successPlatforms: 3,
      failedPlatforms: 2,
      totalScripts: 15,
      successScripts: 10,
      failedScripts: 5,
      duration: 60000,
    })).resolves.not.toThrow()
  })
})
