import { fireEvent, render, screen } from '@testing-library/react'
import { ToastProvider } from '../Toast'
import { useToast } from '@/lib/ui/toast-context'

function SharedToastConsumer() {
  const { showToast } = useToast()
  return (
    <button type="button" onClick={() => showToast('Shared context toast', 'success', 0)}>
      Show toast
    </button>
  )
}

describe('Toast shared context boundary', () => {
  it('connects the app provider to a lib hook consumer', () => {
    render(
      <ToastProvider>
        <SharedToastConsumer />
      </ToastProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Show toast' }))

    expect(screen.getByText('Shared context toast')).toBeInTheDocument()
  })
})
