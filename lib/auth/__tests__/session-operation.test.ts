import {
  AUTH_STORAGE_KEY,
  __resetAuthOperationsForTests,
  beginAuthIdentityOperation,
  clearAuthRedirectAcquisitionReceipt,
  clearAuthStorage,
  getAuthRedirectAcquisitionReceipt,
  getAuthRedirectNavigationKey,
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
    window.history.pushState({}, '', '/auth/callback?returnUrl=%2Ffeed&code=oauth-code')
    guardedAuthStorage.setItem(AUTH_STORAGE_KEY, storedSession('oauth-user', 'oauth-token'))

    const operation = getCurrentAuthOperation()
    expect(operation).toMatchObject({
      expectedUserId: 'oauth-user',
      targetKnown: true,
      identityTransition: false,
    })
    expect(getAuthRedirectNavigationKey()).toBe('/auth/callback?returnUrl=%2Ffeed')
    expect(getAuthRedirectAcquisitionReceipt()).toEqual({
      operationId: operation?.id,
      userId: 'oauth-user',
      navigationKey: '/auth/callback?returnUrl=%2Ffeed',
    })
    window.history.pushState({}, '', '/')
  })

  it('does not issue a redirect receipt for a coordinator-owned session writer', async () => {
    window.history.pushState({}, '', '/auth/callback?code=oauth-code')
    const operation = beginAuthIdentityOperation('oauth-user')

    await withAuthSessionWriter(operation, async () => {
      guardedAuthStorage.setItem(AUTH_STORAGE_KEY, storedSession('oauth-user', 'coordinator-token'))
    })

    expect(getAuthRedirectAcquisitionReceipt()).toBeNull()
    window.history.pushState({}, '', '/')
  })

  it('does not let an A receipt clear a newer B redirect receipt', () => {
    window.history.pushState({}, '', '/auth/callback?addAccount=true&code=code-a')
    guardedAuthStorage.setItem(AUTH_STORAGE_KEY, storedSession('user-a', 'token-a'))
    const receiptA = getAuthRedirectAcquisitionReceipt()
    expect(receiptA).not.toBeNull()

    window.history.pushState({}, '', '/auth/callback?addAccount=true&code=code-b')
    guardedAuthStorage.setItem(AUTH_STORAGE_KEY, storedSession('user-b', 'token-b'))
    const receiptB = getAuthRedirectAcquisitionReceipt()
    expect(receiptB).toMatchObject({
      userId: 'user-b',
      navigationKey: '/auth/callback?addAccount=true',
    })
    expect(receiptB?.operationId).not.toBe(receiptA?.operationId)

    expect(clearAuthRedirectAcquisitionReceipt(receiptA!)).toBe(false)
    expect(getAuthRedirectAcquisitionReceipt()).toEqual(receiptB)
    expect(clearAuthRedirectAcquisitionReceipt(receiptB!)).toBe(true)
    expect(getAuthRedirectAcquisitionReceipt()).toBeNull()
    window.history.pushState({}, '', '/')
  })
})
