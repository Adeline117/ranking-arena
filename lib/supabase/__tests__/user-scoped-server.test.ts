const mockCreateClient = jest.fn(() => ({ from: jest.fn() }))

jest.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}))

import { createUserScopedServerClient } from '../user-scoped-server'

function request(authorization: string | null) {
  return {
    headers: new Headers(authorization ? { authorization } : {}),
  }
}

describe('createUserScopedServerClient', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-anon-key'
  })

  it('uses the anon key while forwarding the verified user bearer token', () => {
    const client = createUserScopedServerClient(request('Bearer user-jwt') as never)

    expect(client).toEqual({ from: expect.any(Function) })
    expect(mockCreateClient).toHaveBeenCalledWith(
      'https://project.supabase.co',
      'public-anon-key',
      expect.objectContaining({
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
        global: expect.objectContaining({
          headers: { Authorization: 'Bearer user-jwt' },
        }),
      })
    )
    expect(mockCreateClient.mock.calls[0][1]).not.toBe(process.env.SUPABASE_SERVICE_ROLE_KEY)
  })

  it('fails closed without a strict bearer token', () => {
    expect(() => createUserScopedServerClient(request(null) as never)).toThrow(
      'verified bearer token'
    )
    expect(() => createUserScopedServerClient(request('Basic token') as never)).toThrow(
      'verified bearer token'
    )
    expect(mockCreateClient).not.toHaveBeenCalled()
  })

  it('fails closed instead of falling back to placeholders or service_role', () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

    expect(() => createUserScopedServerClient(request('Bearer user-jwt') as never)).toThrow(
      'anonymous key'
    )
    expect(mockCreateClient).not.toHaveBeenCalled()
  })
})
