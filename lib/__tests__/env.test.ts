/**
 * lib/env.ts 环境变量验证测试
 * 
 * 测试 getEnv, getEnvBool, getEnvNumber 的行为
 * 由于 env.ts 在 import 时立即执行验证，需要使用动态 import + env mock
 */

describe('env module', () => {
  const originalEnv = process.env

  beforeEach(() => {
    jest.resetModules()
    process.env = {
      ...originalEnv,
      // Minimum required vars
      NEXT_PUBLIC_SUPABASE_URL: 'https://test.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
      NODE_ENV: 'development',
    }
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it('should throw when required NEXT_PUBLIC_SUPABASE_URL is missing', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL

    await expect(async () => {
      await import('../env')
    }).rejects.toThrow('Missing required environment variable: NEXT_PUBLIC_SUPABASE_URL')
  })

  it('should throw when required NEXT_PUBLIC_SUPABASE_ANON_KEY is missing', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

    await expect(async () => {
      await import('../env')
    }).rejects.toThrow('Missing required environment variable: NEXT_PUBLIC_SUPABASE_ANON_KEY')
  })

  it('should load successfully with minimum required vars', async () => {
    const { env } = await import('../env')
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe('https://test.supabase.co')
    expect(env.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe('test-anon-key')
  })

  it('should use fallback for optional vars', async () => {
    const { env } = await import('../env')
    expect(env.NEXT_PUBLIC_APP_URL).toBe('http://localhost:3000')
    expect(env.NEXT_PUBLIC_SITE_URL).toBe('http://localhost:3000')
  })

  it('should correctly detect development mode', async () => {
    const { env } = await import('../env')
    expect(env.isDevelopment).toBe(true)
    expect(env.isProduction).toBe(false)
  })

  it('should correctly detect production mode', async () => {
    process.env.NODE_ENV = 'production'
    // In production, SUPABASE_URL and SERVICE_ROLE_KEY are required server-side
    process.env.SUPABASE_URL = 'https://prod.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'

    const { env } = await import('../env')
    expect(env.isProduction).toBe(true)
    expect(env.isDevelopment).toBe(false)
  })

  it('should parse boolean env vars', async () => {
    process.env.ENABLE_SMART_SCHEDULER = 'true'
    process.env.ENABLE_ANOMALY_DETECTION = '1'

    const { env } = await import('../env')
    expect(env.ENABLE_SMART_SCHEDULER).toBe(true)
    expect(env.ENABLE_ANOMALY_DETECTION).toBe(true)
  })

  it('should default boolean env vars to false', async () => {
    delete process.env.ENABLE_SMART_SCHEDULER

    const { env } = await import('../env')
    expect(env.ENABLE_SMART_SCHEDULER).toBe(false)
  })

  it('should parse numeric env vars', async () => {
    process.env.WORKER_BATCH_SIZE = '25'
    process.env.WORKER_POLL_INTERVAL = '30000'

    const { env } = await import('../env')
    expect(env.WORKER_BATCH_SIZE).toBe(25)
    expect(env.WORKER_POLL_INTERVAL).toBe(30000)
  })

  it('should use fallback for invalid numeric env vars', async () => {
    process.env.WORKER_BATCH_SIZE = 'not-a-number'

    const { env } = await import('../env')
    expect(env.WORKER_BATCH_SIZE).toBe(10) // default fallback
  })

  it('should use fallback for missing numeric env vars', async () => {
    delete process.env.WORKER_BATCH_SIZE

    const { env } = await import('../env')
    expect(env.WORKER_BATCH_SIZE).toBe(10)
  })

  it('should handle optional server-only vars as undefined when not set', async () => {
    const { env } = await import('../env')
    expect(env.STRIPE_SECRET_KEY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.ADMIN_SECRET).toBeUndefined()
  })

  it('should read server-only vars when provided', async () => {
    process.env.ADMIN_SECRET = 'my-secret'
    process.env.CRON_SECRET = 'cron-secret'

    const { env } = await import('../env')
    expect(env.ADMIN_SECRET).toBe('my-secret')
    expect(env.CRON_SECRET).toBe('cron-secret')
  })
})
