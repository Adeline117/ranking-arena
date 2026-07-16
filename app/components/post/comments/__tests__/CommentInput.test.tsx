import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { CommentInput } from '../CommentInput'

jest.mock('next/image', () => ({
  __esModule: true,
  default: () => null,
}))

const t = (key: string) => key

function renderInput({
  postId = 'post-a',
  viewerKey = 'user:a',
  submittingComment = false,
  onSubmitComment = jest.fn().mockResolvedValue(false),
}: {
  postId?: string
  viewerKey?: string
  submittingComment?: boolean
  onSubmitComment?: jest.Mock<Promise<boolean>, [string, string]>
} = {}) {
  return render(
    <CommentInput
      postId={postId}
      viewerKey={viewerKey}
      submittingComment={submittingComment}
      onSubmitComment={onSubmitComment}
      language="en"
      t={t}
    />
  )
}

describe('CommentInput draft boundary', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('keeps character updates out of the parent and sibling while preserving focus and caret', () => {
    let parentRenders = 0
    let siblingRenders = 0

    function Sibling() {
      siblingRenders += 1
      return <div data-testid="sibling" />
    }

    function Shell() {
      parentRenders += 1
      return (
        <>
          <CommentInput
            postId="post-a"
            viewerKey="user:a"
            submittingComment={false}
            onSubmitComment={jest.fn().mockResolvedValue(false)}
            language="en"
            t={t}
          />
          <Sibling />
        </>
      )
    }

    render(<Shell />)
    const textarea = screen.getByRole('textbox', { name: 'writeComment' })
    const draft = 'local main comment draft'
    textarea.focus()

    for (let index = 1; index <= draft.length; index += 1) {
      fireEvent.change(textarea, { target: { value: draft.slice(0, index) } })
    }

    textarea.setSelectionRange(5, 5)
    fireEvent.change(textarea, {
      target: {
        value: `${draft.slice(0, 5)}X${draft.slice(5)}`,
        selectionStart: 6,
        selectionEnd: 6,
      },
    })

    expect(parentRenders).toBe(1)
    expect(siblingRenders).toBe(1)
    expect(document.activeElement).toBe(textarea)
    expect(textarea.selectionStart).toBe(6)
    expect(textarea.selectionEnd).toBe(6)
    expect(textarea).toHaveAttribute('maxlength', '2000')
    expect(screen.getByText(/\/2000$/)).toHaveTextContent(`${draft.length + 1}/2000`)
  })

  it('does not let a late successful ACK erase text typed during submission', async () => {
    let resolveAcknowledgement!: (acknowledged: boolean) => void
    const acknowledgement = new Promise<boolean>((resolve) => {
      resolveAcknowledgement = resolve
    })
    const submitted = jest.fn()

    function Shell() {
      const [submitting, setSubmitting] = useState(false)
      const handleSubmit = async (postId: string, content: string) => {
        submitted(postId, content)
        setSubmitting(true)
        const acknowledged = await acknowledgement
        setSubmitting(false)
        return acknowledged
      }

      return (
        <CommentInput
          postId="post-a"
          viewerKey="user:a"
          submittingComment={submitting}
          onSubmitComment={handleSubmit}
          language="en"
          t={t}
        />
      )
    }

    render(<Shell />)
    const textarea = screen.getByRole('textbox', { name: 'writeComment' })
    fireEvent.change(textarea, { target: { value: 'submitted text' } })
    fireEvent.click(screen.getByRole('button', { name: 'send' }))

    expect(submitted).toHaveBeenCalledWith('post-a', 'submitted text')
    await waitFor(() =>
      expect(screen.getByRole('status', { name: 'Loading' }).closest('button')).toBeDisabled()
    )

    textarea.focus()
    fireEvent.change(textarea, { target: { value: 'new text while waiting' } })
    textarea.setSelectionRange(8, 8)

    await act(async () => {
      resolveAcknowledgement(true)
      await acknowledgement
    })

    expect(textarea).toHaveValue('new text while waiting')
    expect(document.activeElement).toBe(textarea)
    expect(textarea.selectionStart).toBe(8)
    expect(textarea.selectionEnd).toBe(8)
  })

  it('clears an unchanged draft only after a successful ACK', async () => {
    const onSubmitComment = jest.fn().mockResolvedValue(true)
    renderInput({ onSubmitComment })
    const textarea = screen.getByRole('textbox', { name: 'writeComment' })
    const draft = '完整主评论 exact payload'

    fireEvent.change(textarea, { target: { value: draft } })
    fireEvent.click(screen.getByRole('button', { name: 'send' }))

    await waitFor(() => expect(onSubmitComment).toHaveBeenCalledWith('post-a', draft))
    await waitFor(() => expect(textarea).toHaveValue(''))
    expect(localStorage.getItem('comment-draft-v2:user:a:post-a')).toBeNull()
  })

  it('isolates persisted drafts by both viewer and post', async () => {
    const onSubmitComment = jest.fn().mockResolvedValue(false)
    const view = render(
      <CommentInput
        postId="post-a"
        viewerKey="user:a"
        submittingComment={false}
        onSubmitComment={onSubmitComment}
        language="en"
        t={t}
      />
    )
    const textarea = screen.getByRole('textbox', { name: 'writeComment' })
    fireEvent.change(textarea, { target: { value: 'viewer A, post A' } })

    view.rerender(
      <CommentInput
        postId="post-b"
        viewerKey="user:a"
        submittingComment={false}
        onSubmitComment={onSubmitComment}
        language="en"
        t={t}
      />
    )
    await waitFor(() => expect(textarea).toHaveValue(''))
    fireEvent.change(textarea, { target: { value: 'viewer A, post B' } })

    view.rerender(
      <CommentInput
        postId="post-a"
        viewerKey="user:a"
        submittingComment={false}
        onSubmitComment={onSubmitComment}
        language="en"
        t={t}
      />
    )
    await waitFor(() => expect(textarea).toHaveValue('viewer A, post A'))

    view.rerender(
      <CommentInput
        postId="post-a"
        viewerKey="user:b"
        submittingComment={false}
        onSubmitComment={onSubmitComment}
        language="en"
        t={t}
      />
    )
    await waitFor(() => expect(textarea).toHaveValue(''))
    fireEvent.change(textarea, { target: { value: 'viewer B, post A' } })

    view.rerender(
      <CommentInput
        postId="post-a"
        viewerKey="user:a"
        submittingComment={false}
        onSubmitComment={onSubmitComment}
        language="en"
        t={t}
      />
    )
    await waitFor(() => expect(textarea).toHaveValue('viewer A, post A'))

    expect(localStorage.getItem('comment-draft-v2:user:a:post-b')).toBe('viewer A, post B')
    expect(localStorage.getItem('comment-draft-v2:user:b:post-a')).toBe('viewer B, post A')
  })

  it('ignores composing and Shift+Enter key presses, then submits on plain Enter', async () => {
    const onSubmitComment = jest.fn().mockResolvedValue(false)
    renderInput({ onSubmitComment })
    const textarea = screen.getByRole('textbox', { name: 'writeComment' })
    fireEvent.change(textarea, { target: { value: '候选词' } })

    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', isComposing: true })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', shiftKey: true })
    expect(onSubmitComment).not.toHaveBeenCalled()
    expect(textarea).toHaveValue('候选词')

    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    await waitFor(() => expect(onSubmitComment).toHaveBeenCalledWith('post-a', '候选词'))
    expect(textarea).toHaveValue('候选词')
  })
})
