import { fireEvent, render, screen } from '@testing-library/react'
import WrappedUnavailableState from '../WrappedUnavailableState'

const mockRefresh = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    refresh: mockRefresh,
  }),
}))

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        serviceTemporarilyUnavailable: 'Service temporarily unavailable',
        requestTimeoutRetry: 'Request timed out, please try again later',
        serverUnavailable: 'Server temporarily unavailable, please try again later',
        retryButton: 'Retry',
        rankings: 'Rankings',
      }
      return translations[key] ?? key
    },
  }),
}))

describe('WrappedUnavailableState', () => {
  beforeEach(() => {
    mockRefresh.mockClear()
  })

  it('explains a timeout and retries the current route without navigating away', () => {
    render(<WrappedUnavailableState handle="slow-trader" reason="timeout" />)

    expect(screen.getByRole('status')).toHaveTextContent('Service temporarily unavailable')
    expect(screen.getByRole('status')).toHaveTextContent(
      'Request timed out, please try again later'
    )
    expect(screen.getByText('@slow-trader')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(mockRefresh).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('link', { name: 'Rankings' })).toHaveAttribute('href', '/rankings')
  })

  it('uses the server-unavailable explanation for non-timeout failures', () => {
    render(<WrappedUnavailableState handle="db-error-trader" reason="error" />)

    expect(screen.getByRole('status')).toHaveTextContent(
      'Server temporarily unavailable, please try again later'
    )
  })
})
