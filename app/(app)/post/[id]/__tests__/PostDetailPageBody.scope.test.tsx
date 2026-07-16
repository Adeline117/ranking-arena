import { act, render, screen, waitFor } from '@testing-library/react'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { usePostComments } from '@/app/components/post/hooks/usePostComments'
import { usePostActions } from '@/app/components/post/hooks/usePostActions'
import { usePostTranslation } from '@/app/components/post/hooks/usePostTranslation'
import { authedFetch } from '@/lib/api/client'
import PostDetailPageBody from '../PostDetailPageBody'

const mockRouter = { push: jest.fn() }
const mockRenderedReactions: Array<string | null | undefined> = []

jest.mock('next/navigation', () => ({ useRouter: () => mockRouter }))
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
jest.mock('@/lib/hooks/useAuthSession', () => ({ useAuthSession: jest.fn() }))
jest.mock('@/app/components/post/hooks/usePostComments', () => ({ usePostComments: jest.fn() }))
jest.mock('@/app/components/post/hooks/usePostActions', () => ({ usePostActions: jest.fn() }))
jest.mock('@/app/components/post/hooks/usePostTranslation', () => ({
  usePostTranslation: jest.fn(),
}))
jest.mock('@/lib/api/client', () => ({ authedFetch: jest.fn() }))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))
jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: jest.fn() }),
}))
jest.mock('@/app/components/ui/Dialog', () => ({
  useDialog: () => ({ showDangerConfirm: jest.fn() }),
}))
jest.mock('@/app/components/post/components', () => ({
  PostDetailView: ({
    openPost,
  }: {
    openPost: { comment_count: number; user_reaction?: string | null }
  }) => {
    mockRenderedReactions.push(openPost.user_reaction)
    return <div data-testid="post-state" data-comments={openPost.comment_count} />
  },
}))
jest.mock('@/app/components/ui/Breadcrumb', () => () => null)
jest.mock('@/app/components/common/ShareButton', () => () => null)
jest.mock('@/app/components/post/Modals', () => ({ RepostModal: () => null }))
jest.mock('@/app/components/ui/Dynamic', () => ({ DynamicBookmarkModal: () => null }))
jest.mock('@/lib/tracking', () => ({ trackInteraction: jest.fn() }))

const mockUseAuthSession = useAuthSession as jest.Mock
const mockUsePostComments = usePostComments as jest.Mock
const mockUsePostActions = usePostActions as jest.Mock
const mockUsePostTranslation = usePostTranslation as jest.Mock
const mockAuthedFetch = authedFetch as jest.Mock

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const initialPost = {
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

describe('PostDetailPageBody scoped hydration', () => {
  let commentOptions: {
    onCommentCountChange: (postId: string, delta: number, count?: number) => void
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockRenderedReactions.length = 0
    mockUseAuthSession.mockReturnValue({
      accessToken: 'token-a',
      userId: 'user-a',
      authChecked: true,
      viewerKey: 'user:user-a',
      sessionGeneration: 1,
    })
    mockUsePostComments.mockImplementation((options) => {
      commentOptions = options
      return {
        comments: [],
        loadComments: jest.fn(),
        loadingComments: false,
        newComment: '',
        setNewComment: jest.fn(),
        submittingComment: false,
        submitComment: jest.fn(),
        replyingTo: null,
        setReplyingTo: jest.fn(),
        replyContent: '',
        setReplyContent: jest.fn(),
        submittingReply: false,
        submitReply: jest.fn(),
        commentLikeLoading: {},
        toggleCommentLike: jest.fn(),
        toggleCommentDislike: jest.fn(),
        deletingCommentId: null,
        deleteComment: jest.fn(),
        editingComment: null,
        editContent: '',
        setEditContent: jest.fn(),
        submittingEdit: false,
        startEditComment: jest.fn(),
        cancelEditComment: jest.fn(),
        submitEditComment: jest.fn(),
        expandedReplies: {},
        setExpandedReplies: jest.fn(),
      }
    })
    mockUsePostTranslation.mockReturnValue({
      translatedListPosts: {},
      translatedContent: null,
      showingOriginal: true,
      setShowingOriginal: jest.fn(),
      translating: false,
      removeImagesFromContent: (value: string) => value,
      translatedComments: {},
    })
    mockUsePostActions.mockReturnValue({
      customPoll: null,
      loadingCustomPoll: false,
      customPollUserVotes: [],
      selectedPollOptions: [],
      setSelectedPollOptions: jest.fn(),
      votingCustomPoll: false,
      submitCustomPollVote: jest.fn(),
      userBookmarks: {},
      bookmarkCounts: {},
      setBookmarkCounts: jest.fn(),
      toggleReaction: jest.fn(),
      handleBookmark: jest.fn(),
      openBookmarkFolderModal: jest.fn(),
      openRepostModal: jest.fn(),
      loadCustomPoll: jest.fn(),
      loadUserBookmarksAndReposts: jest.fn(),
      showRepostModal: null,
      setShowRepostModal: jest.fn(),
      handleRepost: jest.fn(),
      showBookmarkModal: false,
      setShowBookmarkModal: jest.fn(),
      bookmarkingPostId: null,
      setBookmarkingPostId: jest.fn(),
      handleBookmarkToFolder: jest.fn(),
    })
  })

  it('does not let an older GET overwrite a newer canonical comment count', async () => {
    const hydration = deferred<unknown>()
    mockAuthedFetch.mockReturnValueOnce(hydration.promise)
    render(<PostDetailPageBody post={initialPost as never} />)
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))

    act(() => commentOptions.onCommentCountChange('post-1', 0, 9))
    hydration.resolve({
      ok: true,
      status: 200,
      data: {
        success: true,
        data: { post: { ...initialPost, comment_count: 1, user_reaction: 'up' } },
      },
    })
    await act(async () => Promise.resolve())

    expect(screen.getByTestId('post-state')).toHaveAttribute('data-comments', '9')
  })

  it('fails empty for A reaction state on the first B render', async () => {
    mockAuthedFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        success: true,
        data: { post: { ...initialPost, user_reaction: 'up' } },
      },
    })
    const { rerender } = render(<PostDetailPageBody post={initialPost as never} />)
    await waitFor(() => expect(mockRenderedReactions).toContain('up'))

    const bHydration = deferred<unknown>()
    mockAuthedFetch.mockReturnValueOnce(bHydration.promise)
    mockUseAuthSession.mockReturnValue({
      accessToken: 'token-b',
      userId: 'user-b',
      authChecked: true,
      viewerKey: 'user:user-b',
      sessionGeneration: 2,
    })
    const firstBRender = mockRenderedReactions.length
    rerender(<PostDetailPageBody post={initialPost as never} />)
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(2))

    expect(mockRenderedReactions.slice(firstBRender).every((reaction) => reaction == null)).toBe(
      true
    )
    bHydration.resolve({ ok: false, status: 404, data: null })
    await act(async () => Promise.resolve())
  })
})
