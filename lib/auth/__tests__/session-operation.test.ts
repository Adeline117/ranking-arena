import {
  AUTH_STORAGE_KEY,
  __resetAuthOperationsForTests,
  beginAuthIdentityOperation,
  clearAuthStorage,
  getCurrentAuthOperation,
  guardedAuthStorage,
  withAuthSessionWriter,
} from '../session-operation'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function storedSession(userId: string, accessToken: string): string {
  return JSON.stringify({
    access_token: accessToken,
    refresh_token: `refresh-${userId}`,
    user: { id: userId },
  })
}

describe('guarded auth session storage', () => {
  beforeEach(() => {
    __resetAuthOperationsForTests()
  })

  it('rejects A at the actual storage boundary after B owns the identity lease', async () => {
    const operationA = beginAuthIdentityOperation('user-a')
    const releaseA = deferred()
    const writeA = withAuthSessionWriter(operationA, async () => {
      await releaseA.promise
      guardedAuthStorage.setItem(AUTH_STORAGE_KEY, storedSession('user-a', 'late-token-a'))
    })

    const operationB = beginAuthIdentityOperation('user-b')
    releaseA.resolve()
    await writeA

    expect(window.localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull()

    await withAuthSessionWriter(operationB, async () => {
      guardedAuthStorage.setItem(AUTH_STORAGE_KEY, storedSession('user-b', 'token-b'))
    })
    expect(JSON.parse(window.localStorage.getItem(AUTH_STORAGE_KEY) ?? '{}')).toMatchObject({
      access_token: 'token-b',
      user: { id: 'user-b' },
    })
  })

  it('keeps logout authoritative when an old refresh resumes later', async () => {
    const operationA = beginAuthIdentityOperation('user-a')
    await withAuthSessionWriter(operationA, async () => {
      guardedAuthStorage.setItem(AUTH_STORAGE_KEY, storedSession('user-a', 'token-a'))
    })
    const releaseRefresh = deferred()
    const refresh = withAuthSessionWriter(operationA, async () => {
      await releaseRefresh.promise
      guardedAuthStorage.setItem(AUTH_STORAGE_KEY, storedSession('user-a', 'late-token-a'))
    })

    const logout = beginAuthIdentityOperation(null)
    expect(clearAuthStorage(logout)).toBe(true)
    releaseRefresh.resolve()
    await refresh

    expect(window.localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull()
    expect(getCurrentAuthOperation()).toMatchObject({
      id: logout.id,
      expectedUserId: null,
      targetKnown: true,
    })
  })

  it('binds an internal OAuth acquisition to its resolved principal', () => {
    window.history.pushState({}, '', '/auth/callback?code=oauth-code')
    guardedAuthStorage.setItem(AUTH_STORAGE_KEY, storedSession('oauth-user', 'oauth-token'))

    expect(getCurrentAuthOperation()).toMatchObject({
      expectedUserId: 'oauth-user',
      targetKnown: true,
      identityTransition: false,
    })
    window.history.pushState({}, '', '/')
  })
})
