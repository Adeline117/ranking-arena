jest.mock('next/server', () => {
  class HeaderBag {
    private readonly values = new Map<string, string>()

    constructor(initial?: HeadersInit) {
      if (!initial) return
      for (const [name, value] of Object.entries(initial as Record<string, string>)) {
        this.set(name, value)
      }
    }

    get(name: string) {
      return this.values.get(name.toLowerCase()) ?? null
    }

    set(name: string, value: string) {
      this.values.set(name.toLowerCase(), String(value))
    }
  }

  class MockNextResponse {
    status: number
    headers: HeaderBag

    constructor(
      private readonly body: unknown,
      init: { status?: number; headers?: HeadersInit } = {}
    ) {
      this.status = init.status ?? 200
      this.headers = new HeaderBag(init.headers)
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number; headers?: HeadersInit }) {
      return new MockNextResponse(body, init)
    }
  }

  class MockNextRequest {
    headers: HeaderBag
    cookies: { get: (name: string) => { value: string } | undefined }
    private readonly body: string | undefined

    constructor(
      _url: string,
      init: { headers?: HeadersInit; body?: string; method?: string } = {}
    ) {
      this.headers = new HeaderBag(init.headers)
      this.body = init.body
      this.cookies = {
        get: (name: string) => {
          const match = this.headers
            .get('cookie')
            ?.split(';')
            .map((part) => part.trim().split('='))
            .find(([key]) => key === name)
          return match ? { value: match.slice(1).join('=') } : undefined
        },
      }
    }

    async json() {
      return JSON.parse(this.body ?? '')
    }
  }

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

import { NextRequest } from 'next/server'

const mockGetAuthUser = jest.fn()
const mockGetSupabaseAdmin = jest.fn()
const mockCheckRateLimit = jest.fn()
const mockValidateCsrfToken = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
}))
jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { authenticated: { name: 'authenticated' }, write: { name: 'write' } },
}))
jest.mock('@/lib/utils/csrf', () => ({
  validateCsrfToken: (...args: unknown[]) => mockValidateCsrfToken(...args),
  CSRF_COOKIE_NAME: 'csrf-token',
  CSRF_HEADER_NAME: 'x-csrf-token',
}))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }),
}))

import { GET, POST } from '../route'

const OWNER = '11111111-1111-4111-8111-111111111111'
const REWARD = '22222222-2222-4222-8222-222222222222'
const GRANT = '33333333-3333-4333-8333-333333333333'
const ATTRIBUTION_A = '44444444-4444-4444-8444-444444444444'
const ATTRIBUTION_B = '55555555-5555-4555-8555-555555555555'
const ATTRIBUTION_C = '66666666-6666-4666-8666-666666666666'
const CREATED_AT = '2026-08-03T10:00:00.000Z'
const GRANTED_AT = '2026-08-03T11:00:00.000Z'

type DbResult = { data: unknown; error: { code?: string; message?: string } | null }

function query(result: DbResult) {
  const builder: Record<string, jest.Mock | ((resolve: (value: DbResult) => void) => void)> = {}
  for (const method of ['select', 'eq', 'not', 'order', 'limit', 'gt', 'update', 'is']) {
    builder[method] = jest.fn(() => builder)
  }
  builder.maybeSingle = jest.fn().mockResolvedValue(result)
  builder.single = jest.fn().mockResolvedValue(result)
  builder.then = (resolve: (value: DbResult) => void) => Promise.resolve(result).then(resolve)
  return builder as Record<string, jest.Mock> & PromiseLike<DbResult>
}

function pagedQuery(results: DbResult[]) {
  let page = 0
  const builder: Record<string, jest.Mock | ((...args: unknown[]) => Promise<unknown>)> = {}
  for (const method of ['select', 'eq', 'not', 'order', 'limit', 'gt']) {
    builder[method] = jest.fn(() => builder)
  }
  builder.then = (resolve: (value: DbResult) => unknown, reject: (reason: unknown) => unknown) => {
    const result = results[page++] ?? { data: [], error: null }
    return Promise.resolve(result).then(resolve, reject)
  }
  return builder as Record<string, jest.Mock> & PromiseLike<DbResult>
}

function getRequest() {
  return new NextRequest('https://www.arenafi.org/api/referral', {
    headers: { Authorization: 'Bearer token' },
  })
}

function postRequest(body: unknown) {
  return new NextRequest('https://www.arenafi.org/api/referral', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer token',
      'Content-Type': 'application/json',
      'x-csrf-token': 'csrf',
      Cookie: 'csrf-token=csrf',
    },
    body: JSON.stringify(body),
  })
}

function profile(referralCode: string | null = 'ra_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') {
  return { id: OWNER, handle: 'owner_handle', referral_code: referralCode }
}

function reward(entitlementGrantedAt: string | null = GRANTED_AT) {
  return {
    id: REWARD,
    referrer_id: OWNER,
    reward_type: 'advocate_milestone',
    granted_days: 30,
    created_at: CREATED_AT,
    entitlement_granted_at: entitlementGrantedAt,
  }
}

function grant(overrides: Record<string, unknown> = {}) {
  return {
    id: GRANT,
    user_id: OWNER,
    source: 'referral',
    source_key: `advocate:${REWARD}`,
    grant_kind: 'days',
    granted_days: 30,
    granted_at: CREATED_AT,
    starts_at: '2026-01-01T10:00:00.000Z',
    expires_at: '2099-09-02T10:00:00.000Z',
    revoked_at: null,
    ...overrides,
  }
}

function installGetDb(options?: {
  profile?: DbResult
  attributions?: DbResult
  attributionPages?: DbResult[]
  reward?: DbResult
  grant?: DbResult
}) {
  const builders = {
    profile: query(options?.profile ?? { data: profile(), error: null }),
    attributions: options?.attributionPages
      ? pagedQuery(options.attributionPages)
      : query(
          options?.attributions ?? {
            data: [
              { id: ATTRIBUTION_A, signup_ip_hash: 'same-device' },
              { id: ATTRIBUTION_B, signup_ip_hash: 'same-device' },
              { id: ATTRIBUTION_C, signup_ip_hash: null },
            ],
            error: null,
          }
        ),
    reward: query(options?.reward ?? { data: reward(), error: null }),
    grant: query(options?.grant ?? { data: grant(), error: null }),
  }
  const from = jest.fn((table: string) => {
    if (table === 'user_profiles') return builders.profile
    if (table === 'referral_attributions') return builders.attributions
    if (table === 'referral_rewards') return builders.reward
    if (table === 'pro_entitlement_grants') return builders.grant
    throw new Error(`unexpected table ${table}`)
  })
  mockGetSupabaseAdmin.mockReturnValue({ from })
  return { ...builders, from }
}

describe('/api/referral reward authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue({ id: OWNER })
    mockCheckRateLimit.mockResolvedValue(null)
    mockValidateCsrfToken.mockReturnValue(true)
  })

  it('returns an exact no-store owner envelope using qualified distinct-device truth', async () => {
    const db = installGetDb()
    const response = await GET(getRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
    expect(body).toEqual({
      success: true,
      data: {
        referral: {
          owner_id: OWNER,
          referral_code: 'ra_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          referral_link: 'https://www.arenafi.org/?ref=ra_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          code_source: 'custom',
          qualified_referral_count: 2,
          advocate_reward: {
            reward_id: REWARD,
            status: 'active',
            granted_days: 30,
            entitlement_granted_at: GRANTED_AT,
            entitlement_starts_at: '2026-01-01T10:00:00.000Z',
            entitlement_expires_at: '2099-09-02T10:00:00.000Z',
            entitlement_revoked_at: null,
          },
        },
      },
      meta: { timestamp: expect.any(String) },
    })
    expect(db.attributions.not).toHaveBeenCalledWith('qualified_at', 'is', null)
    expect(db.attributions.eq).toHaveBeenCalledWith('referrer_id', OWNER)
    expect(db.from).not.toHaveBeenCalledWith('user_profiles.referred_by')
  })

  it('does not infer an unlocked reward from a threshold-sized count', async () => {
    installGetDb({
      attributions: {
        data: [
          { id: ATTRIBUTION_A, signup_ip_hash: 'device-a' },
          { id: ATTRIBUTION_B, signup_ip_hash: 'device-b' },
          { id: ATTRIBUTION_C, signup_ip_hash: 'device-c' },
        ],
        error: null,
      },
      reward: { data: null, error: null },
    })
    const response = await GET(getRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.referral.qualified_referral_count).toBe(3)
    expect(body.data.referral.advocate_reward).toEqual({
      reward_id: null,
      status: 'not_granted',
      granted_days: null,
      entitlement_granted_at: null,
      entitlement_starts_at: null,
      entitlement_expires_at: null,
      entitlement_revoked_at: null,
    })
  })

  it('fails closed instead of reporting zero when qualification authority errors', async () => {
    installGetDb({ attributions: { data: null, error: { code: '42P01' } } })
    const response = await GET(getRequest())
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to load referral data' })
  })

  it('keyset-pages beyond 500 qualified rows without truncating the count', async () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({
      id: `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
      signup_ip_hash: `device-${index}`,
    }))
    const db = installGetDb({
      attributionPages: [
        { data: rows.slice(0, 500), error: null },
        { data: rows.slice(500), error: null },
      ],
      reward: { data: null, error: null },
    })
    const response = await GET(getRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.referral.qualified_referral_count).toBe(501)
    expect(db.attributions.gt).toHaveBeenCalledWith('id', rows[499].id)
  })

  it('fails closed when a granted marker has no matching entitlement grant', async () => {
    installGetDb({ grant: { data: null, error: null } })
    const response = await GET(getRequest())
    expect(response.status).toBe(500)
  })

  it('fails closed when a pending marker contradicts an existing entitlement grant', async () => {
    installGetDb({ reward: { data: reward(null), error: null } })
    const response = await GET(getRequest())
    expect(response.status).toBe(500)
  })

  it.each([
    ['expired', { expires_at: '2026-02-01T10:00:00.000Z' }, { entitlement_revoked_at: null }],
    [
      'revoked',
      { revoked_at: '2026-08-03T11:30:00.000Z' },
      { entitlement_revoked_at: '2026-08-03T11:30:00.000Z' },
    ],
  ])(
    'reports a historically granted but currently %s entitlement truthfully',
    async (status, overrides, expected) => {
      installGetDb({ grant: { data: grant(overrides), error: null } })
      const response = await GET(getRequest())
      const body = await response.json()
      expect(response.status).toBe(200)
      expect(body.data.referral.advocate_reward).toEqual(
        expect.objectContaining({ status, ...expected })
      )
    }
  )

  it('does not issue a broken handle referral link outside apply syntax', async () => {
    installGetDb({ profile: { data: { ...profile(null), handle: '界' }, error: null } })
    const response = await GET(getRequest())
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.data.referral).toEqual(
      expect.objectContaining({ referral_code: null, referral_link: null, code_source: 'none' })
    )
  })
})

describe('POST /api/referral one-time code creation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue({ id: OWNER })
    mockCheckRateLimit.mockResolvedValue(null)
    mockValidateCsrfToken.mockReturnValue(true)
  })

  it('rejects expanded or malformed mutation bodies before touching storage', async () => {
    const from = jest.fn()
    mockGetSupabaseAdmin.mockReturnValue({ from })
    const response = await POST(postRequest({ action: 'create', regenerate: true }))
    expect(response.status).toBe(400)
    expect(from).not.toHaveBeenCalled()
  })

  it('requires CSRF before code creation', async () => {
    mockValidateCsrfToken.mockReturnValue(false)
    mockGetSupabaseAdmin.mockReturnValue({ from: jest.fn() })
    const response = await POST(postRequest({ action: 'create' }))
    expect(response.status).toBe(403)
  })

  it('atomically creates one permanent code and returns an exact owner/code receipt', async () => {
    let generatedCode = ''
    const mutation = query({ data: null, error: null })
    mutation.update.mockImplementation((value: { referral_code: string }) => {
      generatedCode = value.referral_code
      return mutation
    })
    mutation.single.mockImplementation(async () => ({
      data: { id: OWNER, referral_code: generatedCode },
      error: null,
    }))
    const from = jest.fn(() => mutation)
    mockGetSupabaseAdmin.mockReturnValue({ from })

    const response = await POST(postRequest({ action: 'create' }))
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(generatedCode).toMatch(/^ra_[0-9a-f]{32}$/)
    expect(mutation.eq).toHaveBeenCalledWith('id', OWNER)
    expect(mutation.is).toHaveBeenCalledWith('referral_code', null)
    expect(mutation.select).toHaveBeenCalledWith('id, referral_code')
    expect(mutation.single).toHaveBeenCalledTimes(1)
    expect(body).toEqual({
      success: true,
      data: {
        mutation: {
          action: 'create',
          owner_id: OWNER,
          referral_code: generatedCode,
          referral_link: `https://www.arenafi.org/?ref=${generatedCode}`,
          code_source: 'custom',
        },
      },
      meta: { timestamp: expect.any(String) },
    })
  })

  it('refuses to rotate an existing permanent code', async () => {
    const mutation = query({ data: null, error: { code: 'PGRST116' } })
    mockGetSupabaseAdmin.mockReturnValue({ from: jest.fn(() => mutation) })
    const response = await POST(postRequest({ action: 'create' }))
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'A permanent referral code already exists' })
  })
})
