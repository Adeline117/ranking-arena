jest.mock('next/server', () => {
  class MockNextResponse {
    readonly status: number
    readonly headers: Headers
    private readonly body: unknown

    constructor(body: unknown, init: { status?: number; headers?: HeadersInit } = {}) {
      this.body = body
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    static json(body: unknown, init?: { status?: number; headers?: HeadersInit }) {
      return new MockNextResponse(body, init)
    }

    async json() {
      return this.body
    }
  }

  class MockNextRequest {
    readonly nextUrl: URL
    readonly headers: Headers
    readonly method = 'GET'
    readonly cookies = { get: () => undefined }

    constructor(readonly url: string) {
      this.nextUrl = new URL(url)
      this.headers = new Headers({ 'user-agent': 'Mozilla/5.0 (Jest Route Contract)' })
    }
  }

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

jest.mock('next/cache', () => ({
  unstable_cache: (loader: () => Promise<unknown>) => loader,
}))

const mockSupabase = { marker: 'first-screen-contract-client' }

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: jest.fn().mockResolvedValue(null),
  getSupabaseAdmin: jest.fn(() => mockSupabase),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimitFull: jest.fn().mockResolvedValue({ response: null, meta: null }),
  addRateLimitHeaders: jest.fn(),
  RateLimitPresets: { public: {} },
}))

jest.mock('@/lib/utils/csrf', () => ({
  validateCsrfToken: jest.fn().mockReturnValue(true),
  CSRF_COOKIE_NAME: 'csrf-token',
  CSRF_HEADER_NAME: 'x-csrf-token',
}))

jest.mock('@/lib/api/correlation', () => ({
  getOrCreateCorrelationId: jest.fn().mockReturnValue('first-screen-contract-cid'),
  runWithCorrelationId: jest.fn((_id: string, run: () => unknown) => run()),
}))

jest.mock('@/lib/api/versioning', () => ({
  parseApiVersion: jest.fn().mockReturnValue({ version: 'v1', deprecated: false }),
  addVersionHeaders: jest.fn(),
  addDeprecationHeaders: jest.fn(),
}))

jest.mock('@sentry/nextjs', () => ({
  setUser: jest.fn(),
  setTag: jest.fn(),
}))

jest.mock('@/lib/utils/logger', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }
  return {
    createLogger: jest.fn(() => logger),
    logger,
    fireAndForget: jest.fn(),
    captureError: jest.fn(),
    captureMessage: jest.fn(),
  }
})

jest.mock('@/lib/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

const mockGetDataMode = jest.fn()
jest.mock('@/lib/constants/serving-cutover', () => ({
  getDataMode: (...args: unknown[]) => mockGetDataMode(...args),
}))

const mockResolveServingTrader = jest.fn()
jest.mock('@/lib/data/serving/resolve', () => ({
  resolveServingTrader: (...args: unknown[]) => mockResolveServingTrader(...args),
}))

const mockGetPublicFirstScreen = jest.fn()
jest.mock('@/lib/data/serving/first-screen', () => ({
  getPublicFirstScreen: (...args: unknown[]) => mockGetPublicFirstScreen(...args),
}))

const mockGetSourceCapabilities = jest.fn()
jest.mock('@/lib/data/serving/capabilities', () => ({
  getSourceCapabilities: (...args: unknown[]) => mockGetSourceCapabilities(...args),
}))

jest.mock('@/lib/supabase/read-replica', () => ({
  getReadReplica: jest.fn(() => ({ marker: 'read-replica' })),
}))

const mockGetVerifiedTraderKeys = jest.fn()
jest.mock('@/lib/data/verified-traders', () => ({
  getVerifiedTraderKeys: (...args: unknown[]) => mockGetVerifiedTraderKeys(...args),
  verifiedTraderKey: (source: string, exchangeTraderId: string) => `${source}:${exchangeTraderId}`,
}))

jest.mock('@/lib/utils/avatar', () => ({
  getTraderAvatarSrc: jest.fn().mockReturnValue(null),
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

function expectMetricAuthorityNoStore(response: { headers: Headers }) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
  expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
  expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
}

describe('GET /api/traders/[handle]/first-screen boundary contract', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetDataMode.mockResolvedValue('serving')
    mockResolveServingTrader.mockResolvedValue(null)
    mockGetPublicFirstScreen.mockResolvedValue(null)
    mockGetSourceCapabilities.mockResolvedValue({})
    mockGetVerifiedTraderKeys.mockResolvedValue(new Set<string>())
  })

  it('returns a request-bound proof and complete no-store headers for a legacy source', async () => {
    mockGetDataMode.mockResolvedValueOnce('legacy')

    const response = await GET(
      new NextRequest('http://localhost/api/traders/Trader%20One/first-screen?source=bitunix'),
      { params: Promise.resolve({ handle: 'Trader%20One' }) }
    )
    const body = await response.json()

    expect(response.status).toBe(404)
    expectMetricAuthorityNoStore(response)
    expect(body).toMatchObject({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Source does not publish a serving first screen',
        details: {
          reason: 'source_not_serving',
          request: { platform: 'bitunix', handle: 'Trader One' },
        },
      },
    })
    expect(mockResolveServingTrader).not.toHaveBeenCalled()
  })

  it('returns a generic 404 without legacy fallback proof for a serving resolver miss', async () => {
    const response = await GET(
      new NextRequest('http://localhost/api/traders/missing/first-screen?source=okx_futures'),
      { params: Promise.resolve({ handle: 'missing' }) }
    )
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body).toEqual({ success: false, error: 'Trader not found' })
    expect(JSON.stringify(body)).not.toContain('source_not_serving')
    expect(JSON.stringify(body)).not.toContain('"request"')
    expect(mockResolveServingTrader).toHaveBeenCalledWith(mockSupabase, {
      handle: 'missing',
      source: 'okx_futures',
    })
  })

  it('echoes the requested alias while publishing the canonical resolved subject', async () => {
    mockResolveServingTrader.mockResolvedValueOnce({
      source: 'bitunix_futures',
      exchangeTraderId: 'canonical-account-id',
      nickname: 'Alias Trader',
      avatarMirrorUrl: null,
      avatarOriginUrl: null,
    })
    mockGetPublicFirstScreen.mockResolvedValueOnce({
      source: 'bitunix_futures',
      exchangeTraderId: 'canonical-account-id',
      nickname: 'Alias Trader',
      avatarMirrorUrl: null,
      avatarOriginUrl: null,
      avatarSrc: null,
      walletAddress: null,
      traderKind: 'human',
      botStrategy: null,
      entries: [],
    })
    mockGetSourceCapabilities.mockResolvedValueOnce({
      bitunix_futures: {
        timeframes: { '7': 'native', '30': 'native', '90': 'native' },
        inceptionTf: false,
        metrics: ['roi'],
        surfaces: {
          positions: false,
          position_history: true,
          orders: false,
          transfers: false,
          copiers: false,
        },
        copierDepth: 'none',
        currency: 'USDT',
        isOnchain: false,
        derivedBoardNote: false,
        exchangeName: 'Bitunix',
      },
    })

    const response = await GET(
      new NextRequest('http://localhost/api/traders/Alias%20Trader/first-screen?source=bitunix'),
      { params: Promise.resolve({ handle: 'Alias%20Trader' }) }
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expectMetricAuthorityNoStore(response)
    expect(body).toMatchObject({
      success: true,
      data: {
        request: { platform: 'bitunix', handle: 'Alias Trader' },
        subject: { platform: 'bitunix_futures', traderKey: 'canonical-account-id' },
        firstScreen: {
          source: 'bitunix_futures',
          exchangeTraderId: 'canonical-account-id',
        },
        capability: { exchangeName: 'Bitunix' },
        is_verified_data: false,
      },
    })
    expect(mockResolveServingTrader).toHaveBeenCalledWith(mockSupabase, {
      handle: 'Alias Trader',
      source: 'bitunix',
    })
    expect(mockGetPublicFirstScreen).toHaveBeenCalledWith(
      mockSupabase,
      'bitunix_futures',
      'canonical-account-id',
      // The public cohort is keyed by the alias the request named.
      'bitunix'
    )
  })
})
