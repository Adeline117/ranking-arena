import { fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { useModalA11y } from '../useModalA11y'

jest.mock('../useScrollLock', () => ({
  useScrollLock: jest.fn(),
}))

function Harness({ onClose }: { onClose: () => void }) {
  const modalRef = useRef<HTMLDivElement>(null)
  useModalA11y({ open: true, onClose, modalRef })

  return (
    <div ref={modalRef}>
      <textarea aria-label="Draft" />
      <button type="button">Submit</button>
    </div>
  )
}

describe('useModalA11y', () => {
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
    document.body.innerHTML = ''
  })

  it('does not restore focus when an inline close callback changes', () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    const restoreFocusSpy = jest.spyOn(trigger, 'focus')
    const firstClose = jest.fn()
    const latestClose = jest.fn()

    const { rerender, unmount } = render(<Harness onClose={firstClose} />)
    const draft = screen.getByRole('textbox', { name: 'Draft' })
    expect(draft).toHaveFocus()

    // Controlled modal inputs recreate inline callbacks as their parent
    // renders. That must not restart focus capture/restore.
    rerender(<Harness onClose={latestClose} />)
    expect(draft).toHaveFocus()
    expect(restoreFocusSpy).not.toHaveBeenCalled()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(firstClose).not.toHaveBeenCalled()
    expect(latestClose).toHaveBeenCalledTimes(1)

    unmount()
    expect(restoreFocusSpy).toHaveBeenCalledTimes(1)
  })
})
