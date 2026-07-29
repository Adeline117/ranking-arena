import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AuthSessionReturn } from '@/lib/hooks/useAuthSession'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  commitViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'

const mockAuthedFetch = jest.fn()
const mockShowToast = jest.fn()
const mockRouterPush = jest.fn()
const mockRouterReplace = jest.fn()
const mockRefreshSession = jest.fn()
const mockRouter = { push: mockRouterPush, replace: mockRouterReplace }
let mockAuth: AuthSessionReturn

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => ({ get: (key: string) => (key === 'exchange' ? 'binance' : null) }),
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuth,
}))

jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ language: 'en', t: (key: string) => key }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/app/components/ui/ExchangeLogo', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/app/components/ui/ErrorState', () => ({
  __esModule: true,
  default: ({ description }: { description: string }) => <div role="alert">{description}</div>,
}))

jest.mock('@/app/components/ui/PasswordInput', () => ({
  __esModule: true,
  default: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input {...props} type="password" />
  ),
}))

jest.mock('@/app/components/base', () => ({
  Box: ({
    children,
    bg: _bg,
    p: _p,
    radius: _radius,
    border: _border,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & {
    bg?: string
    p?: number
    radius?: string
    border?: string
  }) => <div {...props}>{children}</div>,
  Text: ({
    children,
    size: _size,
    weight: _weight,
    color: _color,
    ...props
  }: React.HTMLAttributes<HTMLSpanElement> & {
    size?: string
    weight?: string
    color?: string
  }) => <span {...props}>{children}</span>,
  Button: ({
    children,
    variant: _variant,
    size: _size,
    fullWidth: _fullWidth,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string
    size?: string
    fullWidth?: boolean
  }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}))

jest.mock('../exchange-configs', () => ({
  EXCHANGE_CONFIGS: {
    binance: {
      id: 'binance',
      name: 'Binance',
      needsPassphrase: false,
      apiManagementUrl: 'https://example.com/api',
      steps: { en: [], zh: [], ja: [], ko: [] },
    },
  },
}))

import { ApiKeyAuthContent } from '../page'

type ConnectResult = {
  ok: boolean
  status: number
  stale?: boolean
  data: {
    success?: boolean
    error?: string
    data?: { viewerId?: string; exchange?: string }
  } | null
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function jwt(userId: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: userId })).toString('base64url')
  return `eyJhbGciOiJub25lIn0.${payload}.signature`
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
    refreshSession: mockRefreshSession,
  } as unknown as AuthSessionReturn
}

function switchToUserB(rerender: () => void): number {
  const transition = beginViewerTransition('user-b')
  const scope = commitViewerTransition(transition, 'user-b')!
  mockAuth = authFor('user-b', scope.sessionGeneration)
  rerender()
  return scope.sessionGeneration
}

function fillCredentials(apiKey = 'api-key-for-user-a', secret = 'api-secret-for-user-a') {
  fireEvent.change(screen.getByPlaceholderText('pasteYourApiKey'), {
    target: { value: apiKey },
  })
  fireEvent.change(screen.getByPlaceholderText('pasteYourApiSecret'), {
    target: { value: secret },
  })
}

function validAck(userId: string): ConnectResult {
  return {
    ok: true,
    status: 200,
    data: {
      success: true,
      data: { viewerId: userId, exchange: 'binance' },
    },
  }
}

describe('exchange API-key authorization viewer ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
    const scope = synchronizeViewerScope(true, 'user-a')
    mockAuth = authFor('user-a', scope.sessionGeneration)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: jest.fn() },
    })
  })

  it('uses only the canonical auth session and scoped API client', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/(app)/exchange/auth/api-key/page.tsx'),
      'utf8'
    )

    expect(source).toContain("from '@/lib/hooks/useAuthSession'")
    expect(source).toContain('expectedSessionGeneration: viewer.sessionGeneration')
    expect(source).not.toContain("from '@/lib/supabase/client'")
    expect(source).not.toContain('auth.getSession')
    expect(source).not.toContain('bootstrapClientAuth')
  })

  it('submits A secrets only with A token and drops A completion after switching to B', async () => {
    const connectA = deferred<ConnectResult>()
    mockAuthedFetch.mockReturnValue(connectA.promise)
    const view = render(<ApiKeyAuthContent />)
    fillCredentials()

    const submit = screen.getByRole('button', { name: 'bindExchangeName' })
    fireEvent.click(submit)
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))
    const call = mockAuthedFetch.mock.calls[0]
    expect(call).toEqual([
      '/api/exchange/connect',
      'POST',
      jwt('user-a'),
      {
        exchange: 'binance',
        apiKey: 'api-key-for-user-a',
        apiSecret: 'api-secret-for-user-a',
        passphrase: undefined,
      },
      30_000,
      expect.objectContaining({
        expectedUserId: 'user-a',
        expectedSessionGeneration: mockAuth.sessionGeneration,
        signal: expect.any(AbortSignal),
      }),
    ])

    act(() => {
      switchToUserB(() => view.rerender(<ApiKeyAuthContent />))
    })

    expect(screen.getByPlaceholderText('pasteYourApiKey')).toHaveValue('')
    expect(screen.getByPlaceholderText('pasteYourApiSecret')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'bindExchangeName' })).toBeDisabled()
    expect((call[5] as { signal: AbortSignal }).signal.aborted).toBe(true)

    await act(async () => {
      connectA.resolve(validAck('user-a'))
      await Promise.resolve()
    })

    expect(mockShowToast).not.toHaveBeenCalledWith('bindSuccess', 'success')
    expect(mockRouterPush).not.toHaveBeenCalledWith('/settings')
    expect(mockAuthedFetch).toHaveBeenCalledTimes(1)
  })

  it('honors process-wide transition invalidation before React rerenders', () => {
    render(<ApiKeyAuthContent />)
    fillCredentials()

    beginViewerTransition('user-b')
    fireEvent.click(screen.getByRole('button', { name: 'bindExchangeName' }))

    expect(mockAuthedFetch).not.toHaveBeenCalled()
    expect(mockShowToast).not.toHaveBeenCalled()
    expect(mockRouterPush).not.toHaveBeenCalledWith('/settings')
  })

  it('drops a clipboard result and toast when its viewer expires', async () => {
    const clipboardA = deferred<string>()
    ;(navigator.clipboard.readText as jest.Mock).mockReturnValue(clipboardA.promise)
    const view = render(<ApiKeyAuthContent />)

    fireEvent.click(screen.getAllByRole('button', { name: 'paste' })[0])
    expect(navigator.clipboard.readText).toHaveBeenCalledTimes(1)

    act(() => {
      switchToUserB(() => view.rerender(<ApiKeyAuthContent />))
    })

    await act(async () => {
      clipboardA.resolve('api-key-secret-from-user-a')
      await clipboardA.promise
    })

    expect(screen.getByPlaceholderText('pasteYourApiKey')).toHaveValue('')
    expect(mockShowToast).not.toHaveBeenCalledWith('pasted', 'success')
  })

  it('uses a synchronous guard and navigates only for an exact ACK', async () => {
    const connect = deferred<ConnectResult>()
    mockAuthedFetch.mockReturnValue(connect.promise)
    render(<ApiKeyAuthContent />)
    fillCredentials()

    const submit = screen.getByRole('button', { name: 'bindExchangeName' })
    fireEvent.click(submit)
    fireEvent.click(submit)

    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))
    expect(submit).toBeDisabled()

    connect.resolve(validAck('user-a'))
    await waitFor(() => expect(mockRouterPush).toHaveBeenCalledWith('/settings'))
    expect(mockShowToast).toHaveBeenCalledTimes(1)
    expect(mockShowToast).toHaveBeenCalledWith('bindSuccess', 'success')
  })

  it.each([
    ['wrong viewer', { viewerId: 'user-b', exchange: 'binance' }],
    ['wrong exchange', { viewerId: 'user-a', exchange: 'bitget' }],
  ])('fails closed for an otherwise successful %s ACK', async (_label, ack) => {
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: { success: true, data: ack },
    })
    render(<ApiKeyAuthContent />)
    fillCredentials()

    fireEvent.click(screen.getByRole('button', { name: 'bindExchangeName' }))

    expect(await screen.findByText('bindServerErrorRetry')).toBeInTheDocument()
    expect(mockShowToast).not.toHaveBeenCalledWith('bindSuccess', 'success')
    expect(mockRouterPush).not.toHaveBeenCalledWith('/settings')
    expect(screen.getByPlaceholderText('pasteYourApiKey')).toHaveValue('api-key-for-user-a')
  })
})
