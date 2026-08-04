import { fireEvent, render, screen } from '@testing-library/react'
import { CommentThread } from '../CommentThread'
import type { Comment } from '../comment-types'

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}))

jest.mock('../CommentAvatar', () => ({
  CommentAvatar: () => null,
  ProBadge: () => null,
}))

const COMMENT_ID = '33333333-3333-4333-8333-333333333333'
const POST_ID = '22222222-2222-4222-8222-222222222222'

function comment(): Comment {
  return {
    id: COMMENT_ID,
    user_id: 'author-id',
    content: 'comment',
    created_at: '2026-08-03T20:00:00.000Z',
    author_handle: 'alice',
    like_count: 2,
    dislike_count: 1,
    replies: [],
  }
}

describe('CommentThread reaction latest-intent controls', () => {
  it('keeps both reaction buttons actionable while a lane is busy', () => {
    const onToggleCommentLike = jest.fn()
    const onToggleCommentDislike = jest.fn()

    render(
      <CommentThread
        comment={comment()}
        postId={POST_ID}
        viewerKey="user:viewer"
        currentUserId="viewer"
        language="en"
        t={(key) => key}
        replyingTo={null}
        setReplyingTo={jest.fn()}
        submittingReply={false}
        onSubmitReply={jest.fn().mockResolvedValue(false)}
        commentLikeLoading={{ [COMMENT_ID]: true }}
        onToggleCommentLike={onToggleCommentLike}
        onToggleCommentDislike={onToggleCommentDislike}
        deletingCommentId={null}
        onDeleteComment={jest.fn()}
        expandedReplies={{}}
        setExpandedReplies={jest.fn()}
      />
    )

    const upvote = screen.getByRole('button', { name: 'upvote' })
    const downvote = screen.getByRole('button', { name: 'downvote' })
    expect(upvote).not.toBeDisabled()
    expect(downvote).not.toBeDisabled()
    expect(upvote).toHaveAttribute('aria-busy', 'true')
    expect(downvote).toHaveAttribute('aria-busy', 'true')

    fireEvent.click(upvote)
    fireEvent.click(downvote)
    expect(onToggleCommentLike).toHaveBeenCalledWith(POST_ID, COMMENT_ID)
    expect(onToggleCommentDislike).toHaveBeenCalledWith(POST_ID, COMMENT_ID)
  })
})
