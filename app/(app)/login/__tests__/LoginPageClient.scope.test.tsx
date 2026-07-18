import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Session, User } from '@supabase/supabase-js'
import {
  AUTH_STORAGE_KEY,
  __resetAuthOperationsForTests,
  beginAuthIdentityOperation,
  completeAuthIdentityOperation,
} from '@/lib/auth/session-operation'
import { __resetViewerScopeForTests, synchronizeViewerScope } from '@/lib/auth/viewer-scope'

const mockPush = jest.fn()
const mockReplace = jest.fn()
let mockSearchParams = new URLSearchParams()
const mockGetUser = jest.fn()
const mockSignInWithOtp = jest.fn()
const mockSignInWithPassword = jest.fn()
const mockVerifyOtp = jest.fn()
const mockUpdateUserWithSession = jest.fn()
const mockSignOutIfCurrent = jest.fn()
const mockSignOut = jest.fn()
const mockProfileMaybeSingle = jest.fn()
const mockFrom = jest.fn()
const mockSelect = jest.fn()
const mockUpdate = jest.fn()
const mockEq = jest.fn()
const mockAbortSignal = jest.fn()
const mockUnsubscribe = jest.fn()
let mockAuthStateCallback: ((event: string, session: Session | null) => void) | null = null
let mockLoginFormProps: Record<string, any> | null = null
let mockRegisterFormProps: Record<string, any> | null = null
let mockAccounts: Array<{
  userId: string
  email: string
  handle: string | null
  avatarUrl: string | null
  refreshToken: string
  lastActiveAt: string
  isActive: boolean
}> = []
const mockStoreSetState = jest.fn(
  (updater: (state: { accounts: typeof mockAccounts }) => object) => {
    const update = updater({ accounts: mockAccounts }) as { accounts?: typeof mockAccounts }
    if (update.accounts) mockAccounts = update.accounts
  }
)

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
}))

jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      getUser: (...args: unknown[]) => mockGetUser(...args),
      signInWithOtp: (...args: unknown[]) => mockSignInWithOtp(...args),
      onAuthStateChange: (callback: (event: string, session: Session | null) => void) => {
        mockAuthStateCallback = callback
        return { data: { subscription: { unsubscribe: mockUnsubscribe } } }
      },
    },
    from: (...args: unknown[]) => mockFrom(...args),
  },
}))

jest.mock('@/lib/auth/token-refresh', () => ({
  tokenRefreshCoordinator: {
    signInWithPassword: (...args: unknown[]) => mockSignInWithPassword(...args),
    verifyOtp: (...args: unknown[]) => mockVerifyOtp(...args),
    updateUserWithSession: (...args: unknown[]) => mockUpdateUserWithSession(...args),
    signOutIfCurrent: (...args: unknown[]) => mockSignOutIfCurrent(...args),
  },
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => ({ signOut: (...args: unknown[]) => mockSignOut(...args) }),
}))

jest.mock('@/lib/stores/multiAccountStore', () => ({
  useMultiAccountStore: { setState: (...args: unknown[]) => mockStoreSetState(...args) },
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ language: 'en', t: (key: string) => key }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: jest.fn() }),
}))

jest.mock('@/lib/hooks/useProductFacts', () => ({
  useProductFacts: () => ({ rankedTraderCount: 1000, sourceBoardCount: 12 }),
}))

jest.mock('@/lib/analytics/track', () => ({ trackEvent: jest.fn() }))
jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

jest.mock('../components/SocialLogin', () => ({
  __esModule: true,
  default: () => <div data-testid="social-login" />,
}))

jest.mock('../components/LoginForm', () => ({
  __esModule: true,
  default: (props: Record<string, any>) => {
    mockLoginFormProps = props
    return (
      <button type="button" data-testid="password-login" onClick={props.onLogin}>
        login
      </button>
    )
  },
}))

jest.mock('../components/RegisterForm', () => ({
  __esModule: true,
  default: (props: Record<string, any>) => {
    mockRegisterFormProps = props
    return (
      <div>
        <button type="button" data-testid="verify-code" onClick={props.onVerifyCode}>
          verify
        </button>
        <button type="button" data-testid="set-password" onClick={props.onSetPassword}>
          finish
        </button>
      </div>
    )
  },
}))

import LoginPageClient from '../LoginPageClient'

function user(userId: string): User {
  return {
    id: userId,
    email: `${userId}@example.test`,
    aud: 'authenticated',
    role: 'authenticated',
    created_at: '2026-07-16T00:00:00.000Z',
    app_metadata: {},
    user_metadata: {},
  } as User
}

function session(userId: string, token = `access-${userId}`): Session {
  return {
    access_token: token,
    refresh_token: `refresh-${token}`,
    expires_in: 3600,
    token_type: 'bearer',
    user: user(userId),
  }
}

function profile(userId: string) {
  return { id: userId, handle: `handle-${userId}`, avatar_url: null }
}

function makeCurrent(value: Session): void {
  const operation = beginAuthIdentityOperation(value.user.id)
  completeAuthIdentityOperation(operation, value.user.id)
  window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(value))
  synchronizeViewerScope(true, value.user.id)
}

function makeAnonymous(): void {
  const operation = beginAuthIdentityOperation(null)
  completeAuthIdentityOperation(operation, null)
  window.localStorage.removeItem(AUTH_STORAGE_KEY)
  synchronizeViewerScope(true, null)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function installProfileBuilder(): void {
  const builder = {
    select: (...args: unknown[]) => {
      mockSelect(...args)
      return builder
    },
    update: (...args: unknown[]) => {
      mockUpdate(...args)
      return builder
    },
    eq: (...args: unknown[]) => {
      mockEq(...args)
      return builder
    },
    abortSignal: (...args: unknown[]) => {
      mockAbortSignal(...args)
      return builder
    },
    maybeSingle: (...args: unknown[]) => mockProfileMaybeSingle(...args),
  }
  mockFrom.mockReturnValue(builder)
}

async function renderLogin(): Promise<ReturnType<typeof render>> {
  const view = render(<LoginPageClient />)
  await screen.findByTestId('password-login')
  return view
}

async function startPasswordLogin(value: Session): Promise<void> {
  mockSignInWithPassword.mockImplementationOnce(async () => {
    makeCurrent(value)
    return { data: { session: value, user: value.user }, error: null }
  })
  fireEvent.click(screen.getByTestId('password-login'))
  await waitFor(() => expect(mockGetUser).toHaveBeenCalledWith(value.access_token))
}

describe('LoginPageClient exact identity boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSearchParams = new URLSearchParams()
    mockAuthStateCallback = null
    mockLoginFormProps = null
    mockRegisterFormProps = null
    mockAccounts = []
    window.localStorage.clear()
    window.sessionStorage.clear()
    document.cookie = 'csrf-token=csrf-login; path=/'
    __resetAuthOperationsForTests()
    __resetViewerScopeForTests()
    synchronizeViewerScope(true, null)
    installProfileBuilder()
    mockGetUser.mockImplementation(async (token: string) => {
      const current = JSON.parse(
        window.localStorage.getItem(AUTH_STORAGE_KEY) || 'null'
      ) as Session | null
      return {
        data: { user: current?.access_token === token ? current.user : null },
        error: current?.access_token === token ? null : new Error('invalid token'),
      }
    })
    mockSignInWithOtp.mockResolvedValue({ data: {}, error: null })
    mockSignOutIfCurrent.mockResolvedValue(false)
    mockSignOut.mockImplementation(async () => makeAnonymous())
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
  })

  it('distinguishes Terms and Privacy links without relying on brand color', async () => {
    await renderLogin()

    expect(screen.getByRole('link', { name: 'termsOfService' })).toHaveStyle({
      textDecoration: 'underline',
    })
    expect(screen.getByRole('link', { name: 'privacyPolicy' })).toHaveStyle({
      textDecoration: 'underline',
    })
  })

  it('drops a delayed A profile after B wins', async () => {
    const profileRead = deferred<{ data: ReturnType<typeof profile>; error: null }>()
    mockProfileMaybeSingle.mockReturnValueOnce(profileRead.promise)
    await renderLogin()
    const sessionA = session('user-a')
    await startPasswordLogin(sessionA)

    makeCurrent(session('user-b'))
    await act(async () => profileRead.resolve({ data: profile('user-a'), error: null }))

    expect(mockPush).not.toHaveBeenCalled()
    expect(mockReplace).not.toHaveBeenCalled()
    expect(mockStoreSetState).not.toHaveBeenCalled()
    expect(mockSignOutIfCurrent).toHaveBeenCalledWith(
      'user-a',
      'access-user-a',
      'refresh-access-user-a'
    )
  })

  it('does not let a delayed OTP-send response mutate the form after B wins', async () => {
    const otpSend = deferred<{ data: object; error: null }>()
    mockSignInWithOtp.mockReturnValueOnce(otpSend.promise)
    await renderLogin()
    fireEvent.change(screen.getByPlaceholderText('you@email.com'), {
      target: { value: 'user-a@example.test' },
    })
    act(() => mockLoginFormProps?.onSwitchToCode())
    act(() => {
      void mockLoginFormProps?.onSendLoginCode()
    })
    await waitFor(() => expect(mockSignInWithOtp).toHaveBeenCalledTimes(1))

    makeCurrent(session('user-b'))
    await act(async () => otpSend.resolve({ data: {}, error: null }))

    expect(mockLoginFormProps?.codeSent).toBe(false)
    expect(window.sessionStorage.getItem('otp_countdown_end')).toBeNull()
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('drops A1 when the same principal rotates to A2 during its profile read', async () => {
    const profileRead = deferred<{ data: ReturnType<typeof profile>; error: null }>()
    mockProfileMaybeSingle.mockReturnValueOnce(profileRead.promise)
    await renderLogin()
    const sessionA1 = session('user-a', 'access-a1')
    await startPasswordLogin(sessionA1)

    window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session('user-a', 'access-a2')))
    await act(async () => profileRead.resolve({ data: profile('user-a'), error: null }))

    expect(mockPush).not.toHaveBeenCalled()
    expect(mockStoreSetState).not.toHaveBeenCalled()
    expect(mockSignOutIfCurrent).toHaveBeenCalledWith('user-a', 'access-a1', 'refresh-access-a1')
  })

  it('drops a login completion after logout and after unmount', async () => {
    const logoutRead = deferred<{ data: ReturnType<typeof profile>; error: null }>()
    mockProfileMaybeSingle.mockReturnValueOnce(logoutRead.promise)
    const firstView = await renderLogin()
    await startPasswordLogin(session('user-a'))

    makeAnonymous()
    act(() => mockAuthStateCallback?.('SIGNED_OUT', null))
    await act(async () => logoutRead.resolve({ data: profile('user-a'), error: null }))
    expect(mockPush).not.toHaveBeenCalled()
    firstView.unmount()

    jest.clearAllMocks()
    installProfileBuilder()
    const unmountRead = deferred<{ data: ReturnType<typeof profile>; error: null }>()
    mockProfileMaybeSingle.mockReturnValueOnce(unmountRead.promise)
    const secondView = await renderLogin()
    await startPasswordLogin(session('user-c'))
    secondView.unmount()
    await act(async () => unmountRead.resolve({ data: profile('user-c'), error: null }))

    expect(mockPush).not.toHaveBeenCalled()
    expect(mockStoreSetState).not.toHaveBeenCalled()
    expect(mockSignOutIfCurrent).toHaveBeenCalledWith(
      'user-c',
      'access-user-c',
      'refresh-access-user-c'
    )
  })

  it('fails closed and rolls back the exact session when its profile is missing', async () => {
    mockProfileMaybeSingle.mockResolvedValueOnce({ data: null, error: null })
    mockSignOutIfCurrent.mockImplementationOnce(async () => {
      makeAnonymous()
      return true
    })
    await renderLogin()
    await startPasswordLogin(session('user-a'))

    await waitFor(() =>
      expect(mockSignOutIfCurrent).toHaveBeenCalledWith(
        'user-a',
        'access-user-a',
        'refresh-access-user-a'
      )
    )
    expect(mockPush).not.toHaveBeenCalled()
    expect(mockStoreSetState).not.toHaveBeenCalled()
    expect(await screen.findByText('Profile provisioning is incomplete')).toBeInTheDocument()
  })

  it('lets a newer exact B auth event finish while delayed A is discarded', async () => {
    const profileA = deferred<{ data: ReturnType<typeof profile>; error: null }>()
    mockProfileMaybeSingle
      .mockReturnValueOnce(profileA.promise)
      .mockResolvedValueOnce({ data: profile('user-b'), error: null })
    await renderLogin()
    const sessionA = session('user-a')
    makeCurrent(sessionA)
    act(() => mockAuthStateCallback?.('SIGNED_IN', sessionA))
    await waitFor(() => expect(mockGetUser).toHaveBeenCalledWith('access-user-a'))

    const sessionB = session('user-b')
    makeCurrent(sessionB)
    act(() => mockAuthStateCallback?.('SIGNED_IN', sessionB))
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/'))
    await act(async () => profileA.resolve({ data: profile('user-a'), error: null }))

    expect(mockPush).toHaveBeenCalledTimes(1)
    expect(mockPush).toHaveBeenCalledWith('/')
    expect(mockSignOutIfCurrent).toHaveBeenCalledWith(
      'user-a',
      'access-user-a',
      'refresh-access-user-a'
    )
  })

  it('coalesces duplicate events for the same exact external session', async () => {
    const profileRead = deferred<{ data: ReturnType<typeof profile>; error: null }>()
    mockProfileMaybeSingle.mockReturnValueOnce(profileRead.promise)
    await renderLogin()
    const sessionA = session('user-a')
    makeCurrent(sessionA)

    act(() => mockAuthStateCallback?.('SIGNED_IN', sessionA))
    await waitFor(() => expect(mockGetUser).toHaveBeenCalledWith('access-user-a'))
    act(() => mockAuthStateCallback?.('SIGNED_IN', sessionA))
    await act(async () => profileRead.resolve({ data: profile('user-a'), error: null }))

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/'))
    expect(mockGetUser).toHaveBeenCalledTimes(1)
    expect(mockProfileMaybeSingle).toHaveBeenCalledTimes(1)
    expect(mockPush).toHaveBeenCalledTimes(1)
    expect(mockSignOutIfCurrent).not.toHaveBeenCalled()
  })

  it('atomically stores only the verified add-account identity before clearing its flag', async () => {
    mockSearchParams = new URLSearchParams('addAccount=true&returnUrl=%2Ffeed')
    window.localStorage.setItem('arena_adding_account', 'true')
    mockAccounts = [
      {
        userId: 'user-old',
        email: 'old@example.test',
        handle: 'old',
        avatarUrl: null,
        refreshToken: 'refresh-old',
        lastActiveAt: '2026-01-01T00:00:00.000Z',
        isActive: true,
      },
    ]
    mockProfileMaybeSingle.mockResolvedValueOnce({ data: profile('user-b'), error: null })
    await renderLogin()
    const sessionB = session('user-b')
    await startPasswordLogin(sessionB)

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/'))
    expect(mockAccounts).toEqual([
      expect.objectContaining({ userId: 'user-old', isActive: false }),
      expect.objectContaining({
        userId: 'user-b',
        email: 'user-b@example.test',
        handle: 'handle-user-b',
        refreshToken: sessionB.refresh_token,
        isActive: true,
      }),
    ])
    expect(window.localStorage.getItem('arena_adding_account')).toBeNull()
    expect(mockGetUser).toHaveBeenCalledWith('access-user-b')
  })

  it('uses the updated exact session bearer for attribution, referral and welcome', async () => {
    mockSearchParams = new URLSearchParams('utm_source=launch&ref=friend_1')
    const sessionA1 = session('user-a', 'access-a1')
    const sessionA2 = session('user-a', 'access-a2')
    mockVerifyOtp.mockImplementationOnce(async () => {
      makeCurrent(sessionA1)
      return { data: { session: sessionA1, user: sessionA1.user }, error: null }
    })
    mockUpdateUserWithSession.mockImplementationOnce(async () => {
      window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(sessionA2))
      return { data: { session: sessionA2, user: sessionA2.user }, error: null }
    })
    mockProfileMaybeSingle
      .mockResolvedValueOnce({ data: profile('user-a'), error: null })
      .mockResolvedValueOnce({ data: profile('user-a'), error: null })
      .mockResolvedValueOnce({ data: { id: 'user-a' }, error: null })

    await renderLogin()
    fireEvent.click(screen.getByRole('button', { name: 'loginSwitchToRegister' }))
    await screen.findByTestId('verify-code')
    act(() => {
      mockRegisterFormProps?.setCode('123456')
    })
    fireEvent.click(screen.getByTestId('verify-code'))
    await waitFor(() => expect(mockRegisterFormProps?.codeVerified).toBe(true))

    act(() => {
      mockRegisterFormProps?.setPassword('Correct-Horse-42!')
      mockRegisterFormProps?.setHandle('new_handle')
    })
    fireEvent.click(screen.getByTestId('set-password'))

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/onboarding?returnUrl=%2F'))
    const calls = (global.fetch as jest.Mock).mock.calls.filter(([url]) =>
      ['/api/profile/attribution', '/api/referral/apply', '/api/email/welcome'].includes(
        url as string
      )
    )
    expect(calls).toHaveLength(3)
    for (const [, request] of calls) {
      expect(request.headers.Authorization).toBe('Bearer access-a2')
    }
    expect(mockUpdateUserWithSession).toHaveBeenCalledWith(
      { password: 'Correct-Horse-42!' },
      expect.objectContaining({ expectedUserId: 'user-a' })
    )
  })
})
