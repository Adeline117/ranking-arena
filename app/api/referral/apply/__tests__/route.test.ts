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
import { POST } from '../route'

function unreadableRequest() {
  return {
    json: jest.fn(() => {
      throw new Error('referral hold must not read a request body')
    }),
  } as never
}

function expectNoStore(response: Response): void {
  for (const [header, value] of Object.entries(V1_REFERRAL_PROGRAM_NO_STORE_HEADERS)) {
    expect(response.headers.get(header)).toBe(value)
  }
}

describe('POST /api/referral/apply V1 hold', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('keeps the anonymous response authentication-first and leaves the body unread', async () => {
    mockGetAuthUser.mockResolvedValue(null)
    const request = unreadableRequest()

    const response = await POST(request)

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(mockGetAuthUser).toHaveBeenCalledWith(request)
    expect(request.json).not.toHaveBeenCalled()
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    expectNoStore(response)
  })

  it('returns a fixed no-store 410 after authentication without body or referral access', async () => {
    mockGetAuthUser.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111' })
    const request = unreadableRequest()

    const response = await POST(request)

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toEqual(V1_REFERRAL_PROGRAM_UNAVAILABLE_BODY)
    expect(mockGetAuthUser).toHaveBeenCalledWith(request)
    expect(request.json).not.toHaveBeenCalled()
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    expectNoStore(response)
  })

  it('fails closed to the same anonymous response when authentication verification rejects', async () => {
    mockGetAuthUser.mockRejectedValue(new Error('auth unavailable'))
    const request = unreadableRequest()

    const response = await POST(request)

    expect(response.status).toBe(401)
    expect(request.json).not.toHaveBeenCalled()
    expectNoStore(response)
  })

  it('keeps middleware, body, rate-limit, and referral table capabilities out of the route', () => {
    const source = readFileSync(join(process.cwd(), 'app/api/referral/apply/route.ts'), 'utf8')

    expect(source).not.toContain('withAuth')
    expect(source).not.toContain('request.json')
    expect(source).not.toMatch(/csrf/i)
    expect(source).not.toContain('getSupabaseAdmin')
    expect(source).not.toMatch(/checkRateLimit|RateLimitPresets|getIdentifier/)
    expect(source).not.toMatch(/\.from\(|\.insert\(|\.update\(/)
    expect(source).not.toContain('referred_by')
    expect(source).not.toContain('referral_attributions')
  })
})
