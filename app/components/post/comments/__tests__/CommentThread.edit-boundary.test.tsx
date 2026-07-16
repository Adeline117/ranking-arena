import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
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

const t = (key: string) => key

function comment(id: string, content: string): Comment {
  return {
    id,
    user_id: 'viewer',
    content,
    created_at: '2026-07-16T00:00:00.000Z',
    author_handle: `author-${id}`,
    like_count: 0,
    dislike_count: 0,
    replies: [],
  }
}

const commentA = comment('comment-a', 'canonical A')
const commentB = comment('comment-b', 'canonical B')

type EditTarget = { id: string; content: string }

function threadProps({
  item = commentA,
  target = { id: item.id, content: item.content },
  postId = 'post-a',
  viewerKey = 'user:a',
  submittingEdit = false,
  onCancelEdit = jest.fn(),
  onSubmitEdit = jest.fn().mockResolvedValue(false),
}: {
  item?: Comment
  target?: EditTarget | null
  postId?: string
  viewerKey?: string
  submittingEdit?: boolean
  onCancelEdit?: (commentId?: string) => void
  onSubmitEdit?: jest.Mock<Promise<boolean>, [string, string, string]>
} = {}) {
  return {
    comment: item,
    postId,
    viewerKey,
    currentUserId: 'viewer',
    language: 'en',
    t,
    replyingTo: null,
    setReplyingTo: jest.fn(),
    submittingReply: false,
    onSubmitReply: jest.fn().mockResolvedValue(false),
    commentLikeLoading: {},
    onToggleCommentLike: jest.fn(),
    onToggleCommentDislike: jest.fn(),
    deletingCommentId: null,
    onDeleteComment: jest.fn(),
    editingComment: target,
    submittingEdit,
    onStartEdit: jest.fn(),
    onCancelEdit,
    onSubmitEdit,
    expandedReplies: {},
    setExpandedReplies: jest.fn(),
  }
}

describe('CommentThread edit draft boundary', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('keeps edit keystrokes out of the parent and sibling while preserving focus and caret', () => {
    let parentRenders = 0
    let siblingRenders = 0

    function Sibling() {
      siblingRenders += 1
      return <div data-testid="sibling" />
    }

    function Shell() {
      parentRenders += 1
      const [target, setTarget] = useState<EditTarget | null>({
        id: commentA.id,
        content: commentA.content,
      })
      const cancelTarget = (commentId?: string) =>
        setTarget((current) => (!commentId || current?.id === commentId ? null : current))
      return (
        <>
          <CommentThread {...threadProps({ target, onCancelEdit: cancelTarget })} />
          <Sibling />
        </>
      )
    }

    render(<Shell />)
    const textarea = screen.getByRole('textbox')
    const draft = 'local edit draft'
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

  it('submits the exact trimmed payload and closes only after an unchanged strict ACK', async () => {
    const onSubmitEdit = jest.fn().mockResolvedValue(true)

    function Shell() {
      const [target, setTarget] = useState<EditTarget | null>({
        id: commentA.id,
        content: commentA.content,
      })
      const cancelTarget = (commentId?: string) =>
        setTarget((current) => (!commentId || current?.id === commentId ? null : current))
      return (
        <CommentThread {...threadProps({ target, onCancelEdit: cancelTarget, onSubmitEdit })} />
      )
    }

    render(<Shell />)
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '  完整编辑 payload  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'save' }))

    await waitFor(() =>
      expect(onSubmitEdit).toHaveBeenCalledWith('post-a', 'comment-a', '完整编辑 payload')
    )
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument())
    expect(localStorage.getItem('comment-draft-v2:user:a:edit:post-a:comment-a')).toBeNull()
  })

  it('retains a failed edit without closing the composer', async () => {
    const onSubmitEdit = jest.fn().mockResolvedValue(false)
    render(<CommentThread {...threadProps({ onSubmitEdit })} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'failed edit stays' } })
    fireEvent.click(screen.getByRole('button', { name: 'save' }))

    await waitFor(() => expect(onSubmitEdit).toHaveBeenCalledTimes(1))
    expect(textarea).toHaveValue('failed edit stays')
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('does not let a same-target late ACK erase newer text or move the caret', async () => {
    let resolveAcknowledgement!: (acknowledged: boolean) => void
    const acknowledgement = new Promise<boolean>((resolve) => {
      resolveAcknowledgement = resolve
    })
    const onSubmitEdit = jest.fn(() => acknowledgement)

    function Shell() {
      const [target, setTarget] = useState<EditTarget | null>({
        id: commentA.id,
        content: commentA.content,
      })
      const cancelTarget = (commentId?: string) =>
        setTarget((current) => (!commentId || current?.id === commentId ? null : current))
      return (
        <CommentThread {...threadProps({ target, onCancelEdit: cancelTarget, onSubmitEdit })} />
      )
    }

    render(<Shell />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'submitted edit' } })
    fireEvent.click(screen.getByRole('button', { name: 'save' }))

    textarea.focus()
    fireEvent.change(textarea, { target: { value: 'new edit while waiting' } })
    textarea.setSelectionRange(7, 7)

    await act(async () => {
      resolveAcknowledgement(true)
      await acknowledgement
    })

    expect(textarea).toHaveValue('new edit while waiting')
    expect(document.activeElement).toBe(textarea)
    expect(textarea.selectionStart).toBe(7)
    expect(textarea.selectionEnd).toBe(7)
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('does not let an old target ACK or cancel close the newer target', async () => {
    let resolveAcknowledgement!: (acknowledged: boolean) => void
    const acknowledgement = new Promise<boolean>((resolve) => {
      resolveAcknowledgement = resolve
    })
    const onSubmitEdit = jest.fn(() => acknowledgement)

    function Shell() {
      const [target, setTarget] = useState<EditTarget | null>({
        id: commentA.id,
        content: commentA.content,
      })
      const cancelTarget = (commentId?: string) =>
        setTarget((current) => (!commentId || current?.id === commentId ? null : current))
      return (
        <>
          <button onClick={() => setTarget({ id: commentB.id, content: commentB.content })}>
            switch target
          </button>
          <button onClick={() => cancelTarget(commentA.id)}>cancel old target</button>
          <CommentThread
            {...threadProps({
              item: commentA,
              target,
              onCancelEdit: cancelTarget,
              onSubmitEdit,
            })}
          />
          <CommentThread
            {...threadProps({
              item: commentB,
              target,
              onCancelEdit: cancelTarget,
              onSubmitEdit,
            })}
          />
        </>
      )
    }

    render(<Shell />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'submitted A' } })
    fireEvent.click(screen.getByRole('button', { name: 'save' }))
    fireEvent.click(screen.getByRole('button', { name: 'switch target' }))

    const targetBTextarea = screen.getByRole('textbox')
    fireEvent.change(targetBTextarea, { target: { value: 'new B draft' } })
    targetBTextarea.focus()
    targetBTextarea.setSelectionRange(5, 5)
    fireEvent.click(screen.getByRole('button', { name: 'cancel old target' }))

    await act(async () => {
      resolveAcknowledgement(true)
      await acknowledgement
    })

    expect(targetBTextarea).toHaveValue('new B draft')
    expect(document.activeElement).toBe(targetBTextarea)
    expect(targetBTextarea.selectionStart).toBe(5)
    expect(targetBTextarea.selectionEnd).toBe(5)
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('isolates retained drafts by viewer, post, and edit target', async () => {
    const view = render(<CommentThread {...threadProps()} />)
    let textarea = screen.getByRole('textbox')
    expect(textarea).toHaveValue('canonical A')
    fireEvent.change(textarea, { target: { value: 'viewer A, post A, target A' } })

    view.rerender(<CommentThread {...threadProps({ item: commentB })} />)
    textarea = screen.getByRole('textbox')
    await waitFor(() => expect(textarea).toHaveValue('canonical B'))
    fireEvent.change(textarea, { target: { value: 'viewer A, post A, target B' } })

    view.rerender(<CommentThread {...threadProps()} />)
    textarea = screen.getByRole('textbox')
    await waitFor(() => expect(textarea).toHaveValue('viewer A, post A, target A'))

    view.rerender(<CommentThread {...threadProps({ postId: 'post-b' })} />)
    textarea = screen.getByRole('textbox')
    await waitFor(() => expect(textarea).toHaveValue('canonical A'))
    fireEvent.change(textarea, { target: { value: 'viewer A, post B, target A' } })

    view.rerender(<CommentThread {...threadProps({ viewerKey: 'user:b' })} />)
    textarea = screen.getByRole('textbox')
    await waitFor(() => expect(textarea).toHaveValue('canonical A'))
    fireEvent.change(textarea, { target: { value: 'viewer B, post A, target A' } })

    view.rerender(<CommentThread {...threadProps()} />)
    textarea = screen.getByRole('textbox')
    await waitFor(() => expect(textarea).toHaveValue('viewer A, post A, target A'))

    expect(localStorage.getItem('comment-draft-v2:user:a:edit:post-a:comment-b')).toBe(
      'viewer A, post A, target B'
    )
    expect(localStorage.getItem('comment-draft-v2:user:a:edit:post-b:comment-a')).toBe(
      'viewer A, post B, target A'
    )
    expect(localStorage.getItem('comment-draft-v2:user:b:edit:post-a:comment-a')).toBe(
      'viewer B, post A, target A'
    )
  })

  it('discards canceled drafts and reopens with canonical content', async () => {
    function Shell() {
      const [target, setTarget] = useState<EditTarget | null>({
        id: commentA.id,
        content: commentA.content,
      })
      const cancelTarget = (commentId?: string) =>
        setTarget((current) => (!commentId || current?.id === commentId ? null : current))
      return (
        <>
          <button onClick={() => setTarget({ id: commentA.id, content: commentA.content })}>
            reopen edit
          </button>
          <CommentThread {...threadProps({ target, onCancelEdit: cancelTarget })} />
        </>
      )
    }

    render(<Shell />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'discard me' } })
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(localStorage.getItem('comment-draft-v2:user:a:edit:post-a:comment-a')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'reopen edit' }))
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('canonical A'))
  })

  it('ignores IME Enter/Escape and Shift+Enter while preserving ordinary Escape', async () => {
    const onSubmitEdit = jest.fn().mockResolvedValue(false)
    const onCancelEdit = jest.fn()
    render(<CommentThread {...threadProps({ onCancelEdit, onSubmitEdit })} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '候选编辑' } })

    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', isComposing: true })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', shiftKey: true })
    fireEvent.keyDown(textarea, { key: 'Escape', code: 'Escape', isComposing: true })
    expect(onSubmitEdit).not.toHaveBeenCalled()
    expect(onCancelEdit).not.toHaveBeenCalled()

    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })
    await waitFor(() =>
      expect(onSubmitEdit).toHaveBeenCalledWith('post-a', 'comment-a', '候选编辑')
    )
    expect(textarea).toHaveValue('候选编辑')

    fireEvent.keyDown(textarea, { key: 'Escape', code: 'Escape' })
    expect(onCancelEdit).toHaveBeenCalledWith('comment-a')
    expect(localStorage.getItem('comment-draft-v2:user:a:edit:post-a:comment-a')).toBeNull()
  })
})
