import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AuthSessionReturn } from '@/lib/hooks/useAuthSession'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  commitViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'

const mockRequestExchangeOAuthUrl = jest.fn()
const mockRouterPush = jest.fn()
const mockRouterReplace = jest.fn()
const mockShowToast = jest.fn()
let mockSearchParams = new URLSearchParams('exchange=binance')

jest.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({ push: mockRouterPush, replace: mockRouterReplace }),
}))

jest.mock('../oauth-client', () => ({
  requestExchangeOAuthUrl: (...args: unknown[]) => mockRequestExchangeOAuthUrl(...args),
}))

jest.mock('@/app/components/base', () => ({
  Box: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children?: React.ReactNode
    disabled?: boolean
    onClick?: () => void
  }) => (
    <button disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}))

jest.mock('@/app/components/ui/ExchangeLogo', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

import { ExchangeAuthContent } from '../page'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function jwt(userId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({ sub: userId })}.signature`
}

function authFor(userId: string, sessionGeneration: number): AuthSessionReturn {
  return {
    user: { id: userId, email: `${userId}@example.com`, identities: [] },
    userId,
    email: `${userId}@example.com`,
    accessToken: jwt(userId),
    isLoggedIn: true,
    loading: false,
    authChecked: true,
    viewerKey: `user:${userId}`,
    sessionGeneration,
  } as unknown as AuthSessionReturn
}

function switchViewer(userId: string): AuthSessionReturn {
  const transition = beginViewerTransition(userId)
  const scope = commitViewerTransition(transition, userId)!
  return authFor(userId, scope.sessionGeneration)
}

describe('ExchangeAuthContent OAuth viewer ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
    mockSearchParams = new URLSearchParams('exchange=binance')
  })

  it('binds authorize to the exact JWT generation and rejects a double click', async () => {
    const scope = synchronizeViewerScope(true, 'user-a')
    const auth = authFor('user-a', scope.sessionGeneration)
    const authorization = deferred<string>()
    mockRequestExchangeOAuthUrl.mockReturnValue(authorization.promise)
    const redirect = jest.fn()

    render(<ExchangeAuthContent auth={auth} redirectToOAuth={redirect} />)

    const authorize = screen.getByRole('button', { name: 'useOAuthAuthorize' })
    fireEvent.click(authorize)
    fireEvent.click(authorize)

    await waitFor(() => expect(mockRequestExchangeOAuthUrl).toHaveBeenCalledTimes(1))
    expect(mockRequestExchangeOAuthUrl).toHaveBeenCalledWith(
      'binance',
      {
        accessToken: jwt('user-a'),
        sessionGeneration: scope.sessionGeneration,
        userId: 'user-a',
      },
      expect.any(AbortSignal)
    )
    expect(screen.getByRole('button', { name: 'authorizing' })).toBeDisabled()
    expect(redirect).not.toHaveBeenCalled()
  })

  it('aborts and drops A authorize URL immediately after switching to B', async () => {
    const scopeA = synchronizeViewerScope(true, 'user-a')
    const authA = authFor('user-a', scopeA.sessionGeneration)
    const authorizationA = deferred<string>()
    mockRequestExchangeOAuthUrl.mockReturnValue(authorizationA.promise)
    const redirect = jest.fn()
    const view = render(<ExchangeAuthContent auth={authA} redirectToOAuth={redirect} />)

    fireEvent.click(screen.getByRole('button', { name: 'useOAuthAuthorize' }))
    await waitFor(() => expect(mockRequestExchangeOAuthUrl).toHaveBeenCalledTimes(1))
    const signalA = mockRequestExchangeOAuthUrl.mock.calls[0][2] as AbortSignal

    const authB = switchViewer('user-b')
    view.rerender(<ExchangeAuthContent auth={authB} redirectToOAuth={redirect} />)

    await waitFor(() => expect(signalA.aborted).toBe(true))
    expect(screen.getByRole('button', { name: 'useOAuthAuthorize' })).toBeEnabled()

    await act(async () => {
      authorizationA.resolve('https://accounts.binance.com/authorize-for-user-a')
      await Promise.resolve()
    })

    expect(redirect).not.toHaveBeenCalled()
    expect(screen.queryByText('authorizationFailed')).not.toBeInTheDocument()
    expect(mockShowToast).not.toHaveBeenCalled()
  })

  it('cancels an authorize operation before navigating to the API-key path', async () => {
    const scope = synchronizeViewerScope(true, 'user-a')
    const auth = authFor('user-a', scope.sessionGeneration)
    const authorization = deferred<string>()
    mockRequestExchangeOAuthUrl.mockReturnValue(authorization.promise)
    const redirect = jest.fn()

    render(<ExchangeAuthContent auth={auth} redirectToOAuth={redirect} />)
    fireEvent.click(screen.getByRole('button', { name: 'useOAuthAuthorize' }))
    await waitFor(() => expect(mockRequestExchangeOAuthUrl).toHaveBeenCalledTimes(1))
    const signal = mockRequestExchangeOAuthUrl.mock.calls[0][2] as AbortSignal

    fireEvent.click(screen.getByRole('button', { name: 'useApiKeyAuthorize' }))

    expect(signal.aborted).toBe(true)
    expect(mockRouterPush).toHaveBeenCalledWith('/exchange/auth/api-key?exchange=binance')
    await act(async () => {
      authorization.resolve('https://accounts.binance.com/stale')
      await Promise.resolve()
    })
    expect(redirect).not.toHaveBeenCalled()
  })

  it('redirects only the still-current viewer to the accepted HTTPS URL', async () => {
    const scope = synchronizeViewerScope(true, 'user-a')
    const auth = authFor('user-a', scope.sessionGeneration)
    mockRequestExchangeOAuthUrl.mockResolvedValue('https://accounts.binance.com/authorize')
    const redirect = jest.fn()

    render(<ExchangeAuthContent auth={auth} redirectToOAuth={redirect} />)
    fireEvent.click(screen.getByRole('button', { name: 'useOAuthAuthorize' }))

    await waitFor(() =>
      expect(redirect).toHaveBeenCalledWith('https://accounts.binance.com/authorize')
    )
  })
})
