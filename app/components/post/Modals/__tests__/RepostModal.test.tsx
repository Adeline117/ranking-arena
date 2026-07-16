import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { RepostModal } from '../RepostModal'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/app/components/ui/Dynamic', () => ({
  DynamicStickerPicker: () => null,
}))

jest.mock('@/lib/hooks/useScrollLock', () => ({
  useScrollLock: jest.fn(),
}))

const t = (key: string) => key

describe('RepostModal draft boundary', () => {
  let animationFrameSpy: jest.SpyInstance
  let cancelAnimationFrameSpy: jest.SpyInstance

  beforeEach(() => {
    animationFrameSpy = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0)
        return 1
      })
    cancelAnimationFrameSpy = jest.spyOn(window, 'cancelAnimationFrame').mockImplementation()
  })

  afterEach(() => {
    animationFrameSpy.mockRestore()
    cancelAnimationFrameSpy.mockRestore()
  })

  it('keeps typing local while preserving focus and the caret', () => {
    let shellRenders = 0
    const onRepost = jest.fn().mockResolvedValue(false)

    function Shell() {
      shellRenders += 1
      return (
        <RepostModal
          postId="post-1"
          onRepost={onRepost}
          onCancel={jest.fn()}
          loading={false}
          t={t}
        />
      )
    }

    render(<Shell />)
    const textarea = screen.getByRole('textbox', { name: 'addCommentOptional' })
    const draft = 'high-conviction repost'

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

    expect(shellRenders).toBe(1)
    expect(textarea).toHaveFocus()
    expect(textarea).toHaveValue(`${draft.slice(0, 4)}X${draft.slice(4)}`)
    expect(textarea.selectionStart).toBe(5)
    expect(textarea.selectionEnd).toBe(5)
  })

  it('does not restore focus when an inline cancel callback changes', () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    const restoreFocusSpy = jest.spyOn(trigger, 'focus')
    const onCancel = jest.fn()
    const onRepost = jest.fn().mockResolvedValue(false)

    function Shell({ revision }: { revision: number }) {
      return (
        <RepostModal
          postId="post-1"
          onRepost={onRepost}
          onCancel={() => onCancel(revision)}
          loading={false}
          t={t}
        />
      )
    }

    const view = render(<Shell revision={1} />)
    const textarea = screen.getByRole('textbox', { name: 'addCommentOptional' })
    fireEvent.change(textarea, { target: { value: 'draft stays focused' } })
    textarea.setSelectionRange(6, 6)

    view.rerender(<Shell revision={2} />)

    expect(textarea).toHaveFocus()
    expect(textarea.selectionStart).toBe(6)
    expect(textarea.selectionEnd).toBe(6)
    expect(restoreFocusSpy).not.toHaveBeenCalled()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledWith(2)

    view.unmount()
    trigger.remove()
  })

  it('clears the local draft after cancel and remount', () => {
    function Shell() {
      const [open, setOpen] = useState(true)
      return open ? (
        <RepostModal
          postId="post-1"
          onRepost={jest.fn().mockResolvedValue(false)}
          onCancel={() => setOpen(false)}
          loading={false}
          t={t}
        />
      ) : (
        <button type="button" onClick={() => setOpen(true)}>
          open
        </button>
      )
    }

    render(<Shell />)
    fireEvent.change(screen.getByRole('textbox', { name: 'addCommentOptional' }), {
      target: { value: 'discard me' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'open' }))

    expect(screen.getByRole('textbox', { name: 'addCommentOptional' })).toHaveValue('')
  })

  it('submits the complete local draft and closes only after success', async () => {
    const onRepost = jest.fn().mockResolvedValue(true)

    function Shell() {
      const [open, setOpen] = useState(true)
      return open ? (
        <RepostModal
          postId="post-1"
          onRepost={onRepost}
          onCancel={() => setOpen(false)}
          loading={false}
          t={t}
        />
      ) : (
        <button type="button" onClick={() => setOpen(true)}>
          open
        </button>
      )
    }

    render(<Shell />)
    const draft = '完整的本地转发草稿 with exact punctuation!'
    fireEvent.change(screen.getByRole('textbox', { name: 'addCommentOptional' }), {
      target: { value: draft },
    })
    fireEvent.click(screen.getByRole('button', { name: 'repost' }))

    await waitFor(() => expect(onRepost).toHaveBeenCalledWith('post-1', draft))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'open' }))
    expect(screen.getByRole('textbox', { name: 'addCommentOptional' })).toHaveValue('')
  })

  it('keeps the local draft when submission fails', async () => {
    const onRepost = jest.fn().mockResolvedValue(false)
    render(
      <RepostModal postId="post-1" onRepost={onRepost} onCancel={jest.fn()} loading={false} t={t} />
    )
    const textarea = screen.getByRole('textbox', { name: 'addCommentOptional' })
    fireEvent.change(textarea, { target: { value: 'retry this draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'repost' }))

    await waitFor(() => expect(onRepost).toHaveBeenCalledTimes(1))
    expect(textarea).toHaveValue('retry this draft')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
