import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NextRequest } from 'next/server'

const mockGetAuthUser = jest.fn()

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) => ({
      status: init.status ?? 200,
      headers: new Map(Object.entries(init.headers ?? {})),
      json: async () => body,
    }),
  },
}))

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
}))

import { POST } from '../route'

describe('/api/traders/claim/verify-wallet retirement boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111' })
  })

  it('returns an authenticated, non-cacheable 410 with the atomic replacement', async () => {
    const json = jest.fn().mockRejectedValue(new Error('body must never be read'))
    const response = await POST({ json } as unknown as NextRequest)

    expect(response.status).toBe(410)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('Deprecation')).toBe('true')
    expect(response.headers.get('Link')).toBe('</api/traders/claim>; rel="successor-version"')
    expect(json).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Wallet proof verification now happens inside the trader claim request.',
      code: 'WALLET_VERIFICATION_ENDPOINT_RETIRED',
      replacement: '/api/traders/claim',
    })
  })

  it('keeps the tombstone authenticated', async () => {
    mockGetAuthUser.mockResolvedValue(null)

    const response = await POST({} as NextRequest)

    expect(response.status).toBe(401)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Unauthorized',
    })
  })

  it('contains no proof consumption, request body, or admin database path', () => {
    const routeSource = readFileSync(
      join(process.cwd(), 'app/api/traders/claim/verify-wallet/route.ts'),
      'utf8'
    )

    expect(routeSource).not.toContain('verifyWalletOwnership')
    expect(routeSource).not.toContain('getSupabaseAdmin')
    expect(routeSource).not.toContain('request.json')
    expect(routeSource).not.toContain('.from(')
    expect(routeSource).toContain("'Cache-Control': 'private, no-store'")
    expect(routeSource).toContain("Deprecation: 'true'")
    expect(routeSource).toContain('rel="successor-version"')
  })
})
