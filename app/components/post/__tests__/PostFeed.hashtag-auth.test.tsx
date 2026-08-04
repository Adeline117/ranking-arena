import { render } from '@testing-library/react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { usePostComments } from '../hooks/usePostComments'
import { usePostTranslation } from '../hooks/usePostTranslation'
import { usePostActions } from '../hooks/usePostActions'
import PostFeed from '../PostFeed'

const mockAuthedFetch = jest.fn()

jest.mock('@tanstack/react-query', () => ({
  useInfiniteQuery: jest.fn(),
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({ useAuthSession: jest.fn() }))
jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn() },
}))
jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
}))
jest.mock('../hooks/usePostComments', () => ({ usePostComments: jest.fn() }))
jest.mock('../hooks/usePostTranslation', () => ({ usePostTranslation: jest.fn() }))
jest.mock('../hooks/usePostActions', () => ({ usePostActions: jest.fn() }))
jest.mock('@/lib/hooks/useRealtime', () => ({
  usePostsRealtime: jest.fn(),
  useCommentsRealtime: jest.fn(),
}))
jest.mock('../../Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))
jest.mock('../../ui/Toast', () => ({
  useToast: () => ({ showToast: jest.fn() }),
}))
jest.mock('../../ui/Dialog', () => ({
  useDialog: () => ({ showDangerConfirm: jest.fn().mockResolvedValue(true) }),
}))
jest.mock('../components', () => ({
  SortButtons: () => null,
  PostDetailView: () => null,
}))
jest.mock('../PostList', () => ({ PostListItem: () => null }))
jest.mock('../Modals', () => ({ EditPostModal: () => null, RepostModal: () => null }))
jest.mock('../../ui/Dynamic', () => ({ DynamicBookmarkModal: () => null }))

const mockUseInfiniteQuery = useInfiniteQuery as jest.Mock
const mockUseAuthSession = useAuthSession as jest.Mock
const mockUsePostComments = usePostComments as jest.Mock
const mockUsePostTranslation = usePostTranslation as jest.Mock
const mockUsePostActions = usePostActions as jest.Mock

type HashtagQueryContext = {
  pageParam: number
  signal: AbortSignal
}

type HashtagQueryPage = {
  posts: Array<Record<string, unknown>>
  hasMore: boolean
  offset: number
}

type CapturedQueryOptions = {
  queryFn: (context: HashtagQueryContext) => Promise<HashtagQueryPage>
}

let latestQueryOptions: CapturedQueryOptions | null
const originalFetch = globalThis.fetch
let authState: {
  accessToken: string | null
  userId: string | null
  authChecked: boolean
  viewerKey: string
  sessionGeneration: number
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function queryFn(): CapturedQueryOptions['queryFn'] {
  if (!latestQueryOptions) throw new Error('PostFeed did not register its hashtag query')
  return latestQueryOptions.queryFn
}

function successfulPage(id = 'post-1') {
  return {
    ok: true,
    status: 200,
    data: {
      success: true,
      data: { posts: [{ id }] },
      meta: { pagination: { has_more: false } },
    },
  }
}

describe('PostFeed hashtag request identity scope', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    latestQueryOptions = null
    authState = {
      accessToken: 'token-a',
      userId: 'user-a',
      authChecked: true,
      viewerKey: 'user:user-a',
      sessionGeneration: 1,
    }
    mockUseAuthSession.mockImplementation(() => authState)
    const queryResult = {
      data: { pages: [] },
      fetchNextPage: jest.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
      isLoading: false,
      error: null,
      refetch: jest.fn().mockResolvedValue(undefined),
    }
    mockUseInfiniteQuery.mockImplementation((options: CapturedQueryOptions) => {
      latestQueryOptions = options
      return queryResult
    })
    mockUsePostComments.mockReturnValue({
      comments: [],
      setComments: jest.fn(),
      loadComments: jest.fn(),
    })
    mockUsePostTranslation.mockReturnValue({
      translatedListPosts: {},
      translatedContent: null,
      showingOriginal: true,
      setShowingOriginal: jest.fn(),
      translating: false,
      isChineseText: jest.fn().mockReturnValue(false),
      removeImagesFromContent: (value: string) => value,
      translateContent: jest.fn(),
      translateListPosts: jest.fn(),
      translateComments: jest.fn(),
      setTranslatedContent: jest.fn(),
      translatedComments: {},
    })
    mockUsePostActions.mockReturnValue({
      bookmarkCounts: {},
      bookmarkingPostId: null,
      customPoll: {},
      customPollUserVotes: {},
      editingPost: null,
      editTitle: '',
      editContent: '',
      loadingCustomPoll: false,
      repostLoading: {},
      savingEdit: false,
      selectedPollOptions: [],
      showBookmarkModal: false,
      showRepostModal: null,
      userBookmarks: new Set(),
      votingCustomPoll: false,
      handleBookmark: jest.fn(),
      handleBookmarkToFolder: jest.fn(),
      handleDeletePost: jest.fn(),
      handleRepost: jest.fn(),
      handleSaveEdit: jest.fn(),
      handleStartEdit: jest.fn(),
      handleTogglePin: jest.fn(),
      loadCustomPoll: jest.fn(),
      loadUserBookmarksAndReposts: jest.fn(),
      openBookmarkFolderModal: jest.fn(),
      openRepostModal: jest.fn(),
      setBookmarkCounts: jest.fn(),
      setBookmarkingPostId: jest.fn(),
      setEditContent: jest.fn(),
      setEditingPost: jest.fn(),
      setEditTitle: jest.fn(),
      setSelectedPollOptions: jest.fn(),
      setShowBookmarkModal: jest.fn(),
      setShowRepostModal: jest.fn(),
      submitCustomPollVote: jest.fn(),
      toggleReaction: jest.fn(),
    })

    class MockIntersectionObserver {
      observe = jest.fn()
      disconnect = jest.fn()
    }
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: MockIntersectionObserver,
    })
  })

  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch
    } else {
      delete (globalThis as { fetch?: typeof fetch }).fetch
    }
  })

  it('uses the centralized refresh-capable helper with the exact authenticated scope and signal', async () => {
    mockAuthedFetch.mockResolvedValue(successfulPage())
    render(<PostFeed tag="BTC" />)
    const controller = new AbortController()

    await expect(queryFn()({ pageParam: 20, signal: controller.signal })).resolves.toEqual({
      posts: [{ id: 'post-1' }],
      hasMore: false,
      offset: 21,
    })
    expect(mockAuthedFetch).toHaveBeenCalledWith(
      '/api/hashtags/BTC?limit=20&offset=20&sort_by=created_at',
      'GET',
      'token-a',
      undefined,
      15_000,
      {
        expectedUserId: 'user-a',
        expectedSessionGeneration: 1,
        signal: controller.signal,
      }
    )
  })

  it('keeps an anonymous hashtag request explicitly anonymous', async () => {
    Object.assign(authState, {
      accessToken: null,
      userId: null,
      viewerKey: 'anon',
      sessionGeneration: 2,
    })
    mockAuthedFetch.mockResolvedValue(successfulPage('public-post'))
    render(<PostFeed tag="btc" />)
    const controller = new AbortController()

    await expect(queryFn()({ pageParam: 0, signal: controller.signal })).resolves.toMatchObject({
      posts: [{ id: 'public-post' }],
    })
    expect(mockAuthedFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/hashtags/btc?'),
      'GET',
      null,
      undefined,
      15_000,
      expect.objectContaining({
        expectedUserId: null,
        expectedSessionGeneration: 2,
        signal: controller.signal,
      })
    )
  })

  it('leaves the existing non-hashtag feed on its native fetch transport', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        data: { posts: [] },
        meta: { pagination: { has_more: false } },
      }),
    })
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: fetchMock,
    })
    render(<PostFeed />)

    await expect(
      queryFn()({ pageParam: 0, signal: new AbortController().signal })
    ).resolves.toEqual({ posts: [], hasMore: false, offset: 0 })
    expect(mockAuthedFetch).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/posts?limit=20&offset=0&sort_by=created_at&sort_order=desc',
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token-a',
        },
      }
    )
  })

  it.each([
    [
      'another user',
      {
        accessToken: 'token-b',
        userId: 'user-b',
        viewerKey: 'user:user-b',
        sessionGeneration: 2,
      },
    ],
    [
      'logout',
      {
        accessToken: null,
        userId: null,
        viewerKey: 'anon',
        sessionGeneration: 2,
      },
    ],
  ])('rejects a late hashtag page after transition to %s', async (_label, nextAuth) => {
    const page = deferred<ReturnType<typeof successfulPage>>()
    mockAuthedFetch.mockReturnValue(page.promise)
    const view = render(<PostFeed tag="btc" />)
    const oldQuery = queryFn()
    const staleRequest = oldQuery({ pageParam: 0, signal: new AbortController().signal })
    const staleResult = expect(staleRequest).rejects.toMatchObject({ name: 'AbortError' })

    Object.assign(authState, nextAuth)
    view.rerender(<PostFeed tag="btc" />)

    page.resolve(successfulPage('private-to-a'))
    await staleResult
  })

  it('passes query cancellation through and never resolves an aborted page', async () => {
    mockAuthedFetch.mockImplementation(
      (
        _url: string,
        _method: string,
        _token: string | null,
        _body: undefined,
        _timeout: number,
        scope: { signal: AbortSignal }
      ) =>
        new Promise((resolve) => {
          scope.signal.addEventListener(
            'abort',
            () => resolve({ ok: false, status: 0, data: null }),
            { once: true }
          )
        })
    )
    render(<PostFeed tag="btc" />)
    const controller = new AbortController()
    const request = queryFn()({ pageParam: 0, signal: controller.signal })
    const abortedResult = expect(request).rejects.toMatchObject({ name: 'AbortError' })

    controller.abort()

    await abortedResult
    expect(mockAuthedFetch.mock.calls[0]?.[5]?.signal).toBe(controller.signal)
  })
})
