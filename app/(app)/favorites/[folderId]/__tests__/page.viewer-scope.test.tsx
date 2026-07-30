import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { __resetViewerScopeForTests, synchronizeViewerScope } from '@/lib/auth/viewer-scope'

const FOLDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

type MockAuthState = {
  accessToken: string
  authChecked: boolean
  userId: string
  viewerKey: `user:${string}`
  sessionGeneration: number
}

let mockAuthState: MockAuthState
const mockPush = jest.fn()
const mockShowToast = jest.fn()
const mockShowDangerConfirm = jest.fn()
const mockLoggerError = jest.fn()

const translations: Record<string, string> = {
  bookmark: 'Bookmark',
  bookmarked: 'Bookmarked',
  bookmarkFailed: 'Bookmark failed',
  failedToLoad: 'Failed to load folder',
  itemCount: '{n} items',
  networkError: 'Network error',
  noBookmarks: 'No bookmarks',
  noBookmarksDesc: 'This folder is empty',
  processing: 'Processing',
  publicFolder: 'Public',
  subscriberCount: '{n} subscribers',
  unbookmarked: 'Unbookmarked',
  unbookmarkFailed: 'Unbookmark failed',
}

jest.mock('react', () => {
  const actual = jest.requireActual('react')
  return { ...actual, use: () => ({ folderId: FOLDER_ID }) }
})

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

jest.mock('next/dynamic', () => () => {
  function MockPostDetailModal() {
    return null
  }
  return MockPostDetailModal
})

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuthState,
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    language: 'en',
    t: (key: string) => translations[key] ?? key,
  }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/app/components/ui/Dialog', () => ({
  useDialog: () => ({ showDangerConfirm: mockShowDangerConfirm }),
}))

jest.mock('@/lib/logger', () => ({
  logger: { error: (...args: unknown[]) => mockLoggerError(...args) },
}))

jest.mock('@/lib/api/client', () => ({ getCsrfHeaders: () => ({}) }))

jest.mock('@/app/components/ui/Breadcrumb', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/app/components/ui/Skeleton', () => ({
  RankingSkeleton: () => <div data-testid="folder-loading">Loading folder</div>,
}))

jest.mock('@/app/components/ui/EmptyState', () => ({
  __esModule: true,
  default: ({ title, description }: { title: string; description?: string }) => (
    <section data-testid="empty-state">
      <h2>{title}</h2>
      {description && <p>{description}</p>}
    </section>
  ),
}))

jest.mock('@/app/components/base', () => ({
  Box: ({
    children,
    role,
    onClick,
    onKeyDown,
    tabIndex,
  }: {
    children?: ReactNode
    role?: string
    onClick?: () => void
    onKeyDown?: () => void
    tabIndex?: number
  }) => (
    <div role={role} onClick={onClick} onKeyDown={onKeyDown} tabIndex={tabIndex}>
      {children}
    </div>
  ),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children?: ReactNode
    onClick?: () => void
    disabled?: boolean
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}))

import FolderDetailPage from '../page'

const originalFetch = global.fetch

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response
}

function folderDetailResponse(name: string, isSubscribed = false, subscriberCount = 0) {
  return response({
    success: true,
    data: {
      folder: {
        id: FOLDER_ID,
        user_id: 'folder-owner',
        name,
        description: null,
        avatar_url: null,
        is_public: true,
        is_default: false,
        post_count: 0,
        subscriber_count: subscriberCount,
        created_at: '2026-07-29T00:00:00.000Z',
        owner_handle: 'owner',
        owner_avatar_url: null,
      },
      posts: [],
      is_owner: false,
      is_subscribed: isSubscribed,
      pagination: { limit: 20, offset: 0, has_more: false },
    },
  })
}

function setViewer(userId: string, token = `token-${userId}`) {
  const scope = synchronizeViewerScope(true, userId)
  mockAuthState = {
    accessToken: token,
    authChecked: true,
    userId,
    viewerKey: `user:${userId}`,
    sessionGeneration: scope.sessionGeneration,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

function renderPage() {
  return render(<FolderDetailPage params={Promise.resolve({ folderId: FOLDER_ID })} />)
}

describe('favorite folder detail viewer ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
    setViewer('viewer-a')
    mockShowDangerConfirm.mockResolvedValue(true)
  })

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  it('hides viewer A immediately and rejects its late refresh after switching to B', async () => {
    const lateA = deferred<Response>()
    let viewerACalls = 0
    const fetchMock = jest.fn((_url: string, options?: RequestInit) => {
      const authorization = (options?.headers as Record<string, string> | undefined)?.Authorization
      if (authorization === 'Bearer token-viewer-b') {
        return Promise.resolve(folderDetailResponse('Viewer B folder'))
      }
      viewerACalls += 1
      return viewerACalls === 1
        ? Promise.resolve(folderDetailResponse('Viewer A private folder'))
        : lateA.promise
    })
    global.fetch = fetchMock as typeof fetch

    const view = renderPage()
    expect(await screen.findByText('Viewer A private folder')).toBeInTheDocument()

    setViewer('viewer-a', 'token-viewer-a-rotated')
    view.rerender(<FolderDetailPage params={Promise.resolve({ folderId: FOLDER_ID })} />)
    await waitFor(() => expect(viewerACalls).toBe(2))

    setViewer('viewer-b')
    view.rerender(<FolderDetailPage params={Promise.resolve({ folderId: FOLDER_ID })} />)
    expect(screen.queryByText('Viewer A private folder')).not.toBeInTheDocument()

    expect(await screen.findByText('Viewer B folder')).toBeInTheDocument()
    await act(async () => {
      lateA.resolve(folderDetailResponse('Late viewer A secret'))
      await lateA.promise
    })

    expect(screen.queryByText('Late viewer A secret')).not.toBeInTheDocument()
    expect(screen.getByText('Viewer B folder')).toBeInTheDocument()
  })

  it('does not convert a malformed successful detail payload into an empty folder', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      response({
        success: true,
        data: { folder: null, posts: [], is_owner: false, is_subscribed: false },
      })
    ) as typeof fetch

    renderPage()

    expect(await screen.findByText('Failed to load folder')).toBeInTheDocument()
    expect(screen.queryByText('No bookmarks')).not.toBeInTheDocument()
  })

  it('does not let viewer A subscription completion overwrite viewer B', async () => {
    const lateMutation = deferred<Response>()
    const fetchMock = jest.fn((_url: string, options?: RequestInit) => {
      if (options?.method === 'POST') return lateMutation.promise
      const authorization = (options?.headers as Record<string, string> | undefined)?.Authorization
      return Promise.resolve(
        authorization === 'Bearer token-viewer-b'
          ? folderDetailResponse('Viewer B folder')
          : folderDetailResponse('Viewer A folder')
      )
    })
    global.fetch = fetchMock as typeof fetch

    const view = renderPage()
    expect(await screen.findByText('Viewer A folder')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Bookmark/ }))

    setViewer('viewer-b')
    view.rerender(<FolderDetailPage params={Promise.resolve({ folderId: FOLDER_ID })} />)
    expect(await screen.findByText('Viewer B folder')).toBeInTheDocument()

    await act(async () => {
      lateMutation.resolve(
        response({
          success: true,
          data: { is_subscribed: true, subscriber_count: 9 },
        })
      )
      await lateMutation.promise
    })

    expect(screen.getByRole('button', { name: /Bookmark/ })).toBeInTheDocument()
    expect(screen.queryByText('Bookmarked')).not.toBeInTheDocument()
    expect(mockShowToast).not.toHaveBeenCalled()
  })

  it('rejects a malformed successful subscription acknowledgement', async () => {
    const fetchMock = jest.fn((_url: string, options?: RequestInit) =>
      Promise.resolve(
        options?.method === 'POST'
          ? response({ success: true, data: {} })
          : folderDetailResponse('Public folder')
      )
    )
    global.fetch = fetchMock as typeof fetch

    renderPage()
    expect(await screen.findByText('Public folder')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Bookmark/ }))

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Bookmark failed', 'error'))
    expect(screen.getByRole('button', { name: /Bookmark/ })).toBeInTheDocument()
  })
})
