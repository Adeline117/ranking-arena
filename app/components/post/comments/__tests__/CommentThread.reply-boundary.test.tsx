import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { CommentThread } from '../CommentThread'
import type { Comment } from '../comment-types'
import type { ReplyTarget } from '../reply-types'

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

const t = (key: string) => key

function comment(id: string, handle: string): Comment {
  return {
    id,
    user_id: `author-${id}`,
    content: `content-${id}`,
    created_at: '2026-07-15T00:00:00.000Z',
    author_handle: handle,
    like_count: 0,
    dislike_count: 0,
    replies: [],
  }
}

const commentA = comment('comment-a', 'alice')
const commentB = comment('comment-b', 'bob')

function threadProps({
  target = { commentId: commentA.id, handle: 'alice' },
  item = commentA,
  postId = 'post-a',
  viewerKey = 'user:a',
  submittingReply = false,
  setReplyingTo = jest.fn(),
  onSubmitReply = jest.fn().mockResolvedValue(false),
}: {
  target?: ReplyTarget | null
  item?: Comment
  postId?: string
  viewerKey?: string
  submittingReply?: boolean
  setReplyingTo?: React.Dispatch<React.SetStateAction<ReplyTarget | null>>
  onSubmitReply?: jest.Mock<Promise<boolean>, [string, string, string]>
} = {}) {
  return {
    comment: item,
    postId,
    viewerKey,
    currentUserId: 'viewer',
    language: 'en',
    t,
    replyingTo: target,
    setReplyingTo,
    submittingReply,
    onSubmitReply,
    commentLikeLoading: {},
    onToggleCommentLike: jest.fn(),
    onToggleCommentDislike: jest.fn(),
    deletingCommentId: null,
    onDeleteComment: jest.fn(),
    expandedReplies: {},
    setExpandedReplies: jest.fn(),
  }
}

describe('CommentThread reply draft boundary', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('keeps reply keystrokes out of the parent and sibling while preserving focus and caret', () => {
    let parentRenders = 0
    let siblingRenders = 0

    function Sibling() {
      siblingRenders += 1
      return <div data-testid="sibling" />
    }

    function Shell() {
      parentRenders += 1
      const [target, setTarget] = useState<ReplyTarget | null>({
        commentId: commentA.id,
        handle: 'alice',
      })
      return (
        <>
          <CommentThread {...threadProps({ target, setReplyingTo: setTarget })} />
          <Sibling />
        </>
      )
    }

    render(<Shell />)
    const textarea = screen.getByRole('textbox', { name: 'reply @alice' })
    const draft = 'local reply draft'
    textarea.focus()

    for (let index = 1; index <= draft.length; index += 1) {
      fireEvent.change(textarea, { target: { value: draft.slice(0, index) } })
    }
    textarea.setSelectionRange(4, 4)
    fireEvent.change(textarea, {
      target: {
        value: `${draft.slice(0, 4)}X${draft.slice(4)}`,
        selectionStart: 5,
        selectionEnd: 5,
      },
    })

    expect(parentRenders).toBe(1)
    expect(siblingRenders).toBe(1)
    expect(document.activeElement).toBe(textarea)
    expect(textarea.selectionStart).toBe(5)
    expect(textarea.selectionEnd).toBe(5)
    expect(textarea).toHaveAttribute('maxlength', '2000')
  })

  it('submits exact trimmed content and closes only after an unchanged successful ACK', async () => {
    const onSubmitReply = jest.fn().mockResolvedValue(true)

    function Shell() {
      const [target, setTarget] = useState<ReplyTarget | null>({
        commentId: commentA.id,
        handle: 'alice',
      })
      return <CommentThread {...threadProps({ target, setReplyingTo: setTarget, onSubmitReply })} />
    }

    render(<Shell />)
    const textarea = screen.getByRole('textbox', { name: 'reply @alice' })
    fireEvent.change(textarea, { target: { value: '  完整回复 payload  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'send' }))

    await waitFor(() =>
      expect(onSubmitReply).toHaveBeenCalledWith('post-a', 'comment-a', '完整回复 payload')
    )
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'reply @alice' })).not.toBeInTheDocument()
    )
    expect(localStorage.getItem('comment-draft-v2:user:a:reply:post-a:comment-a')).toBeNull()
  })

  it('does not let a late successful ACK erase text typed during submission', async () => {
    let resolveAcknowledgement!: (acknowledged: boolean) => void
    const acknowledgement = new Promise<boolean>((resolve) => {
      resolveAcknowledgement = resolve
    })
    const onSubmitReply = jest.fn(() => acknowledgement)

    function Shell() {
      const [target, setTarget] = useState<ReplyTarget | null>({
        commentId: commentA.id,
        handle: 'alice',
      })
      return <CommentThread {...threadProps({ target, setReplyingTo: setTarget, onSubmitReply })} />
    }

    render(<Shell />)
    const textarea = screen.getByRole('textbox', { name: 'reply @alice' })
    fireEvent.change(textarea, { target: { value: 'submitted reply' } })
    fireEvent.click(screen.getByRole('button', { name: 'send' }))

    textarea.focus()
    fireEvent.change(textarea, { target: { value: 'new reply while waiting' } })
    textarea.setSelectionRange(7, 7)

    await act(async () => {
      resolveAcknowledgement(true)
      await acknowledgement
    })

    expect(textarea).toHaveValue('new reply while waiting')
    expect(document.activeElement).toBe(textarea)
    expect(textarea.selectionStart).toBe(7)
    expect(textarea.selectionEnd).toBe(7)
    expect(screen.getByRole('textbox', { name: 'reply @alice' })).toBeInTheDocument()
  })

  it('does not let an old reply ACK close a newer reply target', async () => {
    let resolveAcknowledgement!: (acknowledged: boolean) => void
    const acknowledgement = new Promise<boolean>((resolve) => {
      resolveAcknowledgement = resolve
    })
    const onSubmitReply = jest.fn(() => acknowledgement)

    function Shell() {
      const [target, setTarget] = useState<ReplyTarget | null>({
        commentId: commentA.id,
        handle: 'alice',
      })
      return (
        <>
          <button onClick={() => setTarget({ commentId: commentB.id, handle: 'bob' })}>
            switch target
          </button>
          <CommentThread
            {...threadProps({
              item: commentA,
              target,
              setReplyingTo: setTarget,
              onSubmitReply,
            })}
          />
          <CommentThread
            {...threadProps({
              item: commentB,
              target,
              setReplyingTo: setTarget,
              onSubmitReply,
            })}
          />
        </>
      )
    }

    render(<Shell />)
    fireEvent.change(screen.getByRole('textbox', { name: 'reply @alice' }), {
      target: { value: 'submitted to Alice' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'send' }))
    fireEvent.click(screen.getByRole('button', { name: 'switch target' }))

    const bobTextarea = screen.getByRole('textbox', { name: 'reply @bob' })
    fireEvent.change(bobTextarea, { target: { value: 'new reply to Bob' } })
    bobTextarea.focus()
    bobTextarea.setSelectionRange(6, 6)

    await act(async () => {
      resolveAcknowledgement(true)
      await acknowledgement
    })

    expect(bobTextarea).toHaveValue('new reply to Bob')
    expect(document.activeElement).toBe(bobTextarea)
    expect(bobTextarea.selectionStart).toBe(6)
    expect(bobTextarea.selectionEnd).toBe(6)
    expect(screen.getByRole('textbox', { name: 'reply @bob' })).toBeInTheDocument()
  })

  it('isolates retained drafts by viewer, post, and reply target', async () => {
    const onSubmitReply = jest.fn().mockResolvedValue(false)
    const view = render(<CommentThread {...threadProps({ onSubmitReply })} />)
    let textarea = screen.getByRole('textbox', { name: 'reply @alice' })
    fireEvent.change(textarea, { target: { value: 'viewer A, post A, Alice' } })

    view.rerender(
      <CommentThread
        {...threadProps({ item: commentB, target: { commentId: commentB.id, handle: 'bob' } })}
      />
    )
    textarea = screen.getByRole('textbox', { name: 'reply @bob' })
    await waitFor(() => expect(textarea).toHaveValue(''))
    fireEvent.change(textarea, { target: { value: 'viewer A, post A, Bob' } })

    view.rerender(<CommentThread {...threadProps()} />)
    textarea = screen.getByRole('textbox', { name: 'reply @alice' })
    await waitFor(() => expect(textarea).toHaveValue('viewer A, post A, Alice'))

    view.rerender(<CommentThread {...threadProps({ postId: 'post-b' })} />)
    textarea = screen.getByRole('textbox', { name: 'reply @alice' })
    await waitFor(() => expect(textarea).toHaveValue(''))
    fireEvent.change(textarea, { target: { value: 'viewer A, post B, Alice' } })

    view.rerender(<CommentThread {...threadProps({ viewerKey: 'user:b' })} />)
    textarea = screen.getByRole('textbox', { name: 'reply @alice' })
    await waitFor(() => expect(textarea).toHaveValue(''))
    fireEvent.change(textarea, { target: { value: 'viewer B, post A, Alice' } })

    view.rerender(<CommentThread {...threadProps()} />)
    textarea = screen.getByRole('textbox', { name: 'reply @alice' })
    await waitFor(() => expect(textarea).toHaveValue('viewer A, post A, Alice'))

    expect(localStorage.getItem('comment-draft-v2:user:a:reply:post-a:comment-b')).toBe(
      'viewer A, post A, Bob'
    )
    expect(localStorage.getItem('comment-draft-v2:user:a:reply:post-b:comment-a')).toBe(
      'viewer A, post B, Alice'
    )
    expect(localStorage.getItem('comment-draft-v2:user:b:reply:post-a:comment-a')).toBe(
      'viewer B, post A, Alice'
    )
  })

  it('retains failed drafts and ignores IME composition and Shift+Enter', async () => {
    const onSubmitReply = jest.fn().mockResolvedValue(false)
    render(<CommentThread {...threadProps({ onSubmitReply })} />)
    const textarea = screen.getByRole('textbox', { name: 'reply @alice' })
    fireEvent.change(textarea, { target: { value: '候选回复' } })

    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', isComposing: true })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', shiftKey: true })
    expect(onSubmitReply).not.toHaveBeenCalled()

    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    await waitFor(() =>
      expect(onSubmitReply).toHaveBeenCalledWith('post-a', 'comment-a', '候选回复')
    )
    expect(textarea).toHaveValue('候选回复')
  })
})
