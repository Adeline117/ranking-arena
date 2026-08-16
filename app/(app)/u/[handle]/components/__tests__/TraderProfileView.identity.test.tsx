import { fireEvent, render, screen } from '@testing-library/react'
import type { ServerProfile, TraderPageData } from '../types'

const mockTraderHeader = jest.fn(() => null)
const mockTraderTabs = jest.fn(({ onTabChange }: { onTabChange: (tab: 'posts') => void }) => (
  <button type="button" onClick={() => onTabChange('posts')}>
    posts tab
  </button>
))

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}))

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: () => () => null,
}))

jest.mock('@/app/components/trader/TraderHeader', () => ({
  __esModule: true,
  default: (props: unknown) => mockTraderHeader(props),
}))

jest.mock('@/app/components/trader/TraderTabs', () => ({
  __esModule: true,
  default: (props: unknown) => mockTraderTabs(props as { onTabChange: (tab: 'posts') => void }),
}))
jest.mock('@/app/components/ui/Breadcrumb', () => () => null)
jest.mock('@/app/components/trader/OverviewPerformanceCard', () => () => null)

jest.mock('@/app/components/base', () => ({
  Box: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/lib/hooks/useLinkedAccounts', () => ({
  useLinkedAccounts: () => ({
    linkedAccounts: [],
    aggregatedData: null,
    hasMultipleAccounts: false,
    isLoading: false,
  }),
}))

jest.mock('@/lib/analytics/track', () => ({ trackEvent: jest.fn() }))

import TraderProfileView from '../TraderProfileView'

const USER_ID = '11111111-1111-4111-8111-111111111111'

const profile: ServerProfile = {
  id: USER_ID,
  handle: 'arena-user',
  followers: 3,
  following: 4,
  followingTraders: 5,
  isRegistered: true,
  proBadgeTier: null,
}

describe('TraderProfileView identity wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('keeps the authoritative user identity separate from the bridge trader identity', () => {
    const traderData: TraderPageData = {
      profile: {
        id: 'exchange-account-id',
        trader_key: 'exchange-account-id',
        handle: 'exchange-handle',
        source: 'binance',
        isRegistered: false,
      },
    }

    render(
      <TraderProfileView
        email="viewer@example.com"
        handle={profile.handle}
        profile={profile}
        serverProfile={profile}
        currentUserId={null}
        isPro={false}
        activeTab="overview"
        availableTabs={['overview', 'stats', 'portfolio', 'posts']}
        onTabChange={jest.fn()}
        traderData={traderData}
      />
    )

    expect(mockTraderHeader).toHaveBeenCalledWith(
      expect.objectContaining({
        traderId: 'exchange-account-id',
        registeredUserId: USER_ID,
        isRegistered: true,
        loginReturnPath: '/u/arena-user',
      })
    )
  })

  it('shares the canonical posts key across the tab, panel ARIA, and click callback', () => {
    const onTabChange = jest.fn()
    const traderData: TraderPageData = {
      profile: {
        id: 'exchange-account-id',
        trader_key: 'exchange-account-id',
        handle: 'exchange-handle',
        source: 'binance',
        isRegistered: false,
      },
    }

    render(
      <TraderProfileView
        email="viewer@example.com"
        handle={profile.handle}
        profile={profile}
        serverProfile={profile}
        currentUserId={null}
        isPro={false}
        activeTab="posts"
        availableTabs={['overview', 'stats', 'portfolio', 'posts']}
        onTabChange={onTabChange}
        traderData={traderData}
      />
    )

    expect(mockTraderTabs).toHaveBeenCalledWith(
      expect.objectContaining({
        activeTab: 'posts',
        extraTabs: ['posts'],
      })
    )
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'panel-posts')
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'tab-posts')

    fireEvent.click(screen.getByRole('button', { name: 'posts tab' }))
    expect(onTabChange).toHaveBeenCalledWith('posts')
  })
})
