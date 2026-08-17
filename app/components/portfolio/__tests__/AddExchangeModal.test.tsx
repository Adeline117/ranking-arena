import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

import AddExchangeModal from '../AddExchangeModal'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('AddExchangeModal submission ownership', () => {
  it('single-flights the credential write and cannot be dismissed while its result is pending', async () => {
    const submission = deferred<void>()
    const onSubmit = jest.fn(() => submission.promise)
    const onClose = jest.fn()
    const view = render(<AddExchangeModal open onClose={onClose} onSubmit={onSubmit} />)

    fireEvent.change(screen.getByLabelText(/apiKey/), { target: { value: 'read-only-key' } })
    fireEvent.change(screen.getByLabelText(/apiSecret/), { target: { value: 'secret' } })
    const form = view.container.querySelector('form')
    if (!form) throw new Error('exchange form is missing')

    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith({
      exchange: 'binance',
      api_key: 'read-only-key',
      api_secret: 'secret',
      api_passphrase: undefined,
      label: 'binance',
    })
    expect(screen.getByRole('button', { name: 'close' })).toBeDisabled()
    expect(screen.getByLabelText(/apiKey/)).toBeDisabled()
    expect(screen.getByLabelText(/apiSecret/)).toBeDisabled()

    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('dialog', { name: 'connectExchange' }))
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => submission.resolve())
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('releases the lock after a failed write and preserves the entered credentials for retry', async () => {
    const onSubmit = jest.fn().mockRejectedValue(new Error('exchange rejected credentials'))
    render(<AddExchangeModal open onClose={jest.fn()} onSubmit={onSubmit} />)
    const apiKey = screen.getByLabelText(/apiKey/)
    const apiSecret = screen.getByLabelText(/apiSecret/)
    fireEvent.change(apiKey, { target: { value: 'retry-key' } })
    fireEvent.change(apiSecret, { target: { value: 'retry-secret' } })

    fireEvent.click(screen.getByRole('button', { name: 'connect' }))

    expect(await screen.findByText('exchange rejected credentials')).toBeInTheDocument()
    expect(apiKey).toHaveValue('retry-key')
    expect(apiSecret).toHaveValue('retry-secret')
    expect(screen.getByRole('button', { name: 'connect' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'connect' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))
  })
})
