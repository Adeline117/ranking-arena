import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'

type MockAuthState = {
  accessToken: string
  authChecked: boolean
  userId: string
  viewerKey: `user:${string}`
  sessionGeneration: number
}

let mockAuthState: MockAuthState
const mockShowToast = jest.fn()
const mockLoggerError = jest.fn()
const mockLoggerWarn = jest.fn()

const translations: Record<string, string> = {
  browsePublicFolders: 'Browse public folders',
  defaultFolderName: 'Default',
  itemCount: '{n} items',
  loadFoldersFailed: 'Failed to load folders',
  loadFoldersFailedRetry: 'Failed to load folders. Please retry.',
  myFoldersTab: 'My Folders',
  newFolder: 'New folder',
  noFolders: 'No folders yet',
  noFoldersCta: 'Create a folder.',
  noSubscribedFolders: 'No subscribed folders',
  noSubscribedFoldersDesc: 'Browse public folders.',
  subscribedFoldersTab: 'Subscribed Folders',
}

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({
    href,
    children,
    ...props
  }: {
    href: string
    children: ReactNode
    [key: string]: unknown
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuthState,
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => translations[key] ?? key }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/lib/logger', () => ({
  logger: {
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
}))

jest.mock('@/app/components/ui/Skeleton', () => ({
  ListSkeleton: () => <div data-testid="folder-loading">Loading folders</div>,
}))

jest.mock('@/app/components/ui/EmptyState', () => ({
  __esModule: true,
  default: ({
    title,
    description,
    action,
  }: {
    title: string
    description?: string
    action?: ReactNode
  }) => (
    <section data-testid="empty-state">
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      {action}
    </section>
  ),
}))

jest.mock('@/app/components/ui/ErrorState', () => ({
  __esModule: true,
  default: ({
    title,
    description,
    retry,
  }: {
    title: string
    description?: string
    retry?: () => void
  }) => (
    <section role="alert">
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      {retry && (
        <button type="button" onClick={retry}>
          Retry
        </button>
      )}
    </section>
  ),
}))

import FavoritesPageClient from '../FavoritesPageClient'

const originalFetch = global.fetch

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response
}

function folder(id: string, name: string) {
  return {
    id,
    name,
    post_count: 1,
    is_public: false,
    is_default: false,
  }
}

function subscribedFolder(id: string, name: string) {
  return {
    id,
    name,
    post_count: 2,
    subscriber_count: 3,
    subscribed_at: '2026-07-18T00:00:00.000Z',
  }
}

function folderResponse(folders: unknown[]) {
  return response({ data: { folders } })
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

function endpointCalls(fetchMock: jest.Mock, endpoint: string): number {
  return fetchMock.mock.calls.filter(([url]) => url === endpoint).length
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

describe('FavoritesPageClient load states', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
    setViewer('viewer-a')
  })

  afterEach(() => {
    global.fetch = originalFetch
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('keeps my and subscribed failures independent and retries only the failed lane', async () => {
    let myRecovered = false
    const fetchMock = jest.fn((url: string) => {
      if (url === '/api/bookmark-folders') {
        return Promise.resolve(
          myRecovered ? folderResponse([folder('mine-1', 'Recovered folder')]) : response({}, 503)
        )
      }
      if (url === '/api/bookmark-folders/subscribed') {
        return Promise.resolve(folderResponse([subscribedFolder('sub-1', 'Subscribed Alpha')]))
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    global.fetch = fetchMock as typeof fetch

    render(<FavoritesPageClient embedded />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load folders')
    expect(screen.queryByText('No folders yet')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /Subscribed Folders/ }))
    expect(await screen.findByText('Subscribed Alpha')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /My Folders/ }))
    myRecovered = true
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('Recovered folder')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(endpointCalls(fetchMock, '/api/bookmark-folders')).toBe(2)
    expect(endpointCalls(fetchMock, '/api/bookmark-folders/subscribed')).toBe(1)
  })

  it('keeps last-good data visible through a failed refresh and replaces it after retry', async () => {
    let mode: 'initial' | 'failed' | 'recovered' = 'initial'
    const now = jest.spyOn(Date, 'now').mockReturnValue(100_000)
    const fetchMock = jest.fn((url: string) => {
      if (url === '/api/bookmark-folders') {
        if (mode === 'failed') return Promise.resolve(response({}, 503))
        const name = mode === 'recovered' ? 'Fresh folder' : 'Last-good folder'
        return Promise.resolve(folderResponse([folder('mine-1', name)]))
      }
      if (url === '/api/bookmark-folders/subscribed') {
        return Promise.resolve(folderResponse([]))
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    global.fetch = fetchMock as typeof fetch

    const view = render(<FavoritesPageClient embedded />)
    expect(await screen.findByText('Last-good folder')).toBeInTheDocument()

    mode = 'failed'
    now.mockReturnValue(161_000)
    setViewer('viewer-a', 'token-viewer-a-rotated')
    view.rerender(<FavoritesPageClient embedded />)

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('Last-good folder')).toBeInTheDocument()
    expect(screen.queryByText('No folders yet')).not.toBeInTheDocument()

    mode = 'recovered'
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('Fresh folder')).toBeInTheDocument()
    expect(screen.queryByText('Last-good folder')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not cache malformed items or a subscribed 404 as successful empty data', async () => {
    let myAttempt = 0
    let subscribedAttempt = 0
    const fetchMock = jest.fn((url: string) => {
      if (url === '/api/bookmark-folders') {
        myAttempt += 1
        return Promise.resolve(myAttempt === 1 ? folderResponse([null]) : folderResponse([]))
      }
      if (url === '/api/bookmark-folders/subscribed') {
        subscribedAttempt += 1
        return Promise.resolve(
          subscribedAttempt === 1
            ? response({ error: 'Route unavailable' }, 404)
            : folderResponse([])
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    global.fetch = fetchMock as typeof fetch

    const view = render(<FavoritesPageClient embedded />)
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText('No folders yet')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: /Subscribed Folders/ }))
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText('No subscribed folders')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: /My Folders/ }))

    setViewer('viewer-a', 'token-viewer-a-rotated')
    view.rerender(<FavoritesPageClient embedded />)

    expect(await screen.findByText('No folders yet')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(endpointCalls(fetchMock, '/api/bookmark-folders')).toBe(2)
    expect(endpointCalls(fetchMock, '/api/bookmark-folders/subscribed')).toBe(2)

    fireEvent.click(screen.getByRole('tab', { name: /Subscribed Folders/ }))
    expect(await screen.findByText('No subscribed folders')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('rejects malformed subscribed items and retries that lane without refetching valid my data', async () => {
    let subscribedAttempt = 0
    const fetchMock = jest.fn((url: string) => {
      if (url === '/api/bookmark-folders') return Promise.resolve(folderResponse([]))
      if (url === '/api/bookmark-folders/subscribed') {
        subscribedAttempt += 1
        return Promise.resolve(
          subscribedAttempt === 1 ? folderResponse([null]) : folderResponse([])
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    global.fetch = fetchMock as typeof fetch

    const view = render(<FavoritesPageClient embedded />)
    expect(await screen.findByText('No folders yet')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: /Subscribed Folders/ }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText('No subscribed folders')).not.toBeInTheDocument()

    setViewer('viewer-a', 'token-viewer-a-rotated')
    view.rerender(<FavoritesPageClient embedded />)

    expect(await screen.findByText('No subscribed folders')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(endpointCalls(fetchMock, '/api/bookmark-folders')).toBe(1)
    expect(endpointCalls(fetchMock, '/api/bookmark-folders/subscribed')).toBe(2)
  })

  it('turns a hung request into a retryable error instead of a permanent skeleton', async () => {
    jest.useFakeTimers()
    const fetchMock = jest.fn((url: string, options?: RequestInit) => {
      if (url === '/api/bookmark-folders/subscribed') {
        return Promise.resolve(folderResponse([]))
      }
      if (url === '/api/bookmark-folders') {
        return new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('Timed out'), { name: 'AbortError' }))
          })
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    global.fetch = fetchMock as typeof fetch

    render(<FavoritesPageClient embedded />)
    expect(screen.getByTestId('folder-loading')).toBeInTheDocument()

    await act(async () => {
      await jest.advanceTimersByTimeAsync(15_000)
    })

    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load folders')
    expect(screen.queryByTestId('folder-loading')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('does not send an account-scoped create after a global viewer transition begins', async () => {
    const fetchMock = jest.fn((url: string, options?: RequestInit) => {
      if (options?.method === 'POST') return Promise.resolve(response({ data: {} }, 201))
      if (url === '/api/bookmark-folders' || url === '/api/bookmark-folders/subscribed') {
        return Promise.resolve(folderResponse([]))
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    global.fetch = fetchMock as typeof fetch

    render(<FavoritesPageClient embedded />)
    expect(await screen.findByText('No folders yet')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }))
    fireEvent.change(screen.getByPlaceholderText('bookmarkFolderName'), {
      target: { value: 'Do not create for stale viewer' },
    })

    beginViewerTransition('viewer-b')
    fireEvent.click(screen.getByText('create'))

    expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
  })

  it('hides account A immediately and rejects its late refresh after switching to B', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(100_000)
    const lateA = deferred<Response>()
    let aMyCalls = 0
    const fetchMock = jest.fn((url: string, options?: RequestInit) => {
      const authorization = (options?.headers as Record<string, string>)?.Authorization
      const isViewerB = authorization === 'Bearer token-viewer-b'
      if (url === '/api/bookmark-folders') {
        if (isViewerB) return Promise.resolve(folderResponse([folder('b-1', 'Viewer B folder')]))
        aMyCalls += 1
        if (aMyCalls === 1) {
          return Promise.resolve(folderResponse([folder('a-1', 'Viewer A private folder')]))
        }
        return lateA.promise
      }
      if (url === '/api/bookmark-folders/subscribed') {
        return Promise.resolve(folderResponse([]))
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    global.fetch = fetchMock as typeof fetch

    const view = render(<FavoritesPageClient embedded />)
    expect(await screen.findByText('Viewer A private folder')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }))
    fireEvent.change(screen.getByPlaceholderText('bookmarkFolderName'), {
      target: { value: 'Viewer A private draft' },
    })

    now.mockReturnValue(161_000)
    setViewer('viewer-a', 'token-viewer-a-rotated')
    view.rerender(<FavoritesPageClient embedded />)
    await waitFor(() => expect(aMyCalls).toBe(2))

    setViewer('viewer-b', 'token-viewer-b')
    view.rerender(<FavoritesPageClient embedded />)
    expect(screen.queryByText('Viewer A private folder')).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue('Viewer A private draft')).not.toBeInTheDocument()

    expect(await screen.findByText('Viewer B folder')).toBeInTheDocument()
    await act(async () => {
      lateA.resolve(folderResponse([folder('a-late', 'Late A secret')]))
      await lateA.promise
    })

    expect(screen.queryByText('Late A secret')).not.toBeInTheDocument()
    expect(screen.getByText('Viewer B folder')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }))
    expect(screen.getByPlaceholderText('bookmarkFolderName')).toHaveValue('')
  })
})
