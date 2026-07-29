import { getAccountRecoveryBootstrapScript } from '../account-recovery-bootstrap'
import {
  ACCOUNT_RECOVERY_MEMORY_KEY,
  ACCOUNT_RECOVERY_SESSION_TOKEN_KEY,
  ACCOUNT_RECOVERY_TOKEN_KEY,
  clearAccountRecoveryToken,
  consumeAccountRecoveryToken,
} from '../account-recovery-token'

const RECOVERY_TOKEN = 'A'.repeat(43)
const STALE_TOKEN = 'Q'.repeat(43)

describe('parser-first account recovery bootstrap', () => {
  beforeEach(() => {
    clearAccountRecoveryToken()
    window.localStorage.clear()
    window.sessionStorage.clear()
    window.history.replaceState(null, '', '/login?account_deleted=1')
  })

  it('scrubs the full-document fragment before Replay can read any URL source', () => {
    window.localStorage.setItem(ACCOUNT_RECOVERY_TOKEN_KEY, STALE_TOKEN)
    window.sessionStorage.setItem(ACCOUNT_RECOVERY_SESSION_TOKEN_KEY, STALE_TOKEN)
    window.history.replaceState(
      null,
      '',
      `/login?account_deleted=1#recovery_token=${RECOVERY_TOKEN}&source=deletion`
    )

    const operations: string[] = []
    const originalReplaceState = window.history.replaceState
    const replaceState = jest.spyOn(window.history, 'replaceState').mockImplementation(function (
      ...args: Parameters<History['replaceState']>
    ) {
      operations.push('bootstrap.replaceState')
      return originalReplaceState.apply(window.history, args)
    })

    window.eval(getAccountRecoveryBootstrapScript())

    // These mirror the three Replay paths relevant to this incident:
    // navigation.push names, replay context.urls, and rrweb Meta.href.
    operations.push('replay.read')
    const replayContext = { urls: [window.location.href] }
    const navigationPush = {
      op: 'navigation.push',
      name: window.location.href,
    }
    const rrwebMeta = {
      type: 4,
      data: { href: window.location.href },
    }

    expect(operations).toEqual(['bootstrap.replaceState', 'replay.read'])
    expect(window.location.hash).toBe('#source=deletion')
    expect(JSON.stringify({ replayContext, navigationPush, rrwebMeta })).not.toContain(
      RECOVERY_TOKEN
    )
    expect(window.localStorage.getItem(ACCOUNT_RECOVERY_TOKEN_KEY)).toBeNull()
    expect(window.sessionStorage.getItem(ACCOUNT_RECOVERY_SESSION_TOKEN_KEY)).toBeNull()

    const descriptor = Object.getOwnPropertyDescriptor(window, ACCOUNT_RECOVERY_MEMORY_KEY)
    expect(descriptor?.enumerable).toBe(false)
    expect(consumeAccountRecoveryToken()).toEqual({
      status: 'valid',
      token: RECOVERY_TOKEN,
    })
    expect(consumeAccountRecoveryToken()).toEqual({
      status: 'valid',
      token: RECOVERY_TOKEN,
    })
    clearAccountRecoveryToken()
    expect(consumeAccountRecoveryToken()).toEqual({ status: 'absent' })
    replaceState.mockRestore()
  })

  it('strips duplicate or malformed fragments and refuses stale storage fallback', () => {
    window.localStorage.setItem(ACCOUNT_RECOVERY_TOKEN_KEY, STALE_TOKEN)
    window.sessionStorage.setItem(ACCOUNT_RECOVERY_SESSION_TOKEN_KEY, STALE_TOKEN)
    window.history.replaceState(
      null,
      '',
      `/login?account_deleted=1#recovery_token=${RECOVERY_TOKEN}&recovery_token=invalid&source=deletion`
    )

    window.eval(getAccountRecoveryBootstrapScript())

    expect(window.location.href).not.toContain('recovery_token')
    expect(window.location.href).not.toContain(RECOVERY_TOKEN)
    expect(window.location.hash).toBe('#source=deletion')
    expect(window.localStorage.getItem(ACCOUNT_RECOVERY_TOKEN_KEY)).toBeNull()
    expect(window.sessionStorage.getItem(ACCOUNT_RECOVERY_SESSION_TOKEN_KEY)).toBeNull()
    expect(consumeAccountRecoveryToken()).toEqual({ status: 'invalid' })
    clearAccountRecoveryToken()
    expect(consumeAccountRecoveryToken()).toEqual({ status: 'absent' })
  })
})
