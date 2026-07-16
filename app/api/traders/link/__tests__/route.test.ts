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

import { DELETE, GET, POST } from '../route'

const request = {} as NextRequest

describe('/api/traders/link retirement boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111' })
  })

  it.each([
    ['POST', POST],
    ['GET', GET],
    ['DELETE', DELETE],
  ])('returns an explicit authenticated 410 for %s', async (_method, handler) => {
    const response = await handler(request)

    expect(response.status).toBe(410)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('Deprecation')).toBe('true')
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'The legacy trader-link endpoint has been retired.',
      code: 'TRADER_LINK_ENDPOINT_RETIRED',
      replacements: {
        claim: '/api/traders/claim',
        manage: '/api/traders/linked',
      },
    })
  })

  it('keeps the retired endpoint authenticated', async () => {
    mockGetAuthUser.mockResolvedValue(null)

    const response = await POST(request)

    expect(response.status).toBe(401)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Unauthorized',
    })
  })

  it('contains no legacy database or request-body write path', () => {
    const source = readFileSync(join(process.cwd(), 'app/api/traders/link/route.ts'), 'utf8')

    expect(source).not.toContain('getSupabaseAdmin')
    expect(source).not.toContain('.from(')
    expect(source).not.toContain('request.json')
    expect(source).not.toContain('req.json')
    expect(source).toContain("'Cache-Control': 'private, no-store'")
    expect(source).toContain("Deprecation: 'true'")
    expect(source).toContain('rel="successor-version"')
  })
})
