import { fireEvent, render, screen } from '@testing-library/react'
import ModuleDegraded from '../ModuleDegraded'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

describe('ModuleDegraded', () => {
  it('distinguishes an unavailable module from an in-flight load', () => {
    render(<ModuleDegraded />)

    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveAttribute('aria-atomic', 'true')
    expect(status).toHaveTextContent('moduleDataUnavailable')
    expect(status).not.toHaveTextContent('moduleDataPending')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('offers an explicit non-submit retry action when recovery is available', () => {
    const onRetry = jest.fn()
    render(<ModuleDegraded onRetry={onRetry} />)

    const retry = screen.getByRole('button', { name: 'moduleRetry' })
    expect(retry).toHaveAttribute('type', 'button')
    fireEvent.click(retry)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})
