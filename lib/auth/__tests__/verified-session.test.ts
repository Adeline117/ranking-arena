import type { Session, SupabaseClient, User } from '@supabase/supabase-js'
import {
  assertVerifiedSessionSnapshotCurrent,
  getVerifiedSessionSnapshot,
  isVerifiedSessionSnapshotCurrent,
  verifySessionSnapshot,
  verifySessionUser,
} from '../verified-session'
import {
  __resetAuthOperationsForTests,
  beginAuthIdentityOperation,
} from '@/lib/auth/session-operation'
import { __resetViewerScopeForTests, synchronizeViewerScope } from '@/lib/auth/viewer-scope'

function session(userId = 'user-a'): Session {
  return {
    access_token: 'access-a',
    refresh_token: 'refresh-a',
    expires_in: 3600,
    token_type: 'bearer',
    user: { id: userId } as User,
  }
}

function clientWith(auth: {
  getSession?: jest.Mock
  getUser?: jest.Mock
}): Pick<SupabaseClient, 'auth'> {
  return {
    auth: {
      getSession: auth.getSession,
      getUser: auth.getUser,
    },
  } as unknown as Pick<SupabaseClient, 'auth'>
}

describe('verified session identity snapshot', () => {
  beforeEach(() => {
    __resetAuthOperationsForTests()
    __resetViewerScopeForTests()
    synchronizeViewerScope(true, 'user-a')
  })

  it('verifies the exact access token from the captured session', async () => {
    const captured = session()
    const verifiedUser = { id: 'user-a' } as User
    const getUser = jest.fn().mockResolvedValue({ data: { user: verifiedUser }, error: null })

    await expect(verifySessionUser(clientWith({ getUser }), captured)).resolves.toBe(verifiedUser)
    expect(getUser).toHaveBeenCalledWith('access-a')
  })

  it('rejects a verified token whose subject differs from the captured session', async () => {
    const getUser = jest
      .fn()
      .mockResolvedValue({ data: { user: { id: 'user-b' } as User }, error: null })

    await expect(verifySessionUser(clientWith({ getUser }), session('user-a'))).rejects.toThrow(
      'Authentication identity changed'
    )
  })

  it('rejects authentication errors and missing verified users', async () => {
    const authError = new Error('invalid token')
    await expect(
      verifySessionUser(
        clientWith({
          getUser: jest.fn().mockResolvedValue({ data: { user: null }, error: authError }),
        }),
        session()
      )
    ).rejects.toBe(authError)

    await expect(
      verifySessionUser(
        clientWith({ getUser: jest.fn().mockResolvedValue({ data: { user: null }, error: null }) }),
        session()
      )
    ).rejects.toThrow('Authentication identity changed')
  })

  it('captures one session and returns only its matching verified user', async () => {
    const captured = session()
    const verifiedUser = { id: 'user-a' } as User
    const client = clientWith({
      getSession: jest.fn().mockResolvedValue({ data: { session: captured }, error: null }),
      getUser: jest.fn().mockResolvedValue({ data: { user: verifiedUser }, error: null }),
    })

    await expect(getVerifiedSessionSnapshot(client)).resolves.toMatchObject({
      session: captured,
      user: verifiedUser,
    })
  })

  it('rejects a still-valid A token after a real A-to-B auth operation supersedes it', async () => {
    const captured = session('user-a')
    const client = clientWith({
      getSession: jest.fn().mockResolvedValue({ data: { session: captured }, error: null }),
      getUser: jest
        .fn()
        .mockResolvedValue({ data: { user: { id: 'user-a' } as User }, error: null }),
    })
    const snapshot = await getVerifiedSessionSnapshot(client)

    beginAuthIdentityOperation('user-b')
    synchronizeViewerScope(true, 'user-b')

    expect(isVerifiedSessionSnapshotCurrent(snapshot)).toBe(false)
    expect(() => assertVerifiedSessionSnapshotCurrent(snapshot)).toThrow(
      'Authentication operation was superseded'
    )
  })

  it('allows an OAuth callback to capture pending viewer state but still invalidates on a new op', async () => {
    __resetAuthOperationsForTests()
    __resetViewerScopeForTests()
    const captured = session('user-a')
    const client = clientWith({
      getUser: jest
        .fn()
        .mockResolvedValue({ data: { user: { id: 'user-a' } as User }, error: null }),
    })

    const snapshot = await verifySessionSnapshot(client, captured, { allowPendingViewer: true })
    expect(isVerifiedSessionSnapshotCurrent(snapshot)).toBe(true)

    beginAuthIdentityOperation('user-b')
    expect(isVerifiedSessionSnapshotCurrent(snapshot)).toBe(false)
  })

  it('fails closed when no session snapshot exists', async () => {
    const client = clientWith({
      getSession: jest.fn().mockResolvedValue({ data: { session: null }, error: null }),
      getUser: jest.fn(),
    })

    await expect(getVerifiedSessionSnapshot(client)).rejects.toThrow(
      'Session could not be verified'
    )
    expect(client.auth.getUser).not.toHaveBeenCalled()
  })
})
