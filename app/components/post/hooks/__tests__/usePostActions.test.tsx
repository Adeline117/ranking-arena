import { act, renderHook } from '@testing-library/react'
import { useCallback, useState } from 'react'
import type { PostWithUserState } from '@/lib/types'
import { usePostActions } from '../usePostActions'

const mockSetOpenPost = jest.fn()
const mockUpdatePostReaction = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}))

jest.mock('@/lib/stores/postStore', () => ({
  usePostStore: {
    getState: () => ({ updatePostReaction: mockUpdatePostReaction }),
  },
}))

jest.mock('@/lib/utils/haptics', () => ({ haptic: jest.fn() }))
jest.mock('@/lib/analytics/track', () => ({ trackEvent: jest.fn() }))

const initialPost: PostWithUserState = {
  id: 'post-1',
  title: 'Post',
  content: 'Body',
  author_id: 'author-1',
  author_handle: 'author',
  poll_enabled: false,
  poll_bull: 0,
  poll_bear: 0,
  poll_wait: 0,
  like_count: 10,
  dislike_count: 2,
  comment_count: 0,
  bookmark_count: 3,
  repost_count: 0,
  view_count: 0,
  hot_score: 0,
  is_pinned: false,
  created_at: '2026-07-08T00:00:00.000Z',
  user_reaction: null,
  user_vote: null,
}

type ViewerProps = {
  accessToken: string
  currentUserId: string
  viewerKey: string
  sessionGeneration: number
}

const viewerA: ViewerProps = {
  accessToken: 'token-a',
  currentUserId: 'viewer-a',
  viewerKey: 'user:viewer-a',
  sessionGeneration: 1,
}

function useAliasedPostActions(viewer: ViewerProps = viewerA) {
  const [post, setPost] = useState(initialPost)
  const setPosts = useCallback<React.Dispatch<React.SetStateAction<PostWithUserState[]>>>(
    (action) => {
      setPost((previous) => {
        const next =
          typeof action === 'function'
            ? (action as (posts: PostWithUserState[]) => PostWithUserState[])([previous])
            : action
        return next[0] ?? previous
      })
    },
    []
  )

  const actions = usePostActions({
    ...viewer,
    posts: [post],
    setPosts,
    openPost: post,
    setOpenPost: mockSetOpenPost,
    openPostAliasesPosts: true,
    showToast: jest.fn(),
    showDangerConfirm: async () => true,
    t: (key) => key,
  })

  return { actions, post, setPost }
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response
}

describe('usePostActions aliased detail state', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = jest.fn()
  })

  it('updates the detail post once and preserves optimistic counts when ACK counts are null', async () => {
    ;(global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse({
        success: true,
        data: { reaction: 'up', like_count: null, dislike_count: null },
      })
    )
    const { result } = renderHook(() => useAliasedPostActions())

    await act(async () => {
      await result.current.actions.toggleReaction('post-1', 'up')
    })

    expect(result.current.post).toMatchObject({
      like_count: 11,
      dislike_count: 2,
      user_reaction: 'up',
    })
    expect(mockSetOpenPost).not.toHaveBeenCalled()
    expect(mockUpdatePostReaction).toHaveBeenCalledWith('post-1', {
      like_count: 11,
      dislike_count: 2,
      reaction: 'up',
    })
  })

  it('does not let a bookmark ACK overwrite a concurrent reaction update', async () => {
    let resolveFetch: ((response: Response) => void) | undefined
    ;(global.fetch as jest.Mock).mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve
      })
    )
    const { result } = renderHook(() => useAliasedPostActions())

    let bookmarkRequest: Promise<void>
    act(() => {
      bookmarkRequest = result.current.actions.handleBookmark('post-1')
    })
    act(() => {
      result.current.setPost((previous) => ({
        ...previous,
        like_count: 11,
        user_reaction: 'up',
      }))
    })

    await act(async () => {
      resolveFetch?.(jsonResponse({ bookmarked: true, bookmark_count: 4 }))
      await bookmarkRequest!
    })

    expect(result.current.post).toMatchObject({
      like_count: 11,
      user_reaction: 'up',
      bookmark_count: 4,
    })
    expect(mockSetOpenPost).not.toHaveBeenCalled()
  })

  it('reverses one optimistic reaction delta when the server rejects the request', async () => {
    ;(global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse({ success: false, error: 'rejected' }, false)
    )
    const { result } = renderHook(() => useAliasedPostActions())

    await act(async () => {
      await result.current.actions.toggleReaction('post-1', 'up')
    })

    expect(result.current.post).toMatchObject({
      like_count: 10,
      dislike_count: 2,
      user_reaction: null,
    })
    expect(mockSetOpenPost).not.toHaveBeenCalled()
  })

  it('reconciles the canonical repost count returned by the server', async () => {
    ;(global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse({
        success: true,
        post_id: 'repost-1',
        root_post_id: 'post-1',
        repost_count: 4,
      })
    )
    const { result } = renderHook(() => useAliasedPostActions())
    act(() => result.current.actions.setShowRepostModal('post-1'))

    let succeeded: boolean | undefined
    await act(async () => {
      succeeded = await result.current.actions.handleRepost('post-1', 'worth sharing')
    })

    expect(succeeded).toBe(true)
    expect(result.current.post.repost_count).toBe(4)
    expect(mockSetOpenPost).not.toHaveBeenCalled()
    // The modal owns its local draft and closes itself after a successful ACK.
    expect(result.current.actions.showRepostModal).toBe('post-1')
  })

  it('does not write a canonical root count onto a clicked child repost', async () => {
    ;(global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse({
        success: true,
        post_id: 'repost-2',
        root_post_id: 'post-1',
        repost_count: 4,
      })
    )
    const { result } = renderHook(() => useAliasedPostActions())
    act(() => {
      result.current.setPost((previous) => ({
        ...previous,
        id: 'repost-1',
        original_post_id: 'post-1',
        repost_count: 0,
      }))
    })

    let succeeded: boolean | undefined
    await act(async () => {
      succeeded = await result.current.actions.handleRepost('repost-1', 'worth sharing')
    })

    expect(succeeded).toBe(true)
    expect(result.current.post.repost_count).toBe(0)
    expect(mockSetOpenPost).not.toHaveBeenCalled()
  })

  it('coalesces rapid repost submissions into one request', async () => {
    let resolveFetch: ((response: Response) => void) | undefined
    ;(global.fetch as jest.Mock).mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve
      })
    )
    const { result } = renderHook(() => useAliasedPostActions())

    let firstRequest: Promise<boolean>
    let duplicateRequest: Promise<boolean>
    act(() => {
      firstRequest = result.current.actions.handleRepost('post-1', 'worth sharing')
      duplicateRequest = result.current.actions.handleRepost('post-1', 'worth sharing')
    })

    expect(global.fetch).toHaveBeenCalledTimes(1)
    await expect(duplicateRequest!).resolves.toBe(false)

    await act(async () => {
      resolveFetch?.(
        jsonResponse({
          success: true,
          post_id: 'repost-1',
          root_post_id: 'post-1',
          repost_count: 4,
        })
      )
      await expect(firstRequest!).resolves.toBe(true)
    })
  })

  it('fails empty for A poll state on the first B render', async () => {
    ;(global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          poll: {
            id: 'poll-a',
            question: 'A private vote state',
            options: [],
            type: 'single',
            endAt: null,
            isExpired: false,
            showResults: true,
            totalVotes: 1,
          },
          userVotes: [0],
        },
      })
    )
    const { result, rerender } = renderHook(
      (viewer: ViewerProps) => useAliasedPostActions(viewer),
      { initialProps: viewerA }
    )
    await act(async () => result.current.actions.loadCustomPoll('post-1'))
    expect(result.current.actions.customPoll?.id).toBe('poll-a')

    rerender({
      accessToken: 'token-b',
      currentUserId: 'viewer-b',
      viewerKey: 'user:viewer-b',
      sessionGeneration: 2,
    })

    expect(result.current.actions.customPoll).toBeNull()
    expect(result.current.actions.customPollUserVotes).toEqual([])
    expect(result.current.actions.selectedPollOptions).toEqual([])
  })

  it('discards a late A bookmark hydration after B becomes active', async () => {
    let resolveBookmarks!: (response: Response) => void
    ;(global.fetch as jest.Mock).mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveBookmarks = resolve
      })
    )
    const { result, rerender } = renderHook(
      (viewer: ViewerProps) => useAliasedPostActions(viewer),
      { initialProps: viewerA }
    )
    let hydration!: Promise<void>
    act(() => {
      hydration = result.current.actions.loadUserBookmarksAndReposts(['post-1'])
    })

    rerender({
      accessToken: 'token-b',
      currentUserId: 'viewer-b',
      viewerKey: 'user:viewer-b',
      sessionGeneration: 2,
    })
    await act(async () => {
      resolveBookmarks(jsonResponse({ bookmarks: { 'post-1': true } }))
      await hydration
    })

    expect(result.current.actions.userBookmarks).toEqual({})
  })

  it('rejects an A-rendered action callback and masks A interaction state on B first render', async () => {
    const { result, rerender } = renderHook(
      (viewer: ViewerProps) => useAliasedPostActions(viewer),
      { initialProps: viewerA }
    )
    act(() => {
      result.current.actions.setShowRepostModal('post-1')
      result.current.actions.setShowBookmarkModal(true)
      result.current.actions.setBookmarkingPostId('post-1')
      result.current.actions.setUserBookmarks({ 'post-1': true })
      result.current.actions.setEditingPost(initialPost)
      result.current.actions.setEditTitle('A private edit title')
    })
    const oldToggleReaction = result.current.actions.toggleReaction

    rerender({
      accessToken: 'token-b',
      currentUserId: 'viewer-b',
      viewerKey: 'user:viewer-b',
      sessionGeneration: 2,
    })

    expect(result.current.actions.showRepostModal).toBeNull()
    expect(result.current.actions.showBookmarkModal).toBe(false)
    expect(result.current.actions.bookmarkingPostId).toBeNull()
    expect(result.current.actions.userBookmarks).toEqual({})
    expect(result.current.actions.editingPost).toBeNull()
    expect(result.current.actions.editTitle).toBe('')

    await act(async () => oldToggleReaction('post-1', 'up'))

    expect(global.fetch).not.toHaveBeenCalled()
    expect(result.current.post.user_reaction).toBeNull()

    act(() => {
      result.current.actions.setUserBookmarks((previous) => ({
        ...previous,
        'post-b': true,
      }))
    })
    expect(result.current.actions.userBookmarks).toEqual({ 'post-b': true })
  })
})
