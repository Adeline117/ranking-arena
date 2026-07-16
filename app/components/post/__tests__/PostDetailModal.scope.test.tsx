import { render, waitFor } from '@testing-library/react'

jest.mock('@/lib/hooks/useAuthSession', () => ({ useAuthSession: jest.fn() }))
jest.mock('@/lib/hooks/useModalA11y', () => ({ useModalA11y: jest.fn() }))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))
jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: jest.fn() }),
}))
jest.mock('../hooks/useCommentDraftPersistence', () => ({
  useCommentDraftPersistence: () => ({
    draft: '',
    setDraft: jest.fn(),
    captureDraftSnapshot: jest.fn(),
    clearDraftIfUnchanged: jest.fn(),
  }),
}))
jest.mock('@/lib/stores/postStore', () => {
  const state = {
    viewerKey: 'pending',
    sessionGeneration: 0,
    posts: {},
    comments: {},
    commentsPagination: {},
  }
  const setViewerScope = jest.fn()
  const usePostStore = Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => ({ setViewerScope }) }
  )
  return {
    usePostStore,
    loadPostForViewer: jest.fn().mockResolvedValue(undefined),
    loadPostComments: jest.fn().mockResolvedValue(undefined),
    loadMorePostComments: jest.fn(),
    submitPostComment: jest.fn(),
    togglePostReaction: jest.fn(),
    __setViewerScope: setViewerScope,
  }
})

import PostDetailModal from '../PostDetailModal'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { loadPostComments, loadPostForViewer } from '@/lib/stores/postStore'

const mockUseAuthSession = useAuthSession as jest.Mock
const mockLoadPostComments = loadPostComments as jest.Mock
const mockLoadPostForViewer = loadPostForViewer as jest.Mock
const mockStoreModule = jest.requireMock('@/lib/stores/postStore') as {
  __setViewerScope: jest.Mock
}

describe('PostDetailModal viewer-scoped reload', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('waits for auth, then reloads the same open post on A to B', async () => {
    mockUseAuthSession.mockReturnValue({
      authChecked: false,
      isLoggedIn: false,
      accessToken: null,
      userId: null,
      viewerKey: 'pending',
      sessionGeneration: 0,
    })
    const { rerender } = render(<PostDetailModal postId="post-1" onClose={jest.fn()} />)
    expect(mockLoadPostComments).not.toHaveBeenCalled()

    mockUseAuthSession.mockReturnValue({
      authChecked: true,
      isLoggedIn: true,
      accessToken: 'token-a',
      userId: 'user-a',
      viewerKey: 'user:user-a',
      sessionGeneration: 1,
    })
    rerender(<PostDetailModal postId="post-1" onClose={jest.fn()} />)
    await waitFor(() => expect(mockLoadPostComments).toHaveBeenCalledTimes(1))
    expect(mockLoadPostForViewer).toHaveBeenCalledTimes(1)
    expect(mockLoadPostComments).toHaveBeenLastCalledWith('post-1', 'token-a', {
      viewerKey: 'user:user-a',
      sessionGeneration: 1,
      userId: 'user-a',
    })

    mockUseAuthSession.mockReturnValue({
      authChecked: true,
      isLoggedIn: true,
      accessToken: 'token-a2',
      userId: 'user-a',
      viewerKey: 'user:user-a',
      sessionGeneration: 1,
    })
    rerender(<PostDetailModal postId="post-1" onClose={jest.fn()} />)
    expect(mockLoadPostComments).toHaveBeenCalledTimes(1)
    expect(mockLoadPostForViewer).toHaveBeenCalledTimes(1)

    mockUseAuthSession.mockReturnValue({
      authChecked: false,
      isLoggedIn: false,
      accessToken: null,
      userId: null,
      viewerKey: 'pending',
      sessionGeneration: 2,
    })
    rerender(<PostDetailModal postId="post-1" onClose={jest.fn()} />)
    expect(mockStoreModule.__setViewerScope).toHaveBeenLastCalledWith('pending', 2)
    expect(mockLoadPostComments).toHaveBeenCalledTimes(1)

    mockUseAuthSession.mockReturnValue({
      authChecked: true,
      isLoggedIn: true,
      accessToken: 'token-b',
      userId: 'user-b',
      viewerKey: 'user:user-b',
      sessionGeneration: 3,
    })
    rerender(<PostDetailModal postId="post-1" onClose={jest.fn()} />)
    await waitFor(() => expect(mockLoadPostComments).toHaveBeenCalledTimes(2))
    expect(mockLoadPostForViewer).toHaveBeenCalledTimes(2)

    expect(mockStoreModule.__setViewerScope).toHaveBeenLastCalledWith('user:user-b', 3)
    expect(mockLoadPostComments).toHaveBeenLastCalledWith('post-1', 'token-b', {
      viewerKey: 'user:user-b',
      sessionGeneration: 3,
      userId: 'user-b',
    })
    expect(mockLoadPostForViewer).toHaveBeenLastCalledWith('post-1', 'token-b', {
      viewerKey: 'user:user-b',
      sessionGeneration: 3,
      userId: 'user-b',
    })
  })
})
