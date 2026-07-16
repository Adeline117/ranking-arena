import React from 'react'
import { render, screen } from '@testing-library/react'
import ServingProfilePanel from '../ServingProfilePanel'
import { useTraderCore } from '@/lib/hooks/useTraderCore'
import type {
  SourceCapability,
  TraderCoreModules,
  TraderFirstScreen,
} from '@/lib/data/serving/types'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))
jest.mock('@/lib/hooks/useTraderCore', () => ({ useTraderCore: jest.fn() }))
jest.mock('@/lib/hooks/useBotHeader', () => ({ useBotHeader: () => ({ bot: null }) }))
jest.mock('@/app/components/trader/performance/PeriodSelector', () => ({
  PeriodSelector: () => null,
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
jest.mock('../ModuleDegraded', () => () => null)
jest.mock('../ServingRecordsSection', () => () => null)
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

function mockCore(extras: Record<string, unknown>) {
  ;(useTraderCore as jest.Mock).mockReturnValue({
    modules: coreModules(extras),
    isPendingUpstream: false,
    isDegraded: false,
    isLoading: false,
    error: null,
    refetch: jest.fn(),
  })
}

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
