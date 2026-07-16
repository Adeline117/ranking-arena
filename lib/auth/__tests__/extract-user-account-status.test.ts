const mockAdminGetUser = jest.fn()
const mockCookieGetUser = jest.fn()
const mockGetUserAccountStatus = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({ auth: { getUser: mockAdminGetUser } })),
  getUserAccountStatus: (...args: unknown[]) => mockGetUserAccountStatus(...args),
}))

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({ auth: { getUser: mockCookieGetUser } })),
}))

import { extractUserFromRequest } from '../extract-user'

const originalEnv = process.env

function authResult(userId: string) {
  return { data: { user: { id: userId, aud: 'authenticated' } }, error: null }
}

describe('extractUserFromRequest application-account status', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_SUPABASE_URL: 'https://test.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
    }
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it('requires an active profile for bearer authentication', async () => {
    mockAdminGetUser.mockResolvedValue(authResult('bearer-user'))
    mockGetUserAccountStatus.mockResolvedValue('active')

    const result = await extractUserFromRequest(
      new Request('https://example.com/api/test', {
        headers: { authorization: 'Bearer valid-token' },
      })
    )

    expect(result.user).toMatchObject({ id: 'bearer-user' })
    expect(result.error).toBeNull()
    expect(mockGetUserAccountStatus).toHaveBeenCalledWith('bearer-user')
  })

  it.each([
    ['suspended', 'Account suspended'],
    ['missing', 'Application profile is not provisioned'],
    ['unavailable', 'Account status verification unavailable'],
  ])('fails closed for bearer profile status %s', async (status, expectedError) => {
    mockAdminGetUser.mockResolvedValue(authResult(`bearer-${status}`))
    mockGetUserAccountStatus.mockResolvedValue(status)

    const result = await extractUserFromRequest(
      new Request('https://example.com/api/test', {
        headers: { authorization: 'Bearer valid-token' },
      })
    )

    expect(result).toEqual({ user: null, error: expectedError })
  })

  it('applies the same suspended-account gate to cookie authentication', async () => {
    mockCookieGetUser.mockResolvedValue(authResult('cookie-user'))
    mockGetUserAccountStatus.mockResolvedValue('suspended')

    const result = await extractUserFromRequest(
      new Request('https://example.com/api/test', {
        headers: { cookie: 'sb-access-token=session' },
      })
    )

    expect(result).toEqual({ user: null, error: 'Account suspended' })
    expect(mockGetUserAccountStatus).toHaveBeenCalledWith('cookie-user')
  })

  it('returns an active cookie-authenticated user', async () => {
    mockCookieGetUser.mockResolvedValue(authResult('active-cookie-user'))
    mockGetUserAccountStatus.mockResolvedValue('active')

    const result = await extractUserFromRequest(
      new Request('https://example.com/api/test', {
        headers: { cookie: 'sb-access-token=session' },
      })
    )

    expect(result.user).toMatchObject({ id: 'active-cookie-user' })
    expect(result.error).toBeNull()
  })
})
