import { render, screen } from '@testing-library/react'
import CommentsModal from '../CommentsModal'
import type { Comment } from '../hooks/usePostComments'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ language: 'en', t: (key: string) => key }),
}))

jest.mock('../comments/CommentThread', () => ({
  CommentThread: ({ comment }: { comment: Comment }) => (
    <div data-testid={`comment-${comment.id}`}>{comment.id}</div>
  ),
}))

jest.mock('../comments/CommentInput', () => ({ CommentInput: () => null }))
jest.mock('../comments/CommentActions', () => ({
  CommentSkeleton: () => <div>loading</div>,
  EmptyComments: () => <div>empty</div>,
  CommentSortToggle: () => null,
}))

function comment(id: string, createdAt: string, likeCount: number): Comment {
  return {
    id,
    content: id,
    created_at: createdAt,
    like_count: likeCount,
    dislike_count: 0,
  }
}

function props(comments: Comment[]) {
  return {
    postId: 'post-1',
    viewerKey: 'user:viewer-1',
    comments,
    loadingComments: false,
    currentUserId: 'viewer-1',
    submittingComment: false,
    onSubmitComment: jest.fn(),
    replyingTo: null,
    setReplyingTo: jest.fn(),
    replyContent: '',
    setReplyContent: jest.fn(),
    submittingReply: false,
    onSubmitReply: jest.fn(),
    commentLikeLoading: {},
    onToggleCommentLike: jest.fn(),
    onToggleCommentDislike: jest.fn(),
    deletingCommentId: null,
    onDeleteComment: jest.fn(),
    expandedReplies: {},
    setExpandedReplies: jest.fn(),
    commentSort: 'best' as const,
  }
}

function renderedOrder() {
  return screen
    .getAllByTestId(/^comment-/)
    .map((element) => element.getAttribute('data-testid')?.replace('comment-', ''))
}

describe('CommentsModal root ordering', () => {
  it('keeps root comments in place when reaction counts change', () => {
    const older = comment('older', '2026-07-14T00:00:00.000Z', 10)
    const newer = comment('newer', '2026-07-15T00:00:00.000Z', 1)
    const { rerender } = render(<CommentsModal {...props([older, newer])} />)

    expect(renderedOrder()).toEqual(['older', 'newer'])

    rerender(<CommentsModal {...props([older, { ...newer, like_count: 100 }])} />)

    expect(renderedOrder()).toEqual(['older', 'newer'])
  })

  it('re-sorts when the root structure changes', () => {
    const older = comment('older', '2026-07-14T00:00:00.000Z', 10)
    const newer = comment('newer', '2026-07-15T00:00:00.000Z', 1)
    const { rerender } = render(<CommentsModal {...props([older, newer])} />)

    rerender(
      <CommentsModal
        {...props([
          older,
          { ...newer, like_count: 100 },
          comment('third', '2026-07-13T00:00:00.000Z', 0),
        ])}
      />
    )

    expect(renderedOrder()).toEqual(['newer', 'older', 'third'])
  })
})
