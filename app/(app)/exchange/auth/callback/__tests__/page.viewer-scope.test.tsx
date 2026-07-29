import React from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import type { AuthSessionReturn } from '@/lib/hooks/useAuthSession'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  commitViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'

const mockAuthedFetch = jest.fn()
const mockRouterPush = jest.fn()
let mockSearchParams = new URLSearchParams('code=oauth-code&state=binance.random-state')

jest.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({ push: mockRouterPush }),
}))

jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
}))

jest.mock('@/app/components/base', () => ({
  Box: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

import { ExchangeAuthCallbackContent } from '../page'

type CallbackResult = {
  ok: boolean
  status: number
  data: {
    success?: boolean
    error?: string
    data?: { viewerId?: string; exchange?: string }
  } | null
  stale?: boolean
}

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

function success(viewerId: string, exchange = 'binance'): CallbackResult {
  return {
    ok: true,
    status: 200,
    data: { success: true, data: { viewerId, exchange } },
  }
}

describe('ExchangeAuthCallbackContent viewer ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
    mockSearchParams = new URLSearchParams('code=oauth-code&state=binance.random-state')
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('derives exchange from state and submits no client-controlled userId', async () => {
    const scope = synchronizeViewerScope(true, 'user-a')
    const auth = authFor('user-a', scope.sessionGeneration)
    mockAuthedFetch.mockResolvedValue({
      ok: false,
      status: 400,
      data: { error: 'Invalid state' },
    })

    render(<ExchangeAuthCallbackContent auth={auth} />)

    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))
    expect(mockAuthedFetch).toHaveBeenCalledWith(
      '/api/exchange/oauth/callback',
      'POST',
      jwt('user-a'),
      {
        exchange: 'binance',
        code: 'oauth-code',
        state: 'binance.random-state',
      },
      20_000,
      {
        expectedUserId: 'user-a',
        expectedSessionGeneration: scope.sessionGeneration,
        signal: expect.any(AbortSignal),
      }
    )
    expect(mockAuthedFetch.mock.calls[0][3]).not.toHaveProperty('userId')
  })

  it('aborts A and drops its success/navigation after switching to B', async () => {
    const scopeA = synchronizeViewerScope(true, 'user-a')
    const authA = authFor('user-a', scopeA.sessionGeneration)
    const callbackA = deferred<CallbackResult>()
    mockAuthedFetch
      .mockReturnValueOnce(callbackA.promise)
      .mockResolvedValueOnce({ ok: false, status: 400, data: { error: 'Invalid state for B' } })
    const view = render(<ExchangeAuthCallbackContent auth={authA} redirectDelayMs={0} />)

    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))
    const signalA = mockAuthedFetch.mock.calls[0][5].signal as AbortSignal

    const authB = switchViewer('user-b')
    view.rerender(<ExchangeAuthCallbackContent auth={authB} redirectDelayMs={0} />)

    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(2))
    expect(signalA.aborted).toBe(true)
    await screen.findByText('Invalid state for B')

    await act(async () => {
      callbackA.resolve(success('user-a'))
      await Promise.resolve()
    })

    expect(mockRouterPush).not.toHaveBeenCalledWith('/settings')
    expect(screen.queryByText('authorizationSuccess')).not.toBeInTheDocument()
  })

  it('requires a strict viewer/exchange ACK before showing success', async () => {
    const scope = synchronizeViewerScope(true, 'user-a')
    const auth = authFor('user-a', scope.sessionGeneration)
    mockAuthedFetch.mockResolvedValue(success('user-b'))

    render(<ExchangeAuthCallbackContent auth={auth} redirectDelayMs={0} />)

    expect(await screen.findAllByText('authorizationFailed')).toHaveLength(2)
    expect(screen.queryByText('authorizationSuccess')).not.toBeInTheDocument()
    expect(mockRouterPush).not.toHaveBeenCalledWith('/settings')
  })

  it('navigates only while the successful callback viewer is still current', async () => {
    jest.useFakeTimers()
    const scope = synchronizeViewerScope(true, 'user-a')
    const auth = authFor('user-a', scope.sessionGeneration)
    mockAuthedFetch.mockResolvedValue(success('user-a'))

    render(<ExchangeAuthCallbackContent auth={auth} redirectDelayMs={50} />)

    await screen.findByText('authorizationSuccess')
    expect(mockRouterPush).not.toHaveBeenCalledWith('/settings')
    act(() => {
      jest.advanceTimersByTime(50)
    })
    expect(mockRouterPush).toHaveBeenCalledWith('/settings')
  })

  it('rejects a conflicting query exchange instead of submitting an ambiguous callback', () => {
    const scope = synchronizeViewerScope(true, 'user-a')
    const auth = authFor('user-a', scope.sessionGeneration)
    mockSearchParams = new URLSearchParams(
      'code=oauth-code&state=binance.random-state&exchange=bybit'
    )

    render(<ExchangeAuthCallbackContent auth={auth} />)

    expect(screen.getByText('missingAuthParams')).toBeInTheDocument()
    expect(mockAuthedFetch).not.toHaveBeenCalled()
  })
})
