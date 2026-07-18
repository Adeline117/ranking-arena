import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockFetch = jest.fn()
const mockShowToast = jest.fn()
const mockGetAuthHeaders = jest.fn().mockResolvedValue({ Authorization: 'Bearer token' })

const translations: Record<string, string> = {
  loadFollowingFailed: 'Failed to load following',
  myFollowing: 'Following',
  noFollowing: 'You are not following anyone',
  noFollowingCta: 'Discover traders',
  retry: 'Retry',
}

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}))

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    language: 'en',
    t: (key: string) => translations[key] ?? key,
  }),
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => ({
    email: 'viewer@example.com',
    userId: 'viewer-1',
    getAuthHeadersAsync: mockGetAuthHeaders,
  }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/app/components/ui/Breadcrumb', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/app/components/ui/PageHeader', () => ({
  __esModule: true,
  default: ({ title }: { title: string }) => <h1>{title}</h1>,
}))

jest.mock('@/app/components/ui/Skeleton', () => ({
  ListSkeleton: () => <div>Loading following</div>,
}))

jest.mock('@/app/components/ui/EmptyState', () => ({
  __esModule: true,
  default: ({ title }: { title: string }) => <div>{title}</div>,
}))

jest.mock('@/app/components/ui/ErrorState', () => ({
  __esModule: true,
  default: ({ title, retry }: { title: string; retry: () => void }) => (
    <div role="alert">
      <span>{title}</span>
      <button onClick={retry}>Retry</button>
    </div>
  ),
}))

jest.mock('@/app/components/ui/Avatar', () => ({
  __esModule: true,
  default: ({ name }: { name: string }) => <span>{name} avatar</span>,
}))

jest.mock('@/app/components/ui/PullToRefreshWrapper', () => ({
  __esModule: true,
  default: ({
    children,
    onRefresh,
  }: {
    children: React.ReactNode
    onRefresh: () => Promise<void>
  }) => (
    <div>
      <button onClick={onRefresh}>Refresh following</button>
      {children}
    </div>
  ),
}))

jest.mock('@/app/components/base', () => {
  const React = jest.requireActual<typeof import('react')>('react')
  return {
    Box: ({
      children,
      onClick,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) =>
      React.createElement('div', { ...props, onClick }, children),
    Text: ({ children }: { children?: React.ReactNode }) =>
      React.createElement('span', null, children),
  }
})

jest.mock('@/lib/api/client', () => ({
  getCsrfHeaders: () => ({ 'X-CSRF-Token': 'csrf' }),
}))

jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn() },
}))

jest.mock('@/lib/tracking', () => ({
  trackInteraction: jest.fn(),
}))

jest.mock('@/lib/features', () => ({
  features: { social: true },
}))

import FollowingPageClient from '../FollowingPageClient'

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response
}

const alice = {
  id: 'alice-id',
  identity_key: 'binance_futures:alice-id',
  handle: 'Alice',
  type: 'trader',
  source: 'binance_futures',
  platform: 'binance_futures',
  roi: 12,
  arena_score: 88,
}

describe('FollowingPageClient load errors', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = mockFetch
  })

  it('shows a persistent retry state instead of a false empty state after initial failure', async () => {
    mockFetch
      .mockResolvedValueOnce(response({ error: 'Unavailable' }, 503))
      .mockResolvedValueOnce(response({ items: [alice], hasMore: false }))

    render(<FollowingPageClient />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load following')
    expect(screen.queryByText('You are not following anyone')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect((await screen.findAllByText('Alice')).length).toBeGreaterThan(0)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps the last successful list visible when refresh fails and clears the error on retry', async () => {
    mockFetch
      .mockResolvedValueOnce(response({ items: [alice], hasMore: false }))
      .mockResolvedValueOnce(response({ error: 'Unavailable' }, 503))
      .mockResolvedValueOnce(response({ items: [alice], hasMore: false }))

    render(<FollowingPageClient />)
    expect((await screen.findAllByText('Alice')).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: 'Refresh following' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load following')
    expect(screen.getAllByText('Alice').length).toBeGreaterThan(0)
    expect(screen.queryByText('You are not following anyone')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getAllByText('Alice').length).toBeGreaterThan(0)
  })
})
