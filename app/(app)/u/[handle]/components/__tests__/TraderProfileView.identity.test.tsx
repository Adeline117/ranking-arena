import { render } from '@testing-library/react'
import type { ServerProfile, TraderPageData } from '../types'

const mockTraderHeader = jest.fn(() => null)
const mockLinkedAccountStatus = jest.fn(() => null)
const mockLinkedAccountTabs = jest.fn(() => null)
const mockAggregatedStats = jest.fn(() => null)
const mockExchangeLinksBar = jest.fn(() => null)
const mockUseLinkedAccounts = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}))

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: (loader: () => unknown) => {
    const moduleLoader = loader.toString()
    if (moduleLoader.includes('LinkedAccountTabs')) {
      return (props: unknown) => mockLinkedAccountTabs(props)
    }
    if (moduleLoader.includes('AggregatedStats')) {
      return (props: unknown) => mockAggregatedStats(props)
    }
    if (moduleLoader.includes('ExchangeLinksBar')) {
      return (props: unknown) => mockExchangeLinksBar(props)
    }
    return () => null
  },
}))

jest.mock('@/app/components/trader/TraderHeader', () => ({
  __esModule: true,
  default: (props: unknown) => mockTraderHeader(props),
}))

jest.mock('@/app/components/trader/LinkedAccountStatus', () => ({
  __esModule: true,
  default: (props: unknown) => mockLinkedAccountStatus(props),
}))

jest.mock('@/app/components/trader/LinkedAccountTabs', () => ({
  __esModule: true,
  default: (props: unknown) => mockLinkedAccountTabs(props),
}))

jest.mock('@/app/components/trader/AggregatedStats', () => ({
  __esModule: true,
  default: (props: unknown) => mockAggregatedStats(props),
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
  useLinkedAccounts: (...args: unknown[]) => mockUseLinkedAccounts(...args),
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
    mockUseLinkedAccounts.mockReturnValue({
      linkedAccounts: [],
      aggregatedData: null,
      hasMultipleAccounts: false,
      isLoading: false,
      authoritativeReady: true,
      error: null,
    })
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
    expect(mockUseLinkedAccounts).toHaveBeenCalledWith('binance', 'exchange-account-id')
  })

  it('uses the bridge profile id when trader_key is absent from the fixed payload', () => {
    mockUseLinkedAccounts.mockReturnValue({
      linkedAccounts: [],
      aggregatedData: null,
      hasMultipleAccounts: false,
      isLoading: true,
      authoritativeReady: false,
      error: null,
    })
    const traderData: TraderPageData = {
      profile: {
        id: 'bridge-profile-id',
        handle: 'exchange-handle',
        source: 'okx',
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

    expect(mockUseLinkedAccounts).toHaveBeenCalledWith('okx', 'bridge-profile-id')
    expect(mockLinkedAccountStatus).toHaveBeenCalledWith({ isLoading: true, error: null })
  })

  it('keeps a proven multi-account membership as metadata instead of faking a switch or aggregate', () => {
    mockUseLinkedAccounts.mockReturnValue({
      linkedAccounts: [
        {
          id: 'binance:primary-account',
          platform: 'binance',
          traderKey: 'primary-account',
          handle: 'primary-handle',
          label: null,
          isPrimary: true,
          roi: 12.5,
          pnl: null,
          arenaScore: null,
          winRate: 55,
          maxDrawdown: 8,
          rank: null,
        },
        {
          id: 'okx:linked-account',
          platform: 'okx',
          traderKey: 'linked-account',
          handle: 'linked-handle',
          label: null,
          isPrimary: false,
          roi: 9,
          pnl: null,
          arenaScore: null,
          winRate: 51,
          maxDrawdown: 11,
          rank: null,
        },
      ],
      aggregatedData: { combinedPnl: null, bestRoi: null, weightedScore: null },
      hasMultipleAccounts: true,
      isLoading: false,
      authoritativeReady: true,
      error: null,
    })

    const traderData: TraderPageData = {
      profile: {
        id: 'primary-account',
        trader_key: 'primary-account',
        handle: 'primary-handle',
        source: 'binance',
        isRegistered: false,
      },
      performance: {
        roi_90d: 12.5,
        arena_score_90d: 84,
      } as TraderPageData['performance'],
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

    expect(mockLinkedAccountTabs).not.toHaveBeenCalled()
    expect(mockAggregatedStats).not.toHaveBeenCalled()
    expect(mockLinkedAccountStatus).toHaveBeenCalledWith({ isLoading: false, error: null })
    expect(mockTraderHeader).toHaveBeenCalledWith(
      expect.objectContaining({
        handle: 'primary-handle',
        traderId: 'primary-account',
        source: 'binance',
        roi90d: 12.5,
        arenaScore: 84,
        linkedAccountCount: 2,
        linkedPlatforms: ['binance', 'okx'],
      })
    )
    expect(mockExchangeLinksBar).toHaveBeenCalledWith({
      primary: {
        platform: 'binance',
        traderKey: 'primary-account',
        handle: 'primary-handle',
      },
      linkedAccounts: [
        {
          platform: 'binance',
          traderKey: 'primary-account',
          handle: 'primary-handle',
        },
        {
          platform: 'okx',
          traderKey: 'linked-account',
          handle: 'linked-handle',
        },
      ],
      isOwnProfile: false,
    })
  })

  it('shows an unavailable membership state without publishing stale linked metadata', () => {
    const membershipError = new Error('membership unavailable')
    mockUseLinkedAccounts.mockReturnValue({
      linkedAccounts: [
        {
          id: 'binance:primary-account',
          platform: 'binance',
          traderKey: 'primary-account',
          handle: 'primary-handle',
          label: null,
          isPrimary: true,
          roi: 12.5,
          pnl: null,
          arenaScore: null,
          winRate: 55,
          maxDrawdown: 8,
          rank: null,
        },
      ],
      aggregatedData: null,
      hasMultipleAccounts: false,
      isLoading: false,
      authoritativeReady: false,
      error: membershipError,
    })

    const traderData: TraderPageData = {
      profile: {
        id: 'primary-account',
        trader_key: 'primary-account',
        handle: 'primary-handle',
        source: 'binance',
        isRegistered: false,
      },
      performance: {
        roi_90d: 12.5,
        arena_score_90d: 84,
      } as TraderPageData['performance'],
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

    expect(mockLinkedAccountStatus).toHaveBeenCalledWith({
      isLoading: false,
      error: membershipError,
    })
    expect(mockTraderHeader).toHaveBeenCalledWith(
      expect.objectContaining({
        traderId: 'primary-account',
        roi90d: 12.5,
        arenaScore: 84,
        linkedAccountCount: undefined,
        linkedPlatforms: undefined,
      })
    )
  })
})
