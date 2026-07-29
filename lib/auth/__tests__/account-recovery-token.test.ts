import {
  ACCOUNT_RECOVERY_LOGIN_PATH,
  ACCOUNT_RECOVERY_MEMORY_KEY,
  ACCOUNT_RECOVERY_SESSION_TOKEN_KEY,
  ACCOUNT_RECOVERY_TOKEN_KEY,
  buildAccountRecoveryLoginPath,
  clearAccountRecoveryToken,
  consumeAccountRecoveryToken,
  isAccountRecoveryToken,
  persistAccountRecoveryToken,
  replaceDocumentForAccountRecovery,
  retainAccountRecoveryTokenLease,
} from '../account-recovery-token'

const CURRENT_TOKEN = 'A'.repeat(43)
const STALE_TOKEN = 'Q'.repeat(43)

describe('account recovery token handoff', () => {
  beforeEach(() => {
    clearAccountRecoveryToken()
    window.localStorage.clear()
    window.sessionStorage.clear()
    window.history.replaceState(null, '', ACCOUNT_RECOVERY_LOGIN_PATH)
  })

  it('accepts only canonical unpadded base64url at the exact length boundaries', () => {
    expect(isAccountRecoveryToken('A'.repeat(39))).toBe(false)
    expect(isAccountRecoveryToken('A'.repeat(40))).toBe(true)
    expect(isAccountRecoveryToken('A'.repeat(41))).toBe(false)
    expect(isAccountRecoveryToken('A'.repeat(128))).toBe(true)
    expect(isAccountRecoveryToken('A'.repeat(129))).toBe(false)

    expect(isAccountRecoveryToken(`${'A'.repeat(41)}B`)).toBe(false)
    expect(isAccountRecoveryToken(`${'A'.repeat(42)}B`)).toBe(false)
    expect(isAccountRecoveryToken(`${'A'.repeat(42)}=`)).toBe(false)
    expect(isAccountRecoveryToken(`${'A'.repeat(42)}+`)).toBe(false)
    expect(isAccountRecoveryToken(`${'A'.repeat(42)}/`)).toBe(false)
    expect(isAccountRecoveryToken(`${'A'.repeat(42)}\n`)).toBe(false)
  })

  it('consumes raw lanes once while retaining a remount-safe in-memory lease', () => {
    expect(persistAccountRecoveryToken(CURRENT_TOKEN)).toEqual({
      status: 'durable',
      localStorage: true,
      sessionStorage: true,
    })
    expect(window.localStorage.getItem(ACCOUNT_RECOVERY_TOKEN_KEY)).toBe(CURRENT_TOKEN)
    expect(window.sessionStorage.getItem(ACCOUNT_RECOVERY_SESSION_TOKEN_KEY)).toBe(CURRENT_TOKEN)

    expect(consumeAccountRecoveryToken()).toEqual({
      status: 'valid',
      token: CURRENT_TOKEN,
    })
    expect(window.localStorage.getItem(ACCOUNT_RECOVERY_TOKEN_KEY)).toBeNull()
    expect(window.sessionStorage.getItem(ACCOUNT_RECOVERY_SESSION_TOKEN_KEY)).toBeNull()
    expect(consumeAccountRecoveryToken()).toEqual({
      status: 'valid',
      token: CURRENT_TOKEN,
    })
    clearAccountRecoveryToken()
    expect(consumeAccountRecoveryToken()).toEqual({ status: 'absent' })
  })

  it('uses sessionStorage as a durable clean-URL lane when localStorage is blocked', () => {
    const originalSetItem = Storage.prototype.setItem
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string
    ) {
      if (this === window.localStorage) {
        throw new DOMException('localStorage blocked', 'SecurityError')
      }
      return originalSetItem.call(this, key, value)
    })

    expect(persistAccountRecoveryToken(CURRENT_TOKEN)).toEqual({
      status: 'durable',
      localStorage: false,
      sessionStorage: true,
    })
    expect(buildAccountRecoveryLoginPath()).toBe(ACCOUNT_RECOVERY_LOGIN_PATH)
    expect(window.sessionStorage.getItem(ACCOUNT_RECOVERY_SESSION_TOKEN_KEY)).toBe(CURRENT_TOKEN)

    setItem.mockRestore()
  })

  it('uses only a full-document fallback when both storage writes are blocked', () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage blocked', 'SecurityError')
    })
    const replace = jest.fn()

    expect(persistAccountRecoveryToken(CURRENT_TOKEN)).toEqual({
      status: 'memory',
      localStorage: false,
      sessionStorage: false,
    })
    expect(buildAccountRecoveryLoginPath()).toBe(ACCOUNT_RECOVERY_LOGIN_PATH)
    expect(replaceDocumentForAccountRecovery(CURRENT_TOKEN, replace)).toBe(true)
    expect(replace).toHaveBeenCalledWith(
      `${ACCOUNT_RECOVERY_LOGIN_PATH}#recovery_token=${CURRENT_TOKEN}`
    )

    setItem.mockRestore()
  })

  it('synchronously erases a valid legacy fragment before returning it to caller memory', () => {
    window.localStorage.setItem(ACCOUNT_RECOVERY_TOKEN_KEY, STALE_TOKEN)
    window.sessionStorage.setItem(ACCOUNT_RECOVERY_SESSION_TOKEN_KEY, STALE_TOKEN)
    window.history.replaceState(
      null,
      '',
      `${ACCOUNT_RECOVERY_LOGIN_PATH}#recovery_token=${CURRENT_TOKEN}&source=deletion`
    )
    const replaceState = jest.spyOn(window.history, 'replaceState')

    const handoff = consumeAccountRecoveryToken()

    expect(handoff).toEqual({ status: 'valid', token: CURRENT_TOKEN })
    expect(replaceState).toHaveBeenCalledTimes(1)
    expect(window.location.hash).toBe('#source=deletion')
    expect(window.localStorage.getItem(ACCOUNT_RECOVERY_TOKEN_KEY)).toBeNull()
    expect(window.sessionStorage.getItem(ACCOUNT_RECOVERY_SESSION_TOKEN_KEY)).toBeNull()
    replaceState.mockRestore()
  })

  it('fails closed for an invalid fragment instead of using valid stale credentials', () => {
    window.localStorage.setItem(ACCOUNT_RECOVERY_TOKEN_KEY, STALE_TOKEN)
    window.sessionStorage.setItem(ACCOUNT_RECOVERY_SESSION_TOKEN_KEY, STALE_TOKEN)
    window.history.replaceState(
      null,
      '',
      `${ACCOUNT_RECOVERY_LOGIN_PATH}#recovery_token=invalid&source=deletion`
    )

    expect(consumeAccountRecoveryToken()).toEqual({ status: 'invalid' })
    expect(window.localStorage.getItem(ACCOUNT_RECOVERY_TOKEN_KEY)).toBeNull()
    expect(window.sessionStorage.getItem(ACCOUNT_RECOVERY_SESSION_TOKEN_KEY)).toBeNull()
    expect(window.location.hash).toBe('#source=deletion')
  })

  it('fails closed and strips every copy of a duplicated legacy fragment credential', () => {
    window.localStorage.setItem(ACCOUNT_RECOVERY_TOKEN_KEY, STALE_TOKEN)
    window.history.replaceState(
      null,
      '',
      `${ACCOUNT_RECOVERY_LOGIN_PATH}#recovery_token=${CURRENT_TOKEN}&recovery_token=${STALE_TOKEN}&source=deletion`
    )

    expect(consumeAccountRecoveryToken()).toEqual({ status: 'invalid' })
    expect(window.location.href).not.toContain('recovery_token')
    expect(window.location.hash).toBe('#source=deletion')
    expect(window.localStorage.getItem(ACCOUNT_RECOVERY_TOKEN_KEY)).toBeNull()
  })

  it('fails closed when durable lanes disagree', () => {
    window.localStorage.setItem(ACCOUNT_RECOVERY_TOKEN_KEY, CURRENT_TOKEN)
    window.sessionStorage.setItem(ACCOUNT_RECOVERY_SESSION_TOKEN_KEY, STALE_TOKEN)

    expect(consumeAccountRecoveryToken()).toEqual({ status: 'invalid' })
    expect(window.localStorage.getItem(ACCOUNT_RECOVERY_TOKEN_KEY)).toBeNull()
    expect(window.sessionStorage.getItem(ACCOUNT_RECOVERY_SESSION_TOKEN_KEY)).toBeNull()
  })

  it('keeps the lease across a same-URL remount and clears it after route departure', () => {
    jest.useFakeTimers()
    const releaseFirstMount = retainAccountRecoveryTokenLease()
    persistAccountRecoveryToken(CURRENT_TOKEN)

    expect(consumeAccountRecoveryToken()).toEqual({
      status: 'valid',
      token: CURRENT_TOKEN,
    })
    releaseFirstMount()
    jest.runOnlyPendingTimers()
    expect(consumeAccountRecoveryToken()).toEqual({
      status: 'valid',
      token: CURRENT_TOKEN,
    })

    const releaseReplacementMount = retainAccountRecoveryTokenLease()
    window.history.replaceState(null, '', '/login')
    releaseReplacementMount()
    jest.runOnlyPendingTimers()
    expect(consumeAccountRecoveryToken()).toEqual({ status: 'absent' })
    jest.useRealTimers()
  })

  it('keeps durable lanes on pagehide while clearing this document’s ephemeral handoff', () => {
    const releaseMount = retainAccountRecoveryTokenLease()
    releaseMount()
    persistAccountRecoveryToken(CURRENT_TOKEN)

    window.dispatchEvent(new Event('pagehide'))

    expect(Object.prototype.hasOwnProperty.call(window, ACCOUNT_RECOVERY_MEMORY_KEY)).toBe(false)
    expect(window.localStorage.getItem(ACCOUNT_RECOVERY_TOKEN_KEY)).toBe(CURRENT_TOKEN)
    expect(window.sessionStorage.getItem(ACCOUNT_RECOVERY_SESSION_TOKEN_KEY)).toBe(CURRENT_TOKEN)
    expect(consumeAccountRecoveryToken()).toEqual({
      status: 'valid',
      token: CURRENT_TOKEN,
    })
  })

  it('clears every handoff lane while preserving unrelated fragment state', () => {
    persistAccountRecoveryToken(CURRENT_TOKEN)
    window.history.replaceState(
      null,
      '',
      `${ACCOUNT_RECOVERY_LOGIN_PATH}#recovery_token=${CURRENT_TOKEN}&source=deletion`
    )

    clearAccountRecoveryToken()

    expect(window.localStorage.getItem(ACCOUNT_RECOVERY_TOKEN_KEY)).toBeNull()
    expect(window.sessionStorage.getItem(ACCOUNT_RECOVERY_SESSION_TOKEN_KEY)).toBeNull()
    expect(window.location.hash).toBe('#source=deletion')
    expect(consumeAccountRecoveryToken()).toEqual({ status: 'absent' })
  })

  it('never serializes malformed credentials into any navigation target', () => {
    const replace = jest.fn()

    expect(buildAccountRecoveryLoginPath()).toBe(ACCOUNT_RECOVERY_LOGIN_PATH)
    expect(replaceDocumentForAccountRecovery('A'.repeat(39), replace)).toBe(false)
    expect(replaceDocumentForAccountRecovery('A'.repeat(41), replace)).toBe(false)
    expect(replaceDocumentForAccountRecovery(`${'A'.repeat(42)}B`, replace)).toBe(false)
    expect(replace).not.toHaveBeenCalled()
  })
})
