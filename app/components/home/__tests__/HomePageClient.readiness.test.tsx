import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import HomePageClient from '../HomePageClient'

const mockUseTraderData = jest.fn()

jest.mock('../hooks', () => ({
  useTraderData: (...args: unknown[]) => mockUseTraderData(...args),
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => ({ isLoggedIn: false }),
}))

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn() }),
}))

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}))

jest.mock('../../Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/lib/design-tokens', () => ({
  tokens: {
    spacing: { 3: '12px', 4: '16px' },
    radius: { lg: '12px' },
    colors: {
      border: { primary: '#222' },
      bg: { secondary: '#111' },
      text: { secondary: '#aaa' },
    },
    typography: { fontSize: { sm: '14px' } },
    transition: { base: '150ms' },
  },
}))

jest.mock('@/lib/analytics/track', () => ({ trackEvent: jest.fn() }))

jest.mock('../RankingSection', () => ({
  __esModule: true,
  default: () => <div data-testid="interactive-ranking">Interactive rankings</div>,
}))

jest.mock('../../ui/PullToRefresh', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => children,
}))

function traderData(loading: boolean) {
  return {
    traders: [],
    loading,
    error: null,
    activeTimeRange: '90D',
    changeTimeRange: jest.fn(),
    lastUpdated: null,
    availableSources: [],
    refresh: jest.fn(),
    deferredFetchFailed: false,
    retryDeferredFetch: jest.fn(),
    isChangingTimeRange: false,
    totalCount: 0,
    categoryCounts: {},
    fetchPage: jest.fn(),
    lastRefreshFailed: false,
    staleDataWarning: null,
    isStale: false,
  }
}

describe('HomePageClient first-paint handoff', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    document.body.innerHTML = '<div id="ssr-home-content-shell">Server rankings</div>'
  })

  it('keeps the server shell until client ranking state resolves, then swaps atomically', () => {
    mockUseTraderData.mockReturnValue(traderData(true))
    const interactiveRoot = document.createElement('div')
    interactiveRoot.id = 'homepage-interactive'
    document.body.append(interactiveRoot)

    const view = render(<HomePageClient />, { container: interactiveRoot })
    const serverShell = document.getElementById('ssr-home-content-shell')

    expect(interactiveRoot).not.toHaveAttribute('data-home-ready')
    expect(serverShell).not.toHaveStyle({ display: 'none' })

    mockUseTraderData.mockReturnValue(traderData(false))
    view.rerender(<HomePageClient />)

    expect(interactiveRoot).toHaveAttribute('data-home-ready', 'true')
    expect(serverShell).toHaveStyle({ display: 'none' })
  })
})
