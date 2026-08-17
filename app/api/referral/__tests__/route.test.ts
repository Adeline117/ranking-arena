/** @jest-environment node */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mockGetAuthUser = jest.fn()
const mockGetSupabaseAdmin = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
}))

import {
  V1_REFERRAL_PROGRAM_NO_STORE_HEADERS,
  V1_REFERRAL_PROGRAM_UNAVAILABLE_BODY,
} from '@/lib/referral/v1-publication'
import { GET, POST } from '../route'

const handlers = [
  ['GET', GET],
  ['POST', POST],
] as const

function unreadableRequest() {
  return {
    json: jest.fn(() => {
      throw new Error('referral-program hold must not read a request body')
    }),
  } as never
}

function expectNoStore(response: Response): void {
  for (const [header, value] of Object.entries(V1_REFERRAL_PROGRAM_NO_STORE_HEADERS)) {
    expect(response.headers.get(header)).toBe(value)
  }
}

describe('/api/referral V1 hold', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it.each(handlers)('%s preserves anonymous 401 before body access', async (_method, handler) => {
    mockGetAuthUser.mockResolvedValue(null)
    const request = unreadableRequest()

    const response = await handler(request)

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(mockGetAuthUser).toHaveBeenCalledWith(request)
    expect(request.json).not.toHaveBeenCalled()
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    expectNoStore(response)
  })

  it.each(handlers)(
    '%s returns fixed 410 after auth with no endpoint work',
    async (_method, handler) => {
      mockGetAuthUser.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111' })
      const request = unreadableRequest()

      const response = await handler(request)

      expect(response.status).toBe(410)
      await expect(response.json()).resolves.toEqual(V1_REFERRAL_PROGRAM_UNAVAILABLE_BODY)
      expect(mockGetAuthUser).toHaveBeenCalledWith(request)
      expect(request.json).not.toHaveBeenCalled()
      expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
      expectNoStore(response)
    }
  )

  it('keeps code generation, table access, middleware, and rate limiting out of both methods', () => {
    const source = readFileSync(join(process.cwd(), 'app/api/referral/route.ts'), 'utf8')

    expect(source).not.toContain('withAuth')
    expect(source).not.toContain('request.json')
    expect(source).not.toMatch(/csrf/i)
    expect(source).not.toContain('getSupabaseAdmin')
    expect(source).not.toMatch(/checkRateLimit|RateLimitPresets|randomBytes/)
    expect(source).not.toMatch(/\.from\(|\.insert\(|\.update\(/)
    expect(source).not.toContain('referral_code')
    expect(source).not.toContain('referred_by')
  })
})
