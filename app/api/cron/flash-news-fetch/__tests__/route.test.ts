/**
 * Cron: flash-news-fetch route tests
 * Tests auth, RSS fetching, deduplication, and error handling.
 *
 * @jest-environment node
 */

// Set env before imports so module-level const CRON_SECRET captures it
process.env.CRON_SECRET = 'test-secret'
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://supabase.test'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'

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

import { NextRequest } from 'next/server'
import { GET } from '../route'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCronRequest(secret?: string): NextRequest {
  const headers = new Headers()
  if (secret) headers.set('authorization', `Bearer ${secret}`)
  return new NextRequest('http://localhost:3000/api/cron/flash-news-fetch', { headers })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/cron/flash-news-fetch', () => {
  const CRON_SECRET = 'test-secret'

  // env already set at top of file for module-level capture

  beforeEach(() => {
    jest.clearAllMocks()
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
          insert: jest.fn().mockReturnValue({
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
    mockFetch.mockRejectedValue(new Error('Network error'))

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.inserted).toBe(0)
  })
})
