import { existsSync, readFileSync } from 'node:fs'
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

describe('/api/trader/bind-wallet retirement boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111' })
  })

  it('returns an authenticated 410 with reviewed claim replacements', async () => {
    const json = jest.fn().mockRejectedValue(new Error('body must never be read'))
    const response = await POST({ json } as unknown as NextRequest)

    expect(response.status).toBe(410)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('Deprecation')).toBe('true')
    expect(response.headers.get('Link')).toContain('</api/traders/claim>')
    expect(json).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'The legacy wallet-binding endpoint has been retired.',
      code: 'TRADER_BIND_WALLET_ENDPOINT_RETIRED',
      replacements: {
        claim: '/api/traders/claim',
        manage: '/api/traders/linked',
      },
    })
  })

  it('keeps the tombstone authenticated and non-cacheable', async () => {
    mockGetAuthUser.mockResolvedValue(null)

    const response = await POST({} as NextRequest)

    expect(response.status).toBe(401)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Unauthorized',
    })
  })

  it('contains no body, admin database, or direct authorization write path', () => {
    const routeSource = readFileSync(
      join(process.cwd(), 'app/api/trader/bind-wallet/route.ts'),
      'utf8'
    )

    expect(routeSource).not.toContain('getSupabaseAdmin')
    expect(routeSource).not.toContain('request.json')
    expect(routeSource).not.toContain('.from(')
    expect(routeSource).not.toContain('bindWallet')
    expect(routeSource).toContain("'Cache-Control': 'private, no-store'")
    expect(routeSource).toContain("Deprecation: 'true'")
    expect(existsSync(join(process.cwd(), 'lib/services/wallet-binder.ts'))).toBe(false)
  })
})
