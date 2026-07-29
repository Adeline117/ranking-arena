import {
  AUTH_OPERATION_STORAGE_KEY,
  AUTH_STORAGE_KEY,
  __resetAuthOperationsForTests,
  beginAuthIdentityOperation,
  bindAuthOperationPrincipal,
  clearAuthRedirectAcquisitionReceipt,
  clearAuthStorage,
  completeAuthIdentityOperation,
  detectAuthSessionInUrl,
  getAuthRedirectAcquisitionReceipt,
  getAuthRedirectNavigationKey,
  getCurrentAuthOperation,
  guardedAuthStorage,
  settleAuthRedirectInitialization,
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

  it('restores the exact B session when B commits inside the stale A storage write', async () => {
    // A second module instance models another tab: it shares localStorage but
    // has an independent tab-local activeWriter context.
    let tabB!: typeof import('../session-operation')
    jest.isolateModules(() => {
      tabB = jest.requireActual('../session-operation') as typeof import('../session-operation')
    })

    const operationA = beginAuthIdentityOperation('user-a')
    const sessionA = storedSession('user-a', 'late-token-a')
    const sessionB = storedSession('user-b', 'exact-token-b')
    const rawSetItem = Storage.prototype.setItem
    let injected = false
    let writeB: Promise<void> | null = null
    let operationB: ReturnType<typeof beginAuthIdentityOperation> | null = null

    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      key: string,
      value: string
    ) {
      if (key === AUTH_STORAGE_KEY && value === sessionA && !injected) {
        injected = true
        operationB = tabB.beginAuthIdentityOperation('user-b')
        writeB = tabB.withAuthSessionWriter(operationB, async () => {
          tabB.guardedAuthStorage.setItem(AUTH_STORAGE_KEY, sessionB)
        })
        tabB.completeAuthIdentityOperation(operationB, 'user-b')
      }
      rawSetItem.call(this, key, value)
    })

    try {
      await withAuthSessionWriter(operationA, async () => {
        guardedAuthStorage.setItem(AUTH_STORAGE_KEY, sessionA)
      })
      await writeB
    } finally {
      setItem.mockRestore()
    }

    expect(operationB).not.toBeNull()
    expect(getCurrentAuthOperation()).toMatchObject({
      id: operationB?.id,
      expectedUserId: 'user-b',
      identityTransition: false,
    })
    expect(window.localStorage.getItem(AUTH_STORAGE_KEY)).toBe(sessionB)
  })

  it("does not restore B's superseded token over B's latest rotation", async () => {
    let tabB!: typeof import('../session-operation')
    jest.isolateModules(() => {
      tabB = jest.requireActual('../session-operation') as typeof import('../session-operation')
    })

    const operationA = beginAuthIdentityOperation('user-a')
    const sessionA = storedSession('user-a', 'late-token-a')
    const firstSessionB = storedSession('user-b', 'superseded-token-b')
    const rotatedSessionB = storedSession('user-b', 'rotated-token-b')
    const rawSetItem = Storage.prototype.setItem
    let injected = false
    let writeB: Promise<void> | null = null

    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      key: string,
      value: string
    ) {
      if (key === AUTH_STORAGE_KEY && value === sessionA && !injected) {
        injected = true
        const operationB = tabB.beginAuthIdentityOperation('user-b')
        writeB = tabB.withAuthSessionWriter(operationB, async () => {
          tabB.guardedAuthStorage.setItem(AUTH_STORAGE_KEY, firstSessionB)
          tabB.guardedAuthStorage.setItem(AUTH_STORAGE_KEY, rotatedSessionB)
        })
        tabB.completeAuthIdentityOperation(operationB, 'user-b')
      }
      rawSetItem.call(this, key, value)
    })

    try {
      await withAuthSessionWriter(operationA, async () => {
        guardedAuthStorage.setItem(AUTH_STORAGE_KEY, sessionA)
      })
      await writeB
    } finally {
      setItem.mockRestore()
    }

    expect(window.localStorage.getItem(AUTH_STORAGE_KEY)).toBe(rotatedSessionB)
    expect(window.localStorage.getItem(AUTH_STORAGE_KEY)).not.toBe(firstSessionB)
  })

  it('keeps an interleaved B logout authoritative and purges session journals', async () => {
    let tabB!: typeof import('../session-operation')
    jest.isolateModules(() => {
      tabB = jest.requireActual('../session-operation') as typeof import('../session-operation')
    })

    const operationA = beginAuthIdentityOperation('user-a')
    const sessionA = storedSession('user-a', 'late-secret-token-a')
    const rawSetItem = Storage.prototype.setItem
    let injected = false

    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      key: string,
      value: string
    ) {
      if (key === AUTH_STORAGE_KEY && value === sessionA && !injected) {
        injected = true
        const logoutB = tabB.beginAuthIdentityOperation(null)
        expect(tabB.clearAuthStorage(logoutB)).toBe(true)
        tabB.completeAuthIdentityOperation(logoutB, null)
      }
      rawSetItem.call(this, key, value)
    })

    try {
      await withAuthSessionWriter(operationA, async () => {
        guardedAuthStorage.setItem(AUTH_STORAGE_KEY, sessionA)
      })
    } finally {
      setItem.mockRestore()
    }

    expect(window.localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull()
    const remainingStorage = Array.from(
      { length: window.localStorage.length },
      (_, index) => window.localStorage.getItem(window.localStorage.key(index) ?? '') ?? ''
    ).join('\n')
    expect(remainingStorage).not.toContain('late-secret-token-a')
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

  it('keeps the current operation pointer immutable while binding and completing', () => {
    const operation = beginAuthIdentityOperation()
    const pointer = window.localStorage.getItem(AUTH_OPERATION_STORAGE_KEY)

    const bound = bindAuthOperationPrincipal(operation, 'user-a')
    expect(bound).not.toBeNull()
    const completed = completeAuthIdentityOperation(bound!, 'user-a')

    expect(completed).toMatchObject({
      id: operation.id,
      expectedUserId: 'user-a',
      identityTransition: false,
    })
    expect(window.localStorage.getItem(AUTH_OPERATION_STORAGE_KEY)).toBe(pointer)
    expect(getCurrentAuthOperation()).toEqual(completed)
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
      expect(getCurrentAuthOperation()).toMatchObject({
        expectedUserId: null,
        targetKnown: true,
        identityTransition: false,
      })

      // A mismatched write consumes the one-shot intent; a later replay cannot
      // wait for the URL hash to disappear and then upgrade a normal session.
      guardedAuthStorage.setItem(AUTH_STORAGE_KEY, storedSession('user-b', 'token-b'))
      expect(window.localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull()
      expect(getAuthRedirectAcquisitionReceipt()).toBeNull()
      window.history.pushState({}, '', '/')
    }
  )

  it('keeps a newer B login authoritative over a late recovery A storage write', async () => {
    window.history.pushState(
      {},
      '',
      '/reset-password#access_token=token-a&refresh_token=refresh-user-a&type=recovery'
    )
    expect(detectCurrentRedirect()).toBe(true)
    const recoveryOperationA = getCurrentAuthOperation()
    expect(recoveryOperationA).toMatchObject({
      expectedUserId: null,
      targetKnown: false,
      identityTransition: true,
    })
    window.history.replaceState({}, '', '/reset-password')

    const operationB = beginAuthIdentityOperation('user-b')
    await withAuthSessionWriter(operationB, async () => {
      guardedAuthStorage.setItem(AUTH_STORAGE_KEY, storedSession('user-b', 'token-b'))
    })
    const steadyB = completeAuthIdentityOperation(operationB, 'user-b')
    expect(steadyB).not.toBeNull()

    guardedAuthStorage.setItem(AUTH_STORAGE_KEY, storedSession('user-a', 'token-a'))

    expect(JSON.parse(window.localStorage.getItem(AUTH_STORAGE_KEY) ?? '{}')).toMatchObject({
      access_token: 'token-b',
      user: { id: 'user-b' },
    })
    expect(getCurrentAuthOperation()).toEqual(steadyB)
    expect(getAuthRedirectAcquisitionReceipt()).toBeNull()
    window.history.pushState({}, '', '/')
  })

  it('rolls an invalid recovery initialization back to the stored B principal', async () => {
    const operationB = beginAuthIdentityOperation('user-b')
    await withAuthSessionWriter(operationB, async () => {
      guardedAuthStorage.setItem(AUTH_STORAGE_KEY, storedSession('user-b', 'token-b'))
    })
    completeAuthIdentityOperation(operationB, 'user-b')

    window.history.pushState(
      {},
      '',
      '/reset-password#access_token=invalid&refresh_token=invalid-refresh&type=recovery'
    )
    expect(detectCurrentRedirect()).toBe(true)
    expect(getCurrentAuthOperation()).toMatchObject({
      expectedUserId: null,
      targetKnown: false,
      identityTransition: true,
    })

    // GoTrue resolves initialization with an error and never calls setItem.
    settleAuthRedirectInitialization()

    expect(getCurrentAuthOperation()).toMatchObject({
      expectedUserId: 'user-b',
      targetKnown: true,
      identityTransition: false,
    })
    expect(JSON.parse(window.localStorage.getItem(AUTH_STORAGE_KEY) ?? '{}')).toMatchObject({
      access_token: 'token-b',
      user: { id: 'user-b' },
    })
    expect(getAuthRedirectAcquisitionReceipt()).toBeNull()
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
