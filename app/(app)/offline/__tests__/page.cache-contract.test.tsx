import { render, screen } from '@testing-library/react'
import OfflinePage from '../page'

const openCache = jest.fn()

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      (
        ({
          youAreOffline: 'You Are Offline',
          checkNetworkAndRetryOffline: 'Check your network connection, then try again.',
          retryConnection: 'Retry Connection',
          arenaTagline: 'Arena',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

describe('offline fallback cache contract', () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: { open: openCache },
    })
  })

  afterAll(() => {
    Reflect.deleteProperty(globalThis, 'caches')
  })

  it('renders an honest fallback without reading a retired leaderboard cache', () => {
    render(<OfflinePage />)

    expect(screen.getByRole('heading', { name: 'You Are Offline' })).toBeInTheDocument()
    expect(screen.getByText('Check your network connection, then try again.')).toBeInTheDocument()
    expect(screen.queryByText(/cached leaderboard/i)).not.toBeInTheDocument()
    expect(openCache).not.toHaveBeenCalled()
  })

  it('uses a native retry form that remains usable without hydration', () => {
    const { container } = render(<OfflinePage />)

    expect(screen.getByRole('button', { name: 'Retry Connection' })).toHaveAttribute(
      'type',
      'submit'
    )
    expect(container.querySelector('form')).toHaveAttribute('action', '')
    expect(container.querySelector('form')).toHaveAttribute('method', 'get')
  })
})
