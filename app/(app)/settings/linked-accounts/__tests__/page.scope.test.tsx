import { act, render, screen } from '@testing-library/react'
import type { AuthSessionReturn } from '@/lib/hooks/useAuthSession'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  commitViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'

const mockReplace = jest.fn()
const mockPush = jest.fn()
let mockAuth: AuthSessionReturn

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuth,
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
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
      variant: _variant,
      size: _size,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) =>
      React.createElement('button', props, children),
  }
})

jest.mock('@/app/components/utils/ErrorBoundary', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => children,
}))

jest.mock('@/app/components/ui/Breadcrumb', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/app/components/ui/PageHeader', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('../../components/TraderLinksSection', () => ({
  TraderLinksSection: ({ userId }: { userId: string }) => (
    <div data-testid="trader-links-viewer">{userId}</div>
  ),
}))

jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn() },
}))

import LinkedAccountsPage from '../page'

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

function anonymousAuth(sessionGeneration: number) {
  return {
    user: null,
    userId: null,
    email: null,
    accessToken: null,
    isLoggedIn: false,
    loading: false,
    authChecked: true,
    viewerKey: 'anon',
    sessionGeneration,
  } as unknown as AuthSessionReturn
}

function pendingAuth(sessionGeneration: number) {
  return {
    ...anonymousAuth(sessionGeneration),
    loading: true,
    authChecked: false,
    viewerKey: 'pending',
  } as AuthSessionReturn
}

describe('linked accounts page viewer ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
    const scopeA = synchronizeViewerScope(true, 'user-a')
    mockAuth = authFor('user-a', scopeA.sessionGeneration)
  })

  it('replaces A with B without retaining the one-time mount identity', () => {
    const view = render(<LinkedAccountsPage />)
    expect(screen.getByTestId('trader-links-viewer')).toHaveTextContent('user-a')

    act(() => {
      const transition = beginViewerTransition('user-b')
      mockAuth = pendingAuth(transition)
      view.rerender(<LinkedAccountsPage />)
    })

    expect(screen.queryByTestId('trader-links-viewer')).not.toBeInTheDocument()
    expect(screen.getByText('loading')).toBeInTheDocument()
    expect(mockReplace).not.toHaveBeenCalled()

    act(() => {
      const scopeB = commitViewerTransition(mockAuth.sessionGeneration, 'user-b')!
      mockAuth = authFor('user-b', scopeB.sessionGeneration)
      view.rerender(<LinkedAccountsPage />)
    })

    expect(screen.getByTestId('trader-links-viewer')).toHaveTextContent('user-b')
    expect(screen.queryByText('user-a')).not.toBeInTheDocument()
  })

  it('redirects one time for one canonical anonymous generation', () => {
    const scopeAnon = synchronizeViewerScope(true, null)
    mockAuth = anonymousAuth(scopeAnon.sessionGeneration)
    const view = render(<LinkedAccountsPage />)

    expect(mockReplace).toHaveBeenCalledTimes(1)
    expect(mockReplace).toHaveBeenCalledWith('/login?redirect=/settings/linked-accounts')
    expect(screen.queryByTestId('trader-links-viewer')).not.toBeInTheDocument()

    view.rerender(<LinkedAccountsPage />)
    expect(mockReplace).toHaveBeenCalledTimes(1)
  })

  it('fails closed instead of passing a viewer whose token subject mismatches', () => {
    const scopeA = synchronizeViewerScope(true, 'user-a')
    mockAuth = authFor('user-a', scopeA.sessionGeneration, 'user-b')

    render(<LinkedAccountsPage />)

    expect(screen.queryByTestId('trader-links-viewer')).not.toBeInTheDocument()
    expect(screen.getByText('loading')).toBeInTheDocument()
    expect(mockReplace).not.toHaveBeenCalled()
  })
})
