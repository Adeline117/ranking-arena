import {
  AUTH_STORAGE_KEY,
  __resetAuthOperationsForTests,
  beginAuthIdentityOperation,
  clearAuthRedirectAcquisitionReceipt,
  clearAuthStorage,
  detectAuthSessionInUrl,
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

function detectCurrentRedirect(): boolean {
  const url = new URL(window.location.href)
  const hash = Object.fromEntries(new URLSearchParams(url.hash.slice(1)))
  return detectAuthSessionInUrl(url, hash)
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
      purpose: 'oauth-callback',
    })
    window.history.pushState({}, '', '/')
  })

  it('issues a distinct receipt for a password-recovery redirect acquisition', () => {
    window.history.pushState(
      {},
      '',
      '/reset-password#access_token=recovery-token&refresh_token=refresh-recovery-user&type=recovery'
    )
    expect(detectCurrentRedirect()).toBe(true)
    // GoTrue clears the hash in _getSessionFromURL before _saveSession writes.
    window.history.replaceState({}, '', '/reset-password')
    guardedAuthStorage.setItem(AUTH_STORAGE_KEY, storedSession('recovery-user', 'recovery-token'))

    const operation = getCurrentAuthOperation()
    expect(getAuthRedirectNavigationKey()).toBe('/reset-password')
    expect(getAuthRedirectAcquisitionReceipt()).toEqual({
      operationId: operation?.id,
      userId: 'recovery-user',
      navigationKey: '/reset-password',
      purpose: 'password-recovery',
    })
    window.history.pushState({}, '', '/')
  })

  it.each([
    ['/reset-password', 'ordinary reset page'],
    [
      '/reset-password#access_token=token-b&refresh_token=refresh-user-b&type=signup',
      'non-recovery type',
    ],
    ['/reset-password#access_token=token-b&type=recovery', 'missing refresh token'],
    ['/reset-password#refresh_token=refresh-user-b&type=recovery', 'missing access token'],
  ])('rejects an unscoped B session write for %s (%s)', (path) => {
    window.history.pushState({}, '', path)
    detectCurrentRedirect()
    guardedAuthStorage.setItem(AUTH_STORAGE_KEY, storedSession('user-b', 'token-b'))

    expect(window.localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull()
    expect(getAuthRedirectAcquisitionReceipt()).toBeNull()
    expect(getCurrentAuthOperation()).toBeNull()
    window.history.pushState({}, '', '/')
  })

  it.each([
    ['different-access', 'refresh-user-b'],
    ['token-b', 'different-refresh'],
  ])(
    'rejects a recovery intent whose stored token pair is %s / %s',
    (storedAccessToken, storedRefreshToken) => {
      window.history.pushState(
        {},
        '',
        '/reset-password#access_token=token-b&refresh_token=refresh-user-b&type=recovery'
      )
      expect(detectCurrentRedirect()).toBe(true)
      window.history.replaceState({}, '', '/reset-password')
      guardedAuthStorage.setItem(
        AUTH_STORAGE_KEY,
        JSON.stringify({
          access_token: storedAccessToken,
          refresh_token: storedRefreshToken,
          user: { id: 'user-b' },
        })
      )

      expect(window.localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull()
      expect(getAuthRedirectAcquisitionReceipt()).toBeNull()
      expect(getCurrentAuthOperation()).toBeNull()

      // A mismatched write consumes the one-shot intent; a later replay cannot
      // wait for the URL hash to disappear and then upgrade a normal session.
      guardedAuthStorage.setItem(AUTH_STORAGE_KEY, storedSession('user-b', 'token-b'))
      expect(window.localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull()
      expect(getAuthRedirectAcquisitionReceipt()).toBeNull()
      window.history.pushState({}, '', '/')
    }
  )

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
