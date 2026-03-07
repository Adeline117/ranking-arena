/**
 * Cron: flash-news-fetch route tests
 * Tests auth, RSS fetching, deduplication, and error handling.
 *
 * @jest-environment node
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFrom = jest.fn()

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({ from: mockFrom })),
}))

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

// Mock global fetch for RSS API
const mockFetch = jest.fn()
global.fetch = mockFetch

// ---------------------------------------------------------------------------
// We must dynamically import the route because it captures CRON_SECRET at
// module level. Set env vars then use dynamic import.
// ---------------------------------------------------------------------------

let GET: typeof import('../route').GET
let NextRequest: typeof import('next/server').NextRequest

async function loadRoute() {
  // Reset module registry so the route re-reads CRON_SECRET
  jest.resetModules()
  // Re-apply mocks after resetModules
  jest.mock('@supabase/supabase-js', () => ({
    createClient: jest.fn(() => ({ from: mockFrom })),
  }))
  jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  }))
  jest.mock('@/lib/services/pipeline-logger', () => ({
    PipelineLogger: {
      start: jest.fn().mockResolvedValue({
        success: jest.fn().mockResolvedValue(undefined),
        error: jest.fn().mockResolvedValue(undefined),
        timeout: jest.fn().mockResolvedValue(undefined),
      }),
    },
  }))
  global.fetch = mockFetch

  const mod = await import('../route')
  GET = mod.GET

  // Import NextRequest after mocks are set up
  const { NextRequest: NR } = await import('next/server')
  NextRequest = NR
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCronRequest(secret?: string) {
  const headers = new Headers()
  if (secret) headers.set('authorization', `Bearer ${secret}`)
  return new NextRequest('http://localhost:3000/api/cron/flash-news-fetch', { headers })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/cron/flash-news-fetch', () => {
  const CRON_SECRET = 'test-secret'

  beforeAll(async () => {
    process.env.CRON_SECRET = CRON_SECRET
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://supabase.test'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
    await loadRoute()
  })

  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = mockFetch
  })

  // ---- Auth ----------------------------------------------------------------

  it('returns 401 when CRON_SECRET does not match', async () => {
    const res = await GET(createCronRequest('wrong'))
    expect(res.status).toBe(401)
  })

  // ---- Successful execution ------------------------------------------------

  it('fetches RSS feeds and inserts new items', async () => {
    const rssResponse = {
      status: 'ok',
      items: [
        {
          title: 'BTC Hits New High',
          description: '<p>Bitcoin surges past $100k</p>',
          link: 'https://example.com/btc',
          pubDate: new Date().toISOString(),
        },
      ],
    }

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(rssResponse),
    })

    mockFrom.mockImplementation((table: string) => {
      if (table === 'flash_news') {
        return {
          select: jest.fn().mockReturnValue({
            gte: jest.fn().mockResolvedValue({ data: [], error: null }),
          }),
          upsert: jest.fn().mockReturnValue({
            select: jest.fn().mockResolvedValue({
              data: [{ id: '1' }],
              error: null,
            }),
          }),
        }
      }
      return {}
    })

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.inserted).toBeGreaterThanOrEqual(1)
  })

  it('deduplicates against existing titles', async () => {
    const rssResponse = {
      status: 'ok',
      items: [
        { title: 'Existing News', description: 'Already in DB', link: 'https://test.com', pubDate: new Date().toISOString() },
      ],
    }

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(rssResponse),
    })

    mockFrom.mockImplementation((table: string) => {
      if (table === 'flash_news') {
        return {
          select: jest.fn().mockReturnValue({
            gte: jest.fn().mockResolvedValue({
              data: [{ title: 'Existing News' }],
              error: null,
            }),
          }),
        }
      }
      return {}
    })

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.inserted).toBe(0)
    expect(body.message).toBe('All items already exist')
  })

  // ---- No items fetched ----------------------------------------------------

  it('handles empty RSS feeds', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'ok', items: [] }),
    })

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.inserted).toBe(0)
  })

  // ---- Error handling ------------------------------------------------------

  it('returns 500 when database insert fails', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: 'ok',
        items: [{ title: 'Test', description: 'test', link: 'https://test.com', pubDate: new Date().toISOString() }],
      }),
    })

    mockFrom.mockImplementation((table: string) => {
      if (table === 'flash_news') {
        return {
          select: jest.fn().mockReturnValue({
            gte: jest.fn().mockResolvedValue({ data: [], error: null }),
          }),
          insert: jest.fn().mockReturnValue({
            select: jest.fn().mockResolvedValue({
              data: null,
              error: { message: 'Insert failed' },
            }),
          }),
        }
      }
      return {}
    })

    const res = await GET(createCronRequest(CRON_SECRET))
    expect(res.status).toBe(500)
  })

  it('handles fetch errors from RSS feeds gracefully', async () => {
    // All RSS feeds fail, so allItems is empty -> returns "No items fetched"
    mockFetch.mockRejectedValue(new Error('Network error'))

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.inserted).toBe(0)
  })
})
