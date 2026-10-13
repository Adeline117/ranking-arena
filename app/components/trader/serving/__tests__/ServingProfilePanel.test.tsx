import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import ServingProfilePanel from '../ServingProfilePanel'
import ServingRecordsSection from '../ServingRecordsSection'
import { quarantinedPublicCoreModules } from '@/lib/data/serving/core-quarantine'
import type {
  SourceCapability,
  TraderCoreModules,
  TraderFirstScreen,
} from '@/lib/data/serving/types'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))
// The panel must never request /core while the public core projection is
// quarantined. Fail loudly if anything reaches the hook.
jest.mock('@/lib/hooks/useTraderCore', () => ({
  useTraderCore: jest.fn(() => {
    throw new Error('useTraderCore must not be called while /core is quarantined')
  }),
}))
// Defaults to the real static projection; GMX disclosure tests override it to
// exercise the published-core branch kept for when the chain is restored.
jest.mock('@/lib/data/serving/core-quarantine', () => {
  const actual = jest.requireActual('@/lib/data/serving/core-quarantine')
  return {
    quarantinedPublicCoreModules: jest.fn(actual.quarantinedPublicCoreModules),
  }
})
jest.mock('@/lib/hooks/useBotHeader', () => ({ useBotHeader: () => ({ bot: null }) }))
jest.mock('@/app/components/trader/performance/PeriodSelector', () => ({
  PeriodSelector: ({
    period,
    inceptionSelected,
    onPeriodChange,
    onInceptionSelect,
  }: {
    period: '7D' | '30D' | '90D'
    inceptionSelected?: boolean
    onPeriodChange: (period: '7D' | '30D' | '90D') => void
    onInceptionSelect?: () => void
  }) => (
    <div data-testid="period-selector" data-period={period} data-inception={inceptionSelected}>
      <button onClick={() => onPeriodChange('7D')}>select-7D</button>
      <button onClick={() => onPeriodChange('30D')}>select-30D</button>
      <button onClick={() => onPeriodChange('90D')}>select-90D</button>
      <button onClick={onInceptionSelect}>select-inception</button>
    </div>
  ),
}))
jest.mock('../SignalChips', () => () => null)
jest.mock('../TraderMetaStrip', () => () => null)
jest.mock('../CopyTradingCard', () => () => null)
jest.mock('../OnchainInsights', () => () => null)
jest.mock('../CoreCharts', () => () => null)
jest.mock('../DrawdownModule', () => () => null)
jest.mock('../AssetPreference', () => () => null)
jest.mock('../HoldingDistribution', () => () => null)
jest.mock('../AbilityRadar', () => () => null)
jest.mock('../ServingRecordsSection', () => jest.fn(() => <div data-testid="records-section" />))
jest.mock('../BotHeaderCard', () => () => null)
jest.mock('@/app/components/common/ProvenanceFooter', () => () => null)
jest.mock('@/app/components/ranking/AntiGamingBadge', () => () => null)

const WINDOW_TO = Date.UTC(2026, 6, 15) / 1000

const firstScreen: TraderFirstScreen = {
  source: 'gmx',
  exchangeTraderId: '0x123',
  nickname: null,
  avatarMirrorUrl: null,
  avatarOriginUrl: null,
  avatarSrc: null,
  walletAddress: '0x123',
  traderKind: 'human',
  botStrategy: null,
  entries: [],
}

const capability: SourceCapability = {
  timeframes: { '7': 'native', '30': 'native', '90': 'native' },
  inceptionTf: false,
  metrics: ['pnl', 'roi'],
  surfaces: {
    positions: false,
    position_history: false,
    orders: false,
    transfers: false,
    copiers: false,
  },
  copierDepth: 'none',
  currency: 'USD',
  isOnchain: true,
  derivedBoardNote: false,
  exchangeName: 'GMX',
}

function coreModules(extras: Record<string, unknown>): TraderCoreModules {
  return {
    timeframe: 90,
    stats: { pnl: 120, roi: 24 },
    currency: 'USD',
    series: {},
    extras,
    provenance: { source: 'gmx', asOf: '2026-07-15T01:00:00.000Z' },
    cacheState: 'warm',
  }
}

const actualQuarantine = jest.requireActual<typeof import('@/lib/data/serving/core-quarantine')>(
  '@/lib/data/serving/core-quarantine'
)
const quarantineMock = quarantinedPublicCoreModules as jest.Mock

function mockCore(extras: Record<string, unknown>) {
  quarantineMock.mockImplementation(() => coreModules(extras))
}

beforeEach(() => {
  jest.clearAllMocks()
  quarantineMock.mockImplementation(actualQuarantine.quarantinedPublicCoreModules)
  global.fetch = jest.fn(() => {
    throw new Error('ServingProfilePanel must not fetch core modules')
  }) as unknown as typeof fetch
})

describe('ServingProfilePanel quarantined core', () => {
  it('renders the under-verification notice from the static projection without a request', () => {
    render(<ServingProfilePanel firstScreen={firstScreen} capability={capability} />)

    expect(screen.getByTestId('history-verification-notice')).toBeInTheDocument()
    expect(screen.getByText('historyVerificationTitle')).toBeInTheDocument()
    expect(screen.queryByText('metricPnl')).not.toBeInTheDocument()
    expect(quarantineMock).toHaveBeenLastCalledWith(90)
    expect(global.fetch).not.toHaveBeenCalled()
    expect(screen.getByTestId('records-section')).toBeInTheDocument()
  })

  it('shows only a sealed (verified) current ranking for the selected timeframe', () => {
    const withEntries: TraderFirstScreen = {
      ...firstScreen,
      entries: [
        {
          timeframe: 90,
          rank: 12,
          rankingVisibility: 'verified',
          rankingVisibilityReason: null,
          headlineRoi: 34.5,
          headlinePnl: null,
          headlineWinRate: null,
          extras: {},
          provenance: { source: 'gmx', asOf: '2026-07-15T01:00:00.000Z' },
        },
        {
          timeframe: 30,
          rank: 99,
          rankingVisibility: 'partial',
          rankingVisibilityReason: 'cohort_unsealed',
          headlineRoi: 10,
          headlinePnl: null,
          headlineWinRate: null,
          extras: {},
          provenance: { source: 'gmx', asOf: '2026-07-15T01:00:00.000Z' },
        },
      ],
    }

    render(<ServingProfilePanel firstScreen={withEntries} capability={capability} />)
    expect(screen.getByText('#12')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'select-30D' }))
    expect(screen.getByTestId('history-verification-notice')).toBeInTheDocument()
    expect(screen.queryByText('#99')).not.toBeInTheDocument()
    expect(screen.queryByText('#12')).not.toBeInTheDocument()
  })
})

describe('ServingProfilePanel GMX metric disclosure', () => {
  it('labels visible PnL and ROI only when the exact v2 contracts are present', () => {
    mockCore({
      pnl_basis: 'gmx_period_realized_net',
      roi_basis: 'max_capital_usd',
      pnl_includes_unrealized: false,
      pnl_components_complete: true,
      profile_series_contract: 'unavailable_same_basis',
      profile_window_metrics_complete: true,
      window_semantics: 'completed_utc_days',
      window_from: WINDOW_TO - 90 * 86_400,
      window_to: WINDOW_TO,
      window_duration_days: 90,
    })

    render(<ServingProfilePanel firstScreen={firstScreen} capability={capability} />)

    expect(screen.getByText('gmxRealizedNetPnlLabel')).toBeInTheDocument()
    expect(screen.getByText('gmxMaxCapitalRoiLabel')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'gmxRealizedNetPnlTooltip' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'gmxMaxCapitalRoiTooltip' })).toBeInTheDocument()
    expect(screen.getByRole('note', { name: 'gmxRealizedNetPnlSummary' })).toBeInTheDocument()
    expect(screen.queryByText('metricPnl')).not.toBeInTheDocument()
  })

  it('keeps generic copy and hides the notice for a legacy basis', () => {
    mockCore({ pnl_basis: 'gmx_total_mark_to_market' })

    render(<ServingProfilePanel firstScreen={firstScreen} capability={capability} />)

    expect(screen.getByText('metricPnl')).toBeInTheDocument()
    expect(screen.getByText('metricRoi')).toBeInTheDocument()
    expect(screen.queryByText('gmxRealizedNetPnlLabel')).not.toBeInTheDocument()
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
  })

  it('does not infer the ROI denominator from a valid PnL contract', () => {
    mockCore({
      pnl_basis: 'gmx_period_realized_net',
      pnl_includes_unrealized: false,
      pnl_components_complete: true,
      profile_series_contract: 'unavailable_same_basis',
      window_semantics: 'completed_utc_days',
      window_from: WINDOW_TO - 90 * 86_400,
      window_to: WINDOW_TO,
      window_duration_days: 90,
    })

    render(<ServingProfilePanel firstScreen={firstScreen} capability={capability} />)

    expect(screen.getByText('gmxRealizedNetPnlLabel')).toBeInTheDocument()
    expect(screen.getByText('metricRoi')).toBeInTheDocument()
    expect(screen.queryByText('gmxMaxCapitalRoiLabel')).not.toBeInTheDocument()
  })

  it('does not disclose PnL when the capability does not render that metric', () => {
    mockCore({
      pnl_basis: 'gmx_period_realized_net',
      pnl_includes_unrealized: false,
      pnl_components_complete: true,
      profile_series_contract: 'unavailable_same_basis',
      window_semantics: 'completed_utc_days',
      window_from: WINDOW_TO - 90 * 86_400,
      window_to: WINDOW_TO,
      window_duration_days: 90,
    })

    render(
      <ServingProfilePanel firstScreen={firstScreen} capability={{ ...capability, metrics: [] }} />
    )

    expect(screen.queryByText('metricPnl')).not.toBeInTheDocument()
    expect(screen.queryByText('gmxRealizedNetPnlLabel')).not.toBeInTheDocument()
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
  })
})

describe('ServingProfilePanel timeframe identity', () => {
  it('drops the previous subject period before querying a narrower linked account', () => {
    mockCore({})
    const view = render(<ServingProfilePanel firstScreen={firstScreen} capability={capability} />)

    fireEvent.click(screen.getByRole('button', { name: 'select-7D' }))
    expect(quarantineMock).toHaveBeenLastCalledWith(7)
    expect(ServingRecordsSection).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: 'gmx', exchangeTraderId: '0x123', tf: 7 }),
      undefined
    )
    ;(ServingRecordsSection as unknown as jest.Mock).mockClear()

    const linkedFirstScreen: TraderFirstScreen = {
      ...firstScreen,
      source: 'hyperliquid_perp',
      exchangeTraderId: 'linked-account',
    }
    const thirtyDayOnly: SourceCapability = {
      ...capability,
      timeframes: { '7': 'absent', '30': 'native', '90': 'absent' },
    }
    view.rerender(
      <ServingProfilePanel firstScreen={linkedFirstScreen} capability={thirtyDayOnly} />
    )

    expect(screen.getByTestId('period-selector')).toHaveAttribute('data-period', '30D')
    expect(quarantineMock).toHaveBeenLastCalledWith(30)
    expect(ServingRecordsSection).toHaveBeenLastCalledWith(
      expect.objectContaining({
        source: 'hyperliquid_perp',
        exchangeTraderId: 'linked-account',
        tf: 30,
      }),
      undefined
    )
    expect(ServingRecordsSection).not.toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'hyperliquid_perp',
        exchangeTraderId: 'linked-account',
        tf: 7,
      }),
      undefined
    )
  })

  it('drops a selected period when the current subject capability no longer supports it', () => {
    mockCore({})
    const view = render(<ServingProfilePanel firstScreen={firstScreen} capability={capability} />)

    fireEvent.click(screen.getByRole('button', { name: 'select-7D' }))
    expect(screen.getByTestId('period-selector')).toHaveAttribute('data-period', '7D')
    quarantineMock.mockClear()

    view.rerender(
      <ServingProfilePanel
        firstScreen={firstScreen}
        capability={{
          ...capability,
          timeframes: { '7': 'absent', '30': 'native', '90': 'absent' },
        }}
      />
    )

    expect(screen.getByTestId('period-selector')).toHaveAttribute('data-period', '30D')
    expect(quarantineMock).toHaveBeenCalledTimes(1)
    expect(quarantineMock).toHaveBeenLastCalledWith(30)
  })

  it('disables core and record requests when every timeframe is explicitly absent', () => {
    mockCore({})
    const noTimeframes: SourceCapability = {
      ...capability,
      timeframes: { '7': 'absent', '30': 'absent', '90': 'absent' },
    }

    render(<ServingProfilePanel firstScreen={firstScreen} capability={noTimeframes} />)

    expect(quarantineMock).not.toHaveBeenCalled()
    expect(screen.getByText('tfNotProvided')).toBeInTheDocument()
    expect(screen.queryByTestId('history-verification-notice')).not.toBeInTheDocument()
    expect(ServingRecordsSection).not.toHaveBeenCalled()
  })
})
