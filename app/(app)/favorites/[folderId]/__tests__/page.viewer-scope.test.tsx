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
  delete: 'Delete',
  deleteFolder: 'Delete folder',
  deleteFolderConfirm: 'Delete this folder?',
  edit: 'Edit',
  failedToLoad: 'Failed to load folder',
  folderDeleted: 'Folder deleted',
  itemCount: '{n} items',
  loadMore: 'Load more',
  loadMoreFailed: 'Failed to load more',
  loadingMore: 'Loading more...',
  networkError: 'Network error',
  noBookmarks: 'No bookmarks',
  noBookmarksDesc: 'This folder is empty',
  processing: 'Processing',
  publicFolder: 'Public',
  removeFailed: 'Remove failed',
  subscriberCount: '{n} subscribers',
  save: 'Save',
  saved: 'Saved',
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
  Text: ({ children, role }: { children?: ReactNode; role?: string }) => (
    <span role={role}>{children}</span>
  ),
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

function bookmarkedPost(index: number) {
  return {
    bookmark_id: `bookmark-${index}`,
    bookmarked_at: `2026-07-${String(index).padStart(2, '0')}T00:00:00.000Z`,
    id: `post-${index}`,
    title: `Post ${index}`,
    content: `Content ${index}`,
    author_id: 'post-author',
    author_handle: 'author',
    group_id: null,
    like_count: 0,
    comment_count: 0,
    bookmark_count: 1,
    created_at: `2026-07-${String(index).padStart(2, '0')}T00:00:00.000Z`,
  }
}

function folderDetailResponse(
  name: string,
  isSubscribed = false,
  subscriberCount = 0,
  options: {
    posts?: ReturnType<typeof bookmarkedPost>[]
    postCount?: number
    pagination?: { limit: number; offset: number; has_more: boolean }
    isOwner?: boolean
    ownerId?: string
  } = {}
) {
  const posts = options.posts ?? []
  return response({
    success: true,
    data: {
      folder: {
        id: FOLDER_ID,
        user_id: options.ownerId ?? 'folder-owner',
        name,
        description: null,
        avatar_url: null,
        is_public: true,
        is_default: false,
        post_count: options.postCount ?? posts.length,
        subscriber_count: subscriberCount,
        created_at: '2026-07-29T00:00:00.000Z',
        owner_handle: 'owner',
        owner_avatar_url: null,
      },
      posts,
      is_owner: options.isOwner ?? false,
      is_subscribed: isSubscribed,
      pagination: options.pagination ?? { limit: 20, offset: 0, has_more: false },
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

  it('single-flights a folder save before the disabled state renders', async () => {
    const saveRequest = deferred<Response>()
    const fetchMock = jest.fn((_url: string, options?: RequestInit) => {
      if (options?.method === 'PATCH') return saveRequest.promise
      return Promise.resolve(
        folderDetailResponse('Owner folder', false, 0, {
          isOwner: true,
          ownerId: 'viewer-a',
        })
      )
    })
    global.fetch = fetchMock as typeof fetch

    renderPage()
    expect(await screen.findByText('Owner folder')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))

    const saveButton = screen.getByRole('button', { name: 'Save' })
    act(() => {
      saveButton.click()
      saveButton.click()
    })

    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'PATCH')).toHaveLength(
      1
    )

    await act(async () => {
      saveRequest.resolve(
        response({
          success: true,
          data: {
            folder: {
              id: FOLDER_ID,
              user_id: 'viewer-a',
              name: 'Owner folder',
              description: null,
              avatar_url: null,
              is_public: true,
              is_default: false,
              post_count: 0,
            },
          },
        })
      )
      await saveRequest.promise
    })
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Saved', 'success'))
  })

  it('single-flights folder deletion across its asynchronous confirmation', async () => {
    const confirmation = deferred<boolean>()
    const deleteRequest = deferred<Response>()
    mockShowDangerConfirm.mockReturnValueOnce(confirmation.promise)
    const fetchMock = jest.fn((_url: string, options?: RequestInit) => {
      if (options?.method === 'DELETE') return deleteRequest.promise
      return Promise.resolve(
        folderDetailResponse('Owner folder', false, 0, {
          isOwner: true,
          ownerId: 'viewer-a',
        })
      )
    })
    global.fetch = fetchMock as typeof fetch

    renderPage()
    expect(await screen.findByText('Owner folder')).toBeInTheDocument()
    const deleteButton = screen.getByRole('button', { name: 'Delete' })
    act(() => {
      deleteButton.click()
      deleteButton.click()
    })

    expect(mockShowDangerConfirm).toHaveBeenCalledTimes(1)
    await act(async () => {
      confirmation.resolve(true)
      await confirmation.promise
    })
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([, options]) => options?.method === 'DELETE')
      ).toHaveLength(1)
    )

    await act(async () => {
      deleteRequest.resolve(response({ success: true, data: { message: 'Folder deleted' } }))
      await deleteRequest.promise
    })
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/favorites'))
  })

  it('single-flights a subscription mutation before its loading state renders', async () => {
    const subscribeRequest = deferred<Response>()
    const fetchMock = jest.fn((_url: string, options?: RequestInit) => {
      if (options?.method === 'POST') return subscribeRequest.promise
      return Promise.resolve(folderDetailResponse('Public folder'))
    })
    global.fetch = fetchMock as typeof fetch

    renderPage()
    expect(await screen.findByText('Public folder')).toBeInTheDocument()
    const subscribeButton = screen.getByRole('button', { name: 'Bookmark' })
    act(() => {
      subscribeButton.click()
      subscribeButton.click()
    })

    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)

    await act(async () => {
      subscribeRequest.resolve(
        response({ success: true, data: { is_subscribed: true, subscriber_count: 1 } })
      )
      await subscribeRequest.promise
    })
    expect(await screen.findByRole('button', { name: 'Bookmarked' })).toBeInTheDocument()
  })

  it('loads the remaining folder posts without replacing the visible first page', async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => bookmarkedPost(index + 1))
    const fetchMock = jest.fn((url: string) => {
      if (url === `/api/bookmark-folders/${FOLDER_ID}`) {
        return Promise.resolve(
          folderDetailResponse('Paged folder', false, 0, {
            posts: firstPage,
            postCount: 22,
            pagination: { limit: 20, offset: 0, has_more: true },
          })
        )
      }
      if (url === `/api/bookmark-folders/${FOLDER_ID}?limit=20&offset=20`) {
        return Promise.resolve(
          folderDetailResponse('Paged folder', false, 0, {
            posts: [bookmarkedPost(21), bookmarkedPost(22)],
            postCount: 22,
            pagination: { limit: 20, offset: 20, has_more: false },
          })
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    global.fetch = fetchMock as typeof fetch

    renderPage()
    expect(await screen.findByText('Post 1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))

    expect(await screen.findByText('Post 22')).toBeInTheDocument()
    expect(screen.getByText('Post 1')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/bookmark-folders/${FOLDER_ID}?limit=20&offset=20`,
      expect.objectContaining({
        headers: { Authorization: 'Bearer token-viewer-a' },
      })
    )
  })

  it('rejects an overlapping post page and keeps the first page retryable', async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => bookmarkedPost(index + 1))
    const fetchMock = jest.fn((url: string) => {
      if (url === `/api/bookmark-folders/${FOLDER_ID}`) {
        return Promise.resolve(
          folderDetailResponse('Paged folder', false, 0, {
            posts: firstPage,
            postCount: 21,
            pagination: { limit: 20, offset: 0, has_more: true },
          })
        )
      }
      if (url === `/api/bookmark-folders/${FOLDER_ID}?limit=20&offset=20`) {
        return Promise.resolve(
          folderDetailResponse('Paged folder', false, 0, {
            posts: [bookmarkedPost(1)],
            postCount: 21,
            pagination: { limit: 20, offset: 20, has_more: false },
          })
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    global.fetch = fetchMock as typeof fetch

    renderPage()
    expect(await screen.findByText('Post 1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load more')
    expect(screen.getByText('Post 1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument()
  })

  it('shifts the next post offset after removing an item from the loaded prefix', async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => bookmarkedPost(index + 1))
    const ownerOptions = { isOwner: true, ownerId: 'viewer-a' }
    const fetchMock = jest.fn((url: string, options?: RequestInit) => {
      if (url === `/api/bookmark-folders/${FOLDER_ID}`) {
        return Promise.resolve(
          folderDetailResponse('Owner folder', false, 0, {
            ...ownerOptions,
            posts: firstPage,
            postCount: 22,
            pagination: { limit: 20, offset: 0, has_more: true },
          })
        )
      }
      if (url === '/api/posts/post-1/bookmark' && options?.method === 'POST') {
        return Promise.resolve(
          response({
            action: 'removed',
            bookmarked: false,
            bookmark_count: 0,
            bookmark_id: 'bookmark-1',
            folder_id: FOLDER_ID,
            already_removed: false,
          })
        )
      }
      if (url === `/api/bookmark-folders/${FOLDER_ID}?limit=20&offset=19`) {
        return Promise.resolve(
          folderDetailResponse('Owner folder', false, 0, {
            ...ownerOptions,
            posts: [bookmarkedPost(21), bookmarkedPost(22)],
            postCount: 21,
            pagination: { limit: 20, offset: 19, has_more: false },
          })
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    global.fetch = fetchMock as typeof fetch

    renderPage()
    expect(await screen.findByText('Post 1')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'remove' })[0])
    await waitFor(() => expect(screen.queryByText('Post 1')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))

    expect(await screen.findByText('Post 22')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/bookmark-folders/${FOLDER_ID}?limit=20&offset=19`,
      expect.any(Object)
    )
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/posts/post-1/bookmark',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          action: 'remove',
          bookmark_id: 'bookmark-1',
          folder_id: FOLDER_ID,
        }),
      })
    )
  })

  it('keeps the post when removal acknowledgement identity does not match', async () => {
    const fetchMock = jest.fn((url: string, options?: RequestInit) => {
      if (url === `/api/bookmark-folders/${FOLDER_ID}`) {
        return Promise.resolve(
          folderDetailResponse('Owner folder', false, 0, {
            isOwner: true,
            ownerId: 'viewer-a',
            posts: [bookmarkedPost(1)],
            postCount: 1,
          })
        )
      }
      if (url === '/api/posts/post-1/bookmark' && options?.method === 'POST') {
        return Promise.resolve(
          response({
            action: 'removed',
            bookmarked: false,
            bookmark_count: 0,
            bookmark_id: 'bookmark-crossed',
            folder_id: FOLDER_ID,
            already_removed: false,
          })
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    global.fetch = fetchMock as typeof fetch

    renderPage()
    expect(await screen.findByText('Post 1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'remove' }))

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Remove failed', 'error'))
    expect(screen.getByText('Post 1')).toBeInTheDocument()
  })

  it('rejects a late post page after the viewer changes', async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => bookmarkedPost(index + 1))
    const latePage = deferred<Response>()
    const fetchMock = jest.fn((url: string, options?: RequestInit) => {
      const authorization = (options?.headers as Record<string, string> | undefined)?.Authorization
      if (authorization === 'Bearer token-viewer-b') {
        return Promise.resolve(folderDetailResponse('Viewer B folder'))
      }
      if (url.includes('?limit=20&offset=20')) return latePage.promise
      return Promise.resolve(
        folderDetailResponse('Viewer A folder', false, 0, {
          posts: firstPage,
          postCount: 21,
          pagination: { limit: 20, offset: 0, has_more: true },
        })
      )
    })
    global.fetch = fetchMock as typeof fetch

    const view = renderPage()
    expect(await screen.findByText('Viewer A folder')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))

    setViewer('viewer-b')
    view.rerender(<FolderDetailPage params={Promise.resolve({ folderId: FOLDER_ID })} />)
    expect(await screen.findByText('Viewer B folder')).toBeInTheDocument()

    await act(async () => {
      latePage.resolve(
        folderDetailResponse('Viewer A folder', false, 0, {
          posts: [bookmarkedPost(21)],
          postCount: 21,
          pagination: { limit: 20, offset: 20, has_more: false },
        })
      )
      await latePage.promise
    })

    expect(screen.queryByText('Post 21')).not.toBeInTheDocument()
    expect(screen.getByText('Viewer B folder')).toBeInTheDocument()
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
