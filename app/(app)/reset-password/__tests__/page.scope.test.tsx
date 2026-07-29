import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Session, User } from '@supabase/supabase-js'
import {
  AUTH_STORAGE_KEY,
  __resetAuthOperationsForTests,
  beginAuthIdentityOperation,
  completeAuthIdentityOperation,
  guardedAuthStorage,
} from '@/lib/auth/session-operation'
import { __resetViewerScopeForTests, synchronizeViewerScope } from '@/lib/auth/viewer-scope'

const mockPush = jest.fn()
const mockGetSession = jest.fn()
const mockGetUser = jest.fn()
const mockResetPasswordForEmail = jest.fn()
const mockUpdateUserWithSession = jest.fn()
const mockUnsubscribe = jest.fn()
let mockAuthStateCallback: ((event: string, session: Session | null) => void) | null = null
let mockAuthState: Record<string, unknown> = {}

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => new URLSearchParams(),
}))

jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
      getUser: (...args: unknown[]) => mockGetUser(...args),
      resetPasswordForEmail: (...args: unknown[]) => mockResetPasswordForEmail(...args),
      onAuthStateChange: (callback: (event: string, session: Session | null) => void) => {
        mockAuthStateCallback = callback
        return { data: { subscription: { unsubscribe: mockUnsubscribe } } }
      },
    },
  },
}))

jest.mock('@/lib/auth/token-refresh', () => ({
  tokenRefreshCoordinator: {
    updateUserWithSession: (...args: unknown[]) => mockUpdateUserWithSession(...args),
  },
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuthState,
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    language: 'en',
    setLanguage: jest.fn(),
    t: (key: string) => key,
  }),
}))

import ResetPasswordPage from '../page'

function user(userId: string): User {
  return {
    id: userId,
    email: `${userId}@example.test`,
    aud: 'authenticated',
    role: 'authenticated',
    created_at: '2026-07-29T00:00:00.000Z',
    app_metadata: {},
    user_metadata: {},
  } as User
}

function session(userId: string, accessToken = `access-${userId}`): Session {
  return {
    access_token: accessToken,
    refresh_token: `refresh-${userId}`,
    expires_in: 3600,
    token_type: 'bearer',
    user: user(userId),
  }
}

function authState(value: Session | null, sessionGeneration: number): Record<string, unknown> {
  return {
    authChecked: true,
    isLoggedIn: value !== null,
    user: value?.user ?? null,
    userId: value?.user.id ?? null,
    accessToken: value?.access_token ?? null,
    sessionGeneration,
  }
}

function makeSteadySession(value: Session): number {
  const operation = beginAuthIdentityOperation(value.user.id)
  completeAuthIdentityOperation(operation, value.user.id)
  window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(value))
  return synchronizeViewerScope(true, value.user.id).sessionGeneration
}

function makeRecoverySession(value: Session): number {
  window.history.replaceState(
    {},
    '',
    `/reset-password#access_token=${value.access_token}&refresh_token=${value.refresh_token}&type=recovery`
  )
  guardedAuthStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(value))
  return synchronizeViewerScope(true, value.user.id).sessionGeneration
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function enterStrongPassword(): Promise<void> {
  const inputs = await screen.findAllByPlaceholderText('••••••')
  fireEvent.change(inputs[0], { target: { value: 'VeryStrong!Password123' } })
  fireEvent.change(inputs[1], { target: { value: 'VeryStrong!Password123' } })
}

describe('password recovery identity scope', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuthStateCallback = null
    window.history.replaceState({}, '', '/')
    window.localStorage.clear()
    __resetAuthOperationsForTests()
    __resetViewerScopeForTests()
    mockAuthState = authState(null, synchronizeViewerScope(true, null).sessionGeneration)
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null })
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error('invalid token') })
  })

  it('does not let an invalid recovery hash update the already signed-in B', async () => {
    const sessionB = session('user-b')
    const generationB = makeSteadySession(sessionB)
    mockAuthState = authState(sessionB, generationB)
    window.history.replaceState({}, '', '/reset-password#access_token=invalid&type=recovery')

    render(<ResetPasswordPage />)

    expect(await screen.findByPlaceholderText('you@email.com')).toBeInTheDocument()
    expect(screen.queryByText('resetPasswordButton')).not.toBeInTheDocument()
    expect(mockGetSession).not.toHaveBeenCalled()
    expect(mockUpdateUserWithSession).not.toHaveBeenCalled()
  })

  it('bootstraps a pre-effect recovery event and updates only its exact viewer scope once', async () => {
    const sessionA = session('user-a', 'recovery-access-a')
    const generationA = makeRecoverySession(sessionA)
    mockAuthState = authState(sessionA, generationA)
    mockGetSession.mockResolvedValue({ data: { session: sessionA }, error: null })
    mockGetUser.mockResolvedValue({ data: { user: sessionA.user }, error: null })
    mockUpdateUserWithSession.mockResolvedValue({
      data: { user: sessionA.user, session: sessionA },
      error: null,
    })

    render(<ResetPasswordPage />)
    await enterStrongPassword()
    const submit = screen.getByText('resetPasswordButton')
    act(() => {
      // React has not rendered disabled=true between these two same-tick clicks.
      submit.click()
      submit.click()
    })

    await waitFor(() =>
      expect(mockUpdateUserWithSession).toHaveBeenCalledWith(
        { password: 'VeryStrong!Password123' },
        { expectedUserId: 'user-a', sessionGeneration: generationA }
      )
    )
    expect(mockUpdateUserWithSession).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('resetPasswordSuccess')).toBeInTheDocument()
  })

  it('drops PASSWORD_RECOVERY(A) completion after the canonical viewer switches to B', async () => {
    const sessionA = session('user-a', 'recovery-access-a')
    const generationA = makeRecoverySession(sessionA)
    mockAuthState = authState(sessionA, generationA)
    mockGetSession.mockReturnValue(new Promise(() => {}))
    mockGetUser.mockResolvedValue({ data: { user: sessionA.user }, error: null })
    const updateA = deferred<{
      data: { user: User; session: Session }
      error: null
    }>()
    mockUpdateUserWithSession.mockReturnValue(updateA.promise)

    const view = render(<ResetPasswordPage />)
    await waitFor(() => expect(mockAuthStateCallback).not.toBeNull())
    act(() => {
      mockAuthStateCallback?.('PASSWORD_RECOVERY', sessionA)
    })
    await enterStrongPassword()
    fireEvent.click(screen.getByText('resetPasswordButton'))
    await waitFor(() => expect(mockUpdateUserWithSession).toHaveBeenCalledTimes(1))

    const sessionB = session('user-b')
    const generationB = makeSteadySession(sessionB)
    mockAuthState = authState(sessionB, generationB)
    view.rerender(<ResetPasswordPage />)
    await screen.findByPlaceholderText('you@email.com')

    await act(async () => {
      updateA.resolve({ data: { user: sessionA.user, session: sessionA }, error: null })
      await updateA.promise
    })

    expect(screen.queryByText('resetPasswordSuccess')).not.toBeInTheDocument()
    expect(mockPush).not.toHaveBeenCalled()
    expect(mockUpdateUserWithSession).toHaveBeenCalledWith(
      { password: 'VeryStrong!Password123' },
      { expectedUserId: 'user-a', sessionGeneration: generationA }
    )
  })

  it('rejects a success response whose user/session acknowledge B instead of recovery A', async () => {
    const sessionA = session('user-a', 'recovery-access-a')
    const sessionB = session('user-b')
    const generationA = makeRecoverySession(sessionA)
    mockAuthState = authState(sessionA, generationA)
    mockGetSession.mockResolvedValue({ data: { session: sessionA }, error: null })
    mockGetUser.mockResolvedValue({ data: { user: sessionA.user }, error: null })
    mockUpdateUserWithSession.mockResolvedValue({
      data: { user: sessionB.user, session: sessionB },
      error: null,
    })

    render(<ResetPasswordPage />)
    await enterStrongPassword()
    fireEvent.click(screen.getByText('resetPasswordButton'))

    expect(await screen.findByText('loginResetFailed')).toBeInTheDocument()
    expect(screen.queryByText('resetPasswordSuccess')).not.toBeInTheDocument()
    expect(mockPush).not.toHaveBeenCalled()
  })
})
