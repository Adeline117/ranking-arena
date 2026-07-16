import { act, render, waitFor } from '@testing-library/react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { fetchPostCommentsPage } from '@/lib/api/comments-client'
import { usePostTranslation } from '../hooks/usePostTranslation'
import { usePostActions } from '../hooks/usePostActions'
import { usePostsRealtime, useCommentsRealtime } from '@/lib/hooks/useRealtime'
import { usePostStore } from '@/lib/stores/postStore'
import PostFeed from '../PostFeed'

jest.mock('@tanstack/react-query', () => ({
  useInfiniteQuery: jest.fn(),
  useQueryClient: jest.fn(),
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({ useAuthSession: jest.fn() }))

jest.mock('@/lib/api/comments-client', () => ({
  ...jest.requireActual('@/lib/api/comments-client'),
  fetchPostCommentsPage: jest.fn(),
}))

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
  PostDetailView: () => <div data-testid="post-detail" />,
}))

jest.mock('../PostList', () => ({ PostListItem: () => <div data-testid="post-item" /> }))
jest.mock('../Modals', () => ({ EditPostModal: () => null, RepostModal: () => null }))
jest.mock('../../ui/Dynamic', () => ({ DynamicBookmarkModal: () => null }))

const mockUseInfiniteQuery = useInfiniteQuery as jest.Mock
const mockUseQueryClient = useQueryClient as jest.Mock
const mockUseAuthSession = useAuthSession as jest.Mock
const mockFetchPostCommentsPage = fetchPostCommentsPage as jest.Mock
const mockUsePostTranslation = usePostTranslation as jest.Mock
const mockUsePostActions = usePostActions as jest.Mock
const mockUsePostsRealtime = usePostsRealtime as jest.Mock
const mockUseCommentsRealtime = useCommentsRealtime as jest.Mock

const post = {
  id: 'post-1',
  title: 'Post',
  content: 'Body',
  author_id: 'author-1',
  author_handle: 'author',
  created_at: '2026-07-15T00:00:00.000Z',
  like_count: 0,
  dislike_count: 0,
  comment_count: 0,
  bookmark_count: 0,
  repost_count: 0,
  view_count: 0,
  hot_score: 0,
}

describe('PostFeed comment loading stability', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    class MockIntersectionObserver {
      observe = jest.fn()
      disconnect = jest.fn()
    }
    global.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver

    mockUseAuthSession.mockReturnValue({
      accessToken: 'token-a',
      userId: 'user-a',
      authChecked: true,
      viewerKey: 'user:user-a',
      sessionGeneration: 1,
    })
    mockUseQueryClient.mockReturnValue({ invalidateQueries: jest.fn() })
    mockUseInfiniteQuery.mockReturnValue({
      data: { pages: [{ posts: [post], hasMore: false, offset: 1 }] },
      fetchNextPage: jest.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
      isLoading: false,
      error: null,
      refetch: jest.fn().mockResolvedValue(undefined),
    })
    mockFetchPostCommentsPage.mockResolvedValue({
      ok: true,
      comments: [],
      commentCount: 2,
      hasMore: false,
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
      repostComment: '',
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
      setRepostComment: jest.fn(),
      setSelectedPollOptions: jest.fn(),
      setShowBookmarkModal: jest.fn(),
      setShowRepostModal: jest.fn(),
      submitCustomPollVote: jest.fn(),
      toggleReaction: jest.fn(),
    })
  })

  it('loads an opened thread once when its canonical count update rerenders the feed', async () => {
    render(<PostFeed initialPostId="post-1" initialPosts={[post]} />)

    await waitFor(() => expect(mockFetchPostCommentsPage).toHaveBeenCalledTimes(1))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25))
    })

    expect(mockFetchPostCommentsPage).toHaveBeenCalledTimes(1)
  })

  it('discards callbacks captured by the previous viewer session', async () => {
    const auth = {
      accessToken: 'token-a',
      userId: 'user-a',
      authChecked: true,
      viewerKey: 'user:user-a',
      sessionGeneration: 1,
    }
    mockUseAuthSession.mockImplementation(() => auth)

    const view = render(<PostFeed initialPosts={[post]} />)
    const oldPostCallbacks = mockUsePostsRealtime.mock.calls.at(-1)?.[0]
    const oldCommentCallbacks = mockUseCommentsRealtime.mock.calls.at(-1)?.[1]
    expect(oldPostCallbacks).toBeDefined()
    expect(oldCommentCallbacks).toBeDefined()

    Object.assign(auth, {
      accessToken: 'token-b',
      userId: 'user-b',
      viewerKey: 'user:user-b',
      sessionGeneration: 2,
    })
    view.rerender(<PostFeed initialPosts={[post]} />)

    act(() => {
      oldPostCallbacks.onInsert({ id: 'post-from-a' })
      oldPostCallbacks.onUpdate({ new: { id: 'post-1', comment_count: 99 } })
      oldCommentCallbacks.onInsert({
        id: 'comment-from-a',
        post_id: 'post-1',
        user_id: 'other-user',
        content: 'private to viewer A',
      })
    })

    expect(view.queryByText('newPostAvailable')).not.toBeInTheDocument()
    expect(usePostStore.getState().posts['post-1']?.comment_count).not.toBe(99)
    expect(mockUsePostsRealtime.mock.calls.at(-1)?.[1]).toEqual({
      scopeKey: 'user%3Auser-b:2',
      enabled: true,
    })
    expect(mockUseCommentsRealtime.mock.calls.at(-1)?.[2]).toEqual({
      scopeKey: 'user%3Auser-b:2',
      enabled: true,
    })
  })
})
