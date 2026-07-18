import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AuthSessionReturn } from '@/lib/hooks/useAuthSession'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  commitViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'

const mockAuthedFetch = jest.fn()
const mockApiCheckout = jest.fn()
const mockShowToast = jest.fn()
const mockClipboardWrite = jest.fn()
let mockAuth: AuthSessionReturn

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuth,
}))

jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
}))

jest.mock('@/lib/hooks/useApiCheckout', () => ({
  useApiCheckout: () => ({ checkout: mockApiCheckout, isLoading: false, error: null }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/app/components/base', () => {
  const React = jest.requireActual<typeof import('react')>('react')
  return {
    Box: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) =>
      React.createElement('div', props, children),
    Text: ({
      children,
      size: _size,
      weight: _weight,
      ...props
    }: React.HTMLAttributes<HTMLSpanElement> & { size?: string; weight?: string }) =>
      React.createElement('span', props, children),
    Button: ({
      children,
      size: _size,
      variant: _variant,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) =>
      React.createElement('button', props, children),
  }
})

jest.mock('../components/shared', () => {
  const React = jest.requireActual<typeof import('react')>('react')
  return {
    SectionCard: ({ children, id }: { children: React.ReactNode; id: string }) =>
      React.createElement('section', { id }, children),
    getInputStyle: () => ({}),
  }
})

jest.mock('@/lib/utils/format', () => ({
  formatDateLocalized: (value: string) => value,
}))

import { ApiKeysSection } from '../components/ApiKeysSection'

type FetchResult = {
  ok: boolean
  status: number
  data: unknown
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
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value))
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
  return `${encode({ alg: 'none' })}.${encode({ sub: userId })}.signature`
}

function authFor(userId: string, sessionGeneration: number) {
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

function apiKey(userId: string) {
  return {
    id: `key-${userId}`,
    name: `${userId} private key`,
    key: `arena_${userId}_masked`,
    tier: 'starter',
    daily_limit: 1000,
    request_count_today: 2,
    active: true,
    last_used_at: null,
    created_at: '2026-07-15T00:00:00.000Z',
    revoked_at: null,
  }
}

function installListResponses(listB: ReturnType<typeof deferred<FetchResult>>) {
  mockAuthedFetch.mockImplementation((url: string, method: string, accessToken: string | null) => {
    if (url.includes('/usage')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        data: { data: { keys: [], daily: [], totals: {} } },
      })
    }
    if (url === '/api/user/api-keys' && method === 'GET') {
      if (accessToken === jwt('user-a')) {
        return Promise.resolve({ ok: true, status: 200, data: { data: [apiKey('user-a')] } })
      }
      if (accessToken === jwt('user-b')) return listB.promise
    }
    return Promise.resolve({ ok: false, status: 500, data: { error: 'unexpected request' } })
  })
}

function switchToUserB(rerender: () => void): number {
  const transition = beginViewerTransition('user-b')
  const scopeB = commitViewerTransition(transition, 'user-b')!
  mockAuth = authFor('user-b', scopeB.sessionGeneration)
  rerender()
  return scopeB.sessionGeneration
}

describe('ApiKeysSection viewer ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
    const scopeA = synchronizeViewerScope(true, 'user-a')
    mockAuth = authFor('user-a', scopeA.sessionGeneration)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: mockClipboardWrite },
    })
    mockClipboardWrite.mockResolvedValue(undefined)
  })

  it('synchronously hides A state and blocks detached A controls while B loads', async () => {
    const listB = deferred<FetchResult>()
    installListResponses(listB)
    const view = render(<ApiKeysSection />)

    await screen.findByText('user-a private key')
    const oldCopyButton = screen.getByRole('button', { name: 'copy' })
    const oldRevokeButton = screen.getByRole('button', { name: 'revoke' })
    const input = screen.getByPlaceholderText('apiKeyNamePlaceholder') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'A private draft' } })
    expect(input.value).toBe('A private draft')

    let generationB = 0
    act(() => {
      generationB = switchToUserB(() => view.rerender(<ApiKeysSection />))
    })

    expect(screen.queryByText('user-a private key')).not.toBeInTheDocument()
    expect(screen.queryByText('arena_user-a_masked')).not.toBeInTheDocument()
    const inputForB = screen.getByPlaceholderText('apiKeyNamePlaceholder') as HTMLInputElement
    expect(inputForB.value).toBe('')
    expect(inputForB).toBeDisabled()

    fireEvent.click(oldCopyButton)
    fireEvent.click(oldRevokeButton)
    expect(mockClipboardWrite).not.toHaveBeenCalled()
    expect(mockAuthedFetch.mock.calls.some((call) => call[1] === 'PATCH')).toBe(false)

    await act(async () => {
      listB.resolve({ ok: true, status: 200, data: { data: [] } })
    })
    await waitFor(() => expect(inputForB).not.toBeDisabled())

    const userBListCall = mockAuthedFetch.mock.calls.find(
      (call) => call[0] === '/api/user/api-keys' && call[1] === 'GET' && call[2] === jwt('user-b')
    )
    expect(userBListCall?.[5]).toEqual({
      expectedUserId: 'user-b',
      expectedSessionGeneration: generationB,
    })
  })

  it('drops a created A secret that resolves after switching to B', async () => {
    const listB = deferred<FetchResult>()
    const createA = deferred<FetchResult>()
    installListResponses(listB)
    mockAuthedFetch.mockImplementation(
      (url: string, method: string, accessToken: string | null) => {
        if (url === '/api/user/api-keys' && method === 'POST') return createA.promise
        if (url.includes('/usage')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            data: { data: { keys: [], daily: [], totals: {} } },
          })
        }
        if (url === '/api/user/api-keys' && method === 'GET') {
          return accessToken === jwt('user-a')
            ? Promise.resolve({ ok: true, status: 200, data: { data: [apiKey('user-a')] } })
            : listB.promise
        }
        return Promise.resolve({ ok: false, status: 500, data: null })
      }
    )
    const view = render(<ApiKeysSection />)
    await screen.findByText('user-a private key')

    fireEvent.change(screen.getByPlaceholderText('apiKeyNamePlaceholder'), {
      target: { value: 'Alpha secret' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'apiKeyCreate' }))
    await waitFor(() =>
      expect(mockAuthedFetch.mock.calls.some((call) => call[1] === 'POST')).toBe(true)
    )

    act(() => {
      switchToUserB(() => view.rerender(<ApiKeysSection />))
    })
    await act(async () => {
      createA.resolve({
        ok: true,
        status: 201,
        data: { data: { key: 'arena_sk_full_secret_for_a' } },
      })
    })

    expect(screen.queryByText('arena_sk_full_secret_for_a')).not.toBeInTheDocument()
    expect(mockShowToast).not.toHaveBeenCalledWith('apiKeyCreatedToast', 'success')
    const postCall = mockAuthedFetch.mock.calls.find((call) => call[1] === 'POST')
    expect(postCall?.[2]).toBe(jwt('user-a'))
    expect(postCall?.[5]).toEqual(
      expect.objectContaining({
        expectedUserId: 'user-a',
        expectedSessionGeneration: expect.any(Number),
      })
    )
  })

  it('discards late A revoke and clipboard completions instead of updating B UI', async () => {
    const listB = deferred<FetchResult>()
    const revokeA = deferred<FetchResult>()
    const clipboardA = deferred<void>()
    installListResponses(listB)
    mockClipboardWrite.mockReturnValue(clipboardA.promise)
    mockAuthedFetch.mockImplementation(
      (url: string, method: string, accessToken: string | null) => {
        if (url === '/api/user/api-keys' && method === 'PATCH') return revokeA.promise
        if (url.includes('/usage')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            data: { data: { keys: [], daily: [], totals: {} } },
          })
        }
        if (url === '/api/user/api-keys' && method === 'GET') {
          return accessToken === jwt('user-a')
            ? Promise.resolve({ ok: true, status: 200, data: { data: [apiKey('user-a')] } })
            : listB.promise
        }
        return Promise.resolve({ ok: false, status: 500, data: null })
      }
    )
    const view = render(<ApiKeysSection />)
    await screen.findByText('user-a private key')

    fireEvent.click(screen.getByRole('button', { name: 'copy' }))
    fireEvent.click(screen.getByRole('button', { name: 'revoke' }))
    await waitFor(() => expect(mockClipboardWrite).toHaveBeenCalledWith('arena_user-a_masked'))
    await waitFor(() =>
      expect(mockAuthedFetch.mock.calls.some((call) => call[1] === 'PATCH')).toBe(true)
    )

    act(() => {
      switchToUserB(() => view.rerender(<ApiKeysSection />))
    })
    await act(async () => {
      clipboardA.resolve()
      revokeA.resolve({ ok: true, status: 200, data: { success: true } })
      await Promise.resolve()
    })

    expect(mockShowToast).not.toHaveBeenCalledWith('copiedToClipboard', 'success')
    expect(mockShowToast).not.toHaveBeenCalledWith('apiKeyRevokedToast', 'success')
    expect(screen.queryByText('user-a private key')).not.toBeInTheDocument()
    const patchCall = mockAuthedFetch.mock.calls.find((call) => call[1] === 'PATCH')
    expect(patchCall?.[2]).toBe(jwt('user-a'))
    expect(patchCall?.[5]).toEqual(
      expect.objectContaining({
        expectedUserId: 'user-a',
        expectedSessionGeneration: expect.any(Number),
      })
    )
  })

  it('shows a persistent load error and restores controls only after retry succeeds', async () => {
    mockAuthedFetch
      .mockResolvedValueOnce({ ok: false, status: 503, data: { error: 'unavailable' } })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { data: [apiKey('user-a')] },
      })
      .mockResolvedValue({
        ok: true,
        status: 200,
        data: { data: { keys: [], daily: [], totals: {} } },
      })

    render(<ApiKeysSection />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('loadFailedRetryShort')
    expect(screen.queryByText('apiKeyEmpty')).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText('apiKeyNamePlaceholder')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'retry' }))

    expect(await screen.findByText('user-a private key')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText('apiKeyNamePlaceholder')).toBeEnabled()
  })

  it('catches create network failures, preserves the draft, and releases the busy state', async () => {
    mockAuthedFetch.mockImplementation((url: string, method: string) => {
      if (url.includes('/usage')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { data: { keys: [], daily: [], totals: {} } },
        })
      }
      if (url === '/api/user/api-keys' && method === 'GET') {
        return Promise.resolve({ ok: true, status: 200, data: { data: [] } })
      }
      if (url === '/api/user/api-keys' && method === 'POST') {
        return Promise.reject(new TypeError('Failed to fetch'))
      }
      return Promise.resolve({ ok: false, status: 500, data: {} })
    })

    render(<ApiKeysSection />)
    const input = await screen.findByPlaceholderText('apiKeyNamePlaceholder')
    fireEvent.change(input, { target: { value: 'Keep this draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'apiKeyCreate' }))

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('networkError', 'error'))
    expect(input).toHaveValue('Keep this draft')
    expect(screen.getByRole('button', { name: 'apiKeyCreate' })).toBeEnabled()
  })

  it('catches revoke network failures and restores the active key action', async () => {
    mockAuthedFetch.mockImplementation((url: string, method: string) => {
      if (url.includes('/usage')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { data: { keys: [], daily: [], totals: {} } },
        })
      }
      if (url === '/api/user/api-keys' && method === 'GET') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { data: [apiKey('user-a')] },
        })
      }
      if (url === '/api/user/api-keys' && method === 'PATCH') {
        return Promise.reject(new TypeError('Failed to fetch'))
      }
      return Promise.resolve({ ok: false, status: 500, data: {} })
    })

    render(<ApiKeysSection />)
    await screen.findByText('user-a private key')
    fireEvent.click(screen.getByRole('button', { name: 'revoke' }))

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('networkError', 'error'))
    expect(screen.getByText('user-a private key')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'revoke' })).toBeEnabled()
    expect(screen.queryByText('apiKeyRevokedSection')).not.toBeInTheDocument()
  })
})
