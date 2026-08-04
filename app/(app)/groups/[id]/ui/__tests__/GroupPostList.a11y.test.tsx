import { fireEvent, render, screen } from '@testing-library/react'

jest.mock('next/dynamic', () => () => () => null)
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))
jest.mock('@/app/components/post/MasonryPostCard', () => () => null)
jest.mock('@/app/components/ui/MasonryGrid', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
jest.mock('../PostListItem', () => () => null)

import GroupPostList from '../GroupPostList'

const setSortMode = jest.fn()
const setViewMode = jest.fn()

const baseProps = {
  groupId: '11111111-1111-4111-8111-111111111111',
  language: 'en',
  userId: null,
  accessToken: null,
  userRole: null,
  isMember: false,
  joining: false,
  onJoin: jest.fn(),
  sortedPosts: [],
  sortMode: 'latest' as const,
  setSortMode,
  viewMode: 'list' as const,
  setViewMode,
  hasMorePosts: false,
  loadingMore: false,
  sentinelRef: { current: null },
  editingPost: null,
  setEditingPost: jest.fn(),
  editTitle: '',
  setEditTitle: jest.fn(),
  editContent: '',
  setEditContent: jest.fn(),
  savingEdit: false,
  deletingPost: null,
  likeLoading: {},
  bookmarkLoading: {},
  repostLoading: {},
  showRepostModal: null,
  setShowRepostModal: jest.fn(),
  repostComment: '',
  setRepostComment: jest.fn(),
  expandedComments: {},
  comments: {},
  newComment: {},
  setNewComment: jest.fn(),
  commentLoading: {},
  replyingTo: {},
  setReplyingTo: jest.fn(),
  replyContent: {},
  setReplyContent: jest.fn(),
  expandedReplies: {},
  setExpandedReplies: jest.fn(),
  expandedPosts: {},
  setExpandedPosts: jest.fn(),
  translatedPosts: {},
  translationLoading: false,
  handleLike: jest.fn(),
  handleBookmark: jest.fn(),
  handleRepost: jest.fn(),
  handleDeletePost: jest.fn(),
  handleSaveEdit: jest.fn(),
  handlePinPost: jest.fn(),
  toggleComments: jest.fn(),
  submitComment: jest.fn(),
  submitReply: jest.fn(),
  getHeatColor: () => '#000000',
}

describe('GroupPostList selected control semantics', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('exposes the selected sort and view modes with aria-pressed', () => {
    const view = render(<GroupPostList {...baseProps} />)

    expect(screen.getByRole('button', { name: 'latest' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'hot' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'listView' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'masonryView' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )

    fireEvent.click(screen.getByRole('button', { name: 'hot' }))
    fireEvent.click(screen.getByRole('button', { name: 'masonryView' }))
    expect(setSortMode).toHaveBeenCalledWith('hot')
    expect(setViewMode).toHaveBeenCalledWith('masonry')

    view.rerender(<GroupPostList {...baseProps} sortMode="hot" viewMode="masonry" />)
    expect(screen.getByRole('button', { name: 'latest' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'hot' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'listView' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(screen.getByRole('button', { name: 'masonryView' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })
})
