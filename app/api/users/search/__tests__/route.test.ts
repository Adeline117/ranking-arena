/** @jest-environment node */

const mockGetAuthUser = jest.fn()
const mockIlike = jest.fn()
let rows: unknown[] = []
let queryError: { message: string } | null = null

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getSupabaseAdmin: () => ({
    from: () => {
      const builder: Record<string, unknown> = {}
      builder.select = () => builder
      builder.ilike = (...args: unknown[]) => {
        mockIlike(...args)
        return builder
      }
      builder.neq = () => builder
      builder.is = () => builder
      builder.limit = async () => ({ data: queryError ? null : rows, error: queryError })
      return builder
    },
  }),
}))
jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { search: {} },
}))
jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

const search = (q: string) =>
  GET(new NextRequest(`http://localhost/api/users/search?q=${encodeURIComponent(q)}&limit=5`))
const profile = (id: string, handle: string, extra: Record<string, unknown> = {}) => ({
  id,
  handle,
  avatar_url: null,
  deleted_at: null,
  banned_at: null,
  is_banned: false,
  ban_expires_at: null,
  ...extra,
})

describe('GET /api/users/search', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue({ id: 'me' })
    rows = [profile('u1', 'john.doe')]
    queryError = null
  })

  it('requires authentication', async () => {
    mockGetAuthUser.mockResolvedValue(null)

    expect((await search('john')).status).toBe(401)
  })

  it('keeps the dot so a dotted handle can be found', async () => {
    const body = await (await search('john.d')).json()

    expect(mockIlike).toHaveBeenCalledWith('handle', '%john.d%')
    expect(body.users).toEqual([{ id: 'u1', handle: 'john.doe', avatar_url: null }])
  })

  it('does not let the caller inject wildcards', async () => {
    await search('*%_')

    expect(mockIlike).toHaveBeenCalledWith('handle', '%\\%\\_%')
  })

  it('returns only public fields and drops currently banned profiles', async () => {
    rows = [profile('u1', 'ok'), profile('u2', 'banned', { is_banned: true })]

    const body = await (await search('a')).json()

    expect(body.users).toEqual([{ id: 'u1', handle: 'ok', avatar_url: null }])
  })

  it('answers an empty query without touching the database, and a DB failure with 500', async () => {
    await expect((await search('   ')).json()).resolves.toEqual({ users: [] })
    expect(mockIlike).not.toHaveBeenCalled()

    queryError = { message: 'db down' }
    expect((await search('john')).status).toBe(500)
  })
})
