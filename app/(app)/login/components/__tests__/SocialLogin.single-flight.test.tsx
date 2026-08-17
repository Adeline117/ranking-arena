import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockSignInWithOAuth = jest.fn()
const mockStartAuthentication = jest.fn()
const mockEstablishSession = jest.fn()
const mockOnError = jest.fn()
const mockOnWalletSuccess = jest.fn()

jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      signInWithOAuth: (...args: unknown[]) => mockSignInWithOAuth(...args),
    },
  },
}))

jest.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
  startAuthentication: (...args: unknown[]) => mockStartAuthentication(...args),
}))

jest.mock('@/lib/auth/token-refresh', () => ({
  tokenRefreshCoordinator: {
    establishSession: (...args: unknown[]) => mockEstablishSession(...args),
  },
}))

jest.mock('@/lib/auth/token-subject', () => ({ jwtSubject: () => 'user-a' }))
jest.mock('@/lib/auth/session-operation', () => ({
  getCurrentAuthOperation: () => null,
  isAuthOperationCurrent: () => false,
}))
jest.mock('@/lib/logger', () => ({ logger: { warn: jest.fn() } }))
jest.mock('@/lib/privy/config', () => ({ PRIVY_SUPABASE_BRIDGE_READY: false }))

jest.mock('next/dynamic', () => ({
  __esModule: true,
  default:
    () =>
    ({ children, disabled }: { children?: React.ReactNode; disabled?: boolean }) =>
      children ? (
        <>{children}</>
      ) : (
        <button type="button" data-testid="dynamic-login" disabled={disabled}>
          wallet
        </button>
      ),
}))

import SocialLogin from '../SocialLogin'

const originalFetch = global.fetch

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, reject, resolve }
}

function renderSocialLogin() {
  const searchParams = { get: () => null }
  return render(
    <SocialLogin
      lang="en"
      searchParams={searchParams as never}
      isAddAccount={false}
      onError={mockOnError}
      onWalletSuccess={mockOnWalletSuccess}
      t={(key) => key}
    />
  )
}

describe('SocialLogin operation ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSignInWithOAuth.mockResolvedValue({ error: null })
    mockEstablishSession.mockResolvedValue({})
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('single-flights OAuth before its disabled state renders', async () => {
    const oauth = deferred<{ error: { message: string } }>()
    mockSignInWithOAuth.mockReturnValue(oauth.promise)
    renderSocialLogin()

    const google = screen.getByRole('button', { name: 'Google' })
    act(() => {
      google.click()
      google.click()
    })

    expect(mockSignInWithOAuth).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'loginOtherOptions' })).toBeDisabled()

    await act(async () => {
      oauth.resolve({ error: { message: 'OAuth failed' } })
      await oauth.promise
    })

    expect(mockOnError).toHaveBeenLastCalledWith('OAuth failed')
    expect(screen.getByRole('button', { name: 'loginOtherOptions' })).toBeEnabled()
  })

  it('single-flights passkey prompts and freezes the other social methods', async () => {
    const assertion = deferred<Record<string, unknown>>()
    mockStartAuthentication.mockReturnValue(assertion.promise)
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ optionsJSON: { challenge: 'challenge-a' }, challengeKey: 'key-a' }),
    }) as typeof fetch
    renderSocialLogin()
    fireEvent.click(screen.getByRole('button', { name: 'loginOtherOptions' }))

    const passkey = screen.getByRole('button', { name: 'passkeySignIn' })
    act(() => {
      passkey.click()
      passkey.click()
    })

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1))
    expect(mockStartAuthentication).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Google' })).toBeDisabled()
    expect(screen.getByTestId('dynamic-login')).toBeDisabled()

    await act(async () => {
      assertion.reject(Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }))
      await assertion.promise.catch(() => undefined)
    })

    expect(mockOnError).toHaveBeenLastCalledWith('passkeyCancelled')
    expect(screen.getByRole('button', { name: 'Google' })).toBeEnabled()
  })
})
