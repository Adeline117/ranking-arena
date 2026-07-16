import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AuthSessionReturn } from '@/lib/hooks/useAuthSession'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  commitViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'

const mockFetch = jest.fn()
const mockShowToast = jest.fn()
const mockCreateObjectURL = jest.fn(() => 'blob:export')
const mockRevokeObjectURL = jest.fn()
let mockAuth: AuthSessionReturn

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuth,
}))

jest.mock('@/lib/api/client', () => ({
  getCsrfHeaders: () => ({ 'X-CSRF-Token': 'csrf-token' }),
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
      color: _color,
      ...props
    }: React.HTMLAttributes<HTMLSpanElement> & {
      size?: string
      weight?: string
      color?: string
    }) => React.createElement('span', props, children),
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
  }
})

jest.mock('../components/MultiAccountSection', () => ({
  MultiAccountSection: () => null,
}))

import { AccountSection } from '../components/AccountSection'

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

function authFor(userId: string, sessionGeneration: number, tokenUserId = userId) {
  return {
    user: { id: userId, email: `${userId}@example.com`, identities: [] },
    userId,
    email: `${userId}@example.com`,
    accessToken: jwt(tokenUserId),
    isLoggedIn: true,
    loading: false,
    authChecked: true,
    viewerKey: `user:${userId}`,
    sessionGeneration,
  } as unknown as AuthSessionReturn
}

function renderSection() {
  return render(<AccountSection onLogout={jest.fn()} onDeleteAccount={jest.fn()} />)
}

function switchToUserB(rerender: () => void) {
  const transition = beginViewerTransition('user-b')
  const scopeB = commitViewerTransition(transition, 'user-b')!
  mockAuth = authFor('user-b', scopeB.sessionGeneration)
  rerender()
}

describe('AccountSection export viewer ownership', () => {
  let anchorClickSpy: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
    const scopeA = synchronizeViewerScope(true, 'user-a')
    mockAuth = authFor('user-a', scopeA.sessionGeneration)
    global.fetch = mockFetch
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: mockCreateObjectURL,
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: mockRevokeObjectURL,
    })
    anchorClickSpy = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  })

  afterEach(() => {
    anchorClickSpy.mockRestore()
  })

  it('drops a late A export and fails empty immediately after switching to B', async () => {
    const blobA = deferred<Blob>()
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      blob: () => blobA.promise,
      json: () => Promise.resolve({}),
    })
    const view = renderSection()

    fireEvent.click(screen.getByRole('button', { name: 'exportData' }))
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'exporting' })).toBeDisabled()

    const request = mockFetch.mock.calls[0]
    expect(request[0]).toBe('/api/settings/export')
    expect(request[1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt('user-a')}`,
          'X-CSRF-Token': 'csrf-token',
        },
      })
    )

    act(() => {
      switchToUserB(() =>
        view.rerender(<AccountSection onLogout={jest.fn()} onDeleteAccount={jest.fn()} />)
      )
    })

    expect(screen.getByRole('button', { name: 'exportData' })).not.toBeDisabled()
    expect((request[1] as RequestInit).signal?.aborted).toBe(true)

    await act(async () => {
      blobA.resolve(new Blob(['private user A export']))
    })

    expect(mockCreateObjectURL).not.toHaveBeenCalled()
    expect(anchorClickSpy).not.toHaveBeenCalled()
    expect(mockShowToast).not.toHaveBeenCalled()
  })

  it('uses a synchronous operation lock for rapid repeated clicks', async () => {
    const response = deferred<never>()
    mockFetch.mockReturnValue(response.promise)
    renderSection()

    const button = screen.getByRole('button', { name: 'exportData' })
    act(() => {
      button.click()
      button.click()
    })

    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('aborts on unmount and suppresses the detached completion', async () => {
    const response = deferred<{
      ok: boolean
      status: number
      blob: () => Promise<Blob>
      json: () => Promise<object>
    }>()
    mockFetch.mockReturnValue(response.promise)
    const view = renderSection()

    fireEvent.click(screen.getByRole('button', { name: 'exportData' }))
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))
    const signal = (mockFetch.mock.calls[0][1] as RequestInit).signal
    view.unmount()
    expect(signal?.aborted).toBe(true)

    await act(async () => {
      response.resolve({
        ok: true,
        status: 200,
        blob: () => Promise.resolve(new Blob(['private export'])),
        json: () => Promise.resolve({}),
      })
    })

    expect(anchorClickSpy).not.toHaveBeenCalled()
    expect(mockShowToast).not.toHaveBeenCalled()
  })

  it('refuses to export when the JWT subject does not match the canonical viewer', () => {
    const scope = synchronizeViewerScope(true, 'user-a')
    mockAuth = authFor('user-a', scope.sessionGeneration, 'user-b')
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: 'exportData' }))

    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockShowToast).not.toHaveBeenCalled()
  })

  it('downloads and reports success only for the still-current viewer', async () => {
    const blob = new Blob(['current viewer export'])
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      blob: () => Promise.resolve(blob),
      json: () => Promise.resolve({}),
    })
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: 'exportData' }))

    await waitFor(() => expect(anchorClickSpy).toHaveBeenCalledTimes(1))
    expect(mockCreateObjectURL).toHaveBeenCalledWith(blob)
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:export')
    expect(mockShowToast).toHaveBeenCalledWith('exportSuccess', 'success')
    expect(screen.getByRole('button', { name: 'exportData' })).not.toBeDisabled()
  })
})
