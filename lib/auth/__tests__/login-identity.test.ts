import type { Session, SupabaseClient, User } from '@supabase/supabase-js'
import {
  assertExactLoginIdentityCurrent,
  exactSessionJsonRequest,
  isExactLoginIdentityCurrent,
  verifyExactLoginIdentity,
} from '../login-identity'
import {
  AUTH_STORAGE_KEY,
  __resetAuthOperationsForTests,
  beginAuthIdentityOperation,
  completeAuthIdentityOperation,
} from '../session-operation'
import { __resetViewerScopeForTests, synchronizeViewerScope } from '../viewer-scope'

function session(userId: string, token: string, refreshToken = `refresh-${token}`): Session {
  return {
    access_token: token,
    refresh_token: refreshToken,
    expires_in: 3600,
    token_type: 'bearer',
    user: { id: userId, email: `${userId}@example.test` } as User,
  }
}

function makeCurrent(value: Session): void {
  const operation = beginAuthIdentityOperation(value.user.id)
  completeAuthIdentityOperation(operation, value.user.id)
  window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(value))
  synchronizeViewerScope(true, value.user.id)
}

function clientFor(userId: string): Pick<SupabaseClient, 'auth'> {
  return {
    auth: {
      getUser: jest.fn().mockResolvedValue({
        data: { user: { id: userId, email: `${userId}@example.test` } as User },
        error: null,
      }),
    },
  } as unknown as Pick<SupabaseClient, 'auth'>
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('exact login identity', () => {
  beforeEach(() => {
    __resetAuthOperationsForTests()
    __resetViewerScopeForTests()
    document.cookie = 'csrf-token=csrf-test; path=/'
    global.fetch = jest.fn()
  })

  it('verifies the coordinator-returned session token without reacquiring a session', async () => {
    const current = session('user-a', 'token-a1')
    makeCurrent(current)
    const client = clientFor('user-a')

    const snapshot = await verifyExactLoginIdentity(client, current)

    expect(snapshot.session).toBe(current)
    expect(client.auth.getUser).toHaveBeenCalledWith('token-a1')
  })

  it('invalidates A1 when the same user rotates to A2', async () => {
    const first = session('user-a', 'token-a1')
    makeCurrent(first)
    const snapshot = await verifyExactLoginIdentity(clientFor('user-a'), first)

    window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session('user-a', 'token-a2')))

    expect(isExactLoginIdentityCurrent(snapshot)).toBe(false)
    expect(() => assertExactLoginIdentityCurrent(snapshot)).toThrow(
      'Authentication operation was superseded'
    )
  })

  it('invalidates A when a B auth operation wins', async () => {
    const first = session('user-a', 'token-a1')
    makeCurrent(first)
    const snapshot = await verifyExactLoginIdentity(clientFor('user-a'), first)

    makeCurrent(session('user-b', 'token-b1'))

    expect(isExactLoginIdentityCurrent(snapshot)).toBe(false)
  })

  it('uses the exact bearer and drops a response after token rotation', async () => {
    const first = session('user-a', 'token-a1')
    makeCurrent(first)
    const snapshot = await verifyExactLoginIdentity(clientFor('user-a'), first)
    const response = deferred<Response>()
    ;(global.fetch as jest.Mock).mockReturnValueOnce(response.promise)

    const request = exactSessionJsonRequest(snapshot, '/api/profile/attribution', {
      utmSource: 'launch',
    })
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/profile/attribution',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer token-a1' }),
        body: JSON.stringify({ utmSource: 'launch' }),
      })
    )

    window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session('user-a', 'token-a2')))
    response.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }))

    await expect(request).rejects.toThrow('Authentication operation was superseded')
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })
})
