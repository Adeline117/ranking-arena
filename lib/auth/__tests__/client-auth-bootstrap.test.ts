import { AuthSessionMissingError, type Session, type User } from '@supabase/supabase-js'
import { bootstrapClientAuth } from '../client-auth-bootstrap'

const user = { id: 'user-1' } as User
const session = {
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  expires_in: 3600,
  token_type: 'bearer',
  user,
} as Session

function authClient({
  getSession = jest.fn().mockResolvedValue({ data: { session }, error: null }),
  getUser = jest.fn().mockResolvedValue({ data: { user }, error: null }),
}: {
  getSession?: jest.Mock
  getUser?: jest.Mock
} = {}) {
  return { getSession, getUser }
}

describe('bootstrapClientAuth', () => {
  it('returns an authenticated result only after session and user checks succeed', async () => {
    await expect(bootstrapClientAuth(authClient())).resolves.toMatchObject({
      status: 'authenticated',
      user,
      session,
    })
  })

  it('fails closed when a restored session has no verified user', async () => {
    const auth = authClient({
      getUser: jest.fn().mockResolvedValue({ data: { user: null }, error: null }),
    })

    await expect(bootstrapClientAuth(auth)).resolves.toMatchObject({ status: 'error' })
  })

  it('classifies a confirmed missing session as signed out', async () => {
    const auth = authClient({
      getSession: jest.fn().mockResolvedValue({ data: { session: null }, error: null }),
      getUser: jest.fn().mockResolvedValue({
        data: { user: null },
        error: new AuthSessionMissingError(),
      }),
    })

    await expect(bootstrapClientAuth(auth)).resolves.toEqual({ status: 'signed-out' })
  })

  it.each([
    [
      'getSession rejection',
      authClient({ getSession: jest.fn().mockRejectedValue(new Error('network unavailable')) }),
    ],
    [
      'getSession error response',
      authClient({
        getSession: jest.fn().mockResolvedValue({
          data: { session: null },
          error: new Error('refresh failed'),
        }),
      }),
    ],
    [
      'getUser rejection',
      authClient({ getUser: jest.fn().mockRejectedValue(new Error('auth service unavailable')) }),
    ],
    [
      'getUser error response',
      authClient({
        getUser: jest.fn().mockResolvedValue({
          data: { user: null },
          error: new Error('auth service unavailable'),
        }),
      }),
    ],
  ])('keeps %s distinct from signed out', async (_label, auth) => {
    await expect(bootstrapClientAuth(auth)).resolves.toMatchObject({ status: 'error' })
  })

  it('fails closed when session and verified user identities disagree', async () => {
    const auth = authClient({
      getUser: jest.fn().mockResolvedValue({
        data: { user: { ...user, id: 'user-2' } },
        error: null,
      }),
    })

    await expect(bootstrapClientAuth(auth)).resolves.toMatchObject({ status: 'error' })
  })
})
