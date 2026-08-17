import { fireEvent, render, screen } from '@testing-library/react'
import ServingCoreStatusNotice from '../ServingCoreStatusNotice'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

describe('ServingCoreStatusNotice', () => {
  const inactiveProps = {
    isPendingUpstream: false,
    isStale: false,
    isUnavailable: false,
    isRetrying: false,
    onRetry: jest.fn(),
  }

  it('does not add a disclosure shell while every core window is healthy', () => {
    const { container } = render(<ServingCoreStatusNotice {...inactiveProps} />)

    expect(container).toBeEmptyDOMElement()
  })

  it('shows collecting and retained-data refresh failure together, retrying once', () => {
    const onRetry = jest.fn().mockResolvedValue(undefined)
    render(
      <ServingCoreStatusNotice {...inactiveProps} isPendingUpstream isStale onRetry={onRetry} />
    )

    expect(screen.getByRole('status', { name: 'moduleDataPending' })).toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'moduleRefreshFailed' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'moduleRetry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('uses the full unavailable state when no core module is truthful', () => {
    const onRetry = jest.fn()
    render(
      <ServingCoreStatusNotice {...inactiveProps} isUnavailable isRetrying onRetry={onRetry} />
    )

    expect(screen.getByRole('status', { name: 'moduleDataUnavailable' })).toBeInTheDocument()
    const retry = screen.getByRole('button', { name: 'loading' })
    expect(retry).toBeDisabled()
    fireEvent.click(retry)
    expect(onRetry).not.toHaveBeenCalled()
  })
})
