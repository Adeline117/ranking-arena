/** @jest-environment node */

const mockGetAuthUser = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
}))

import type { NextRequest } from 'next/server'
import { getOptionalAuthUser } from '../optional-auth'

function request(authorization?: string): NextRequest {
  return {
    headers: new Headers(authorization === undefined ? {} : { authorization }),
  } as NextRequest
}

describe('getOptionalAuthUser', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('keeps a request with no credentials anonymous without an auth round trip', async () => {
    await expect(getOptionalAuthUser(request())).resolves.toBeNull()
    expect(mockGetAuthUser).not.toHaveBeenCalled()
  })

  it('returns the exact verified viewer when credentials are valid', async () => {
    const viewer = { id: 'viewer-1' }
    mockGetAuthUser.mockResolvedValue(viewer)

    await expect(getOptionalAuthUser(request('Bearer valid'))).resolves.toBe(viewer)
  })

  it.each(['Bearer expired', '', 'Basic credentials'])(
    'rejects supplied but invalid credentials (%s) instead of downgrading to anonymous',
    async (authorization) => {
      mockGetAuthUser.mockResolvedValue(null)

      await expect(getOptionalAuthUser(request(authorization))).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
        statusCode: 401,
      })
    }
  )
})
