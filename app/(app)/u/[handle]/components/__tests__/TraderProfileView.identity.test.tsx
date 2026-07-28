import { render } from '@testing-library/react'
import type { ServerProfile, TraderPageData } from '../types'

const mockTraderHeader = jest.fn(() => null)

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

jest.mock('@/app/components/trader/TraderTabs', () => () => null)
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
        onTabChange={jest.fn()}
        traderData={traderData}
      />
    )

    expect(mockTraderHeader).toHaveBeenCalledWith(
      expect.objectContaining({
        traderId: 'exchange-account-id',
        registeredUserId: USER_ID,
        isRegistered: true,
      })
    )
  })
})
