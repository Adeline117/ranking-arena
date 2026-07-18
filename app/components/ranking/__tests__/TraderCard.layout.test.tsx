import { render, screen, within } from '@testing-library/react'
import { TraderCard } from '../TraderCard'
import { getCriticalCss } from '@/lib/performance/critical-css'

const comparisonState = {
  isSelected: jest.fn(() => false),
  canAddMore: jest.fn(() => true),
  addTrader: jest.fn(),
  removeTrader: jest.fn(),
}

const useComparisonStore = Object.assign(
  jest.fn((selector: (state: typeof comparisonState) => unknown) => selector(comparisonState)),
  { getState: () => comparisonState }
)

jest.mock('@/lib/stores/comparisonStore', () => ({
  useComparisonStore: (...args: unknown[]) => useComparisonStore(...args),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      (
        ({
          share: 'Share',
          compare: 'Compare',
          addToCompare: 'Add to compare',
          removeFromCompare: 'Remove from compare',
          winRatePercent: 'WIN%',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

jest.mock('../shared/TraderDisplay', () => ({
  TRADER_TEXT_TERTIARY: '#777',
  TRADER_ACCENT_ERROR: '#c00',
  RankDisplay: ({ rank }: { rank: number }) => <span>{rank}</span>,
  TraderAvatar: () => <span>Avatar</span>,
  ScoreConfidenceIndicator: () => null,
  MetricStat: ({ label }: { label: string }) => <span>{label}</span>,
  areTraderPropsEqual: () => false,
  getScoreStyle: () => ({
    bgGradient: 'transparent',
    borderColor: '#777',
    textColor: '#fff',
  }),
}))

jest.mock('@/app/components/ui/Sparkline', () => ({
  Sparkline: () => <span>Sparkline</span>,
}))
jest.mock('../RankSparkline', () => ({ RankSparkline: () => <span>Rank sparkline</span> }))
jest.mock('../ScoreMiniBar', () => () => <span>Score bar</span>)
jest.mock('../AntiGamingBadge', () => () => null)
jest.mock('../VerifiedDataBadge', () => () => null)

describe('TraderCard narrow-card layout', () => {
  const trader = {
    id: 'shared-id',
    handle: 'A very long trader display name that must truncate',
    roi: 87.64,
    pnl: 192600,
    win_rate: 80.7,
    max_drawdown: 9.3,
    followers: 0,
    source: 'binance_futures',
    arena_score: 98,
  }

  it('keeps navigation and card actions as separate interactive regions', () => {
    const { container } = render(
      <TraderCard
        trader={trader}
        rank={3}
        language="en"
        getMedalGlowClass={() => ''}
        parseSourceInfo={() => ({
          exchange: 'Binance',
          type: 'Futures',
          typeColor: '#777',
        })}
      />
    )

    const profileLink = screen.getByRole('link', { name: /A very long trader/i })
    expect(within(profileLink).queryByRole('button')).not.toBeInTheDocument()
    expect(within(profileLink).queryByRole('checkbox')).not.toBeInTheDocument()

    const actions = screen.getByRole('group', { name: /actions/i })
    expect(within(actions).getByRole('button', { name: /Share/i })).toBeVisible()
    expect(within(actions).getByRole('button', { name: /Add to compare/i })).toBeVisible()

    const card = container.querySelector('.trader-card-contained')
    expect(card).toHaveStyle({
      alignItems: 'stretch',
      width: '100%',
      maxWidth: '100%',
      overflow: 'hidden',
    })
  })

  it('does not apply table-grid sizing rules to card-view rows', () => {
    const criticalCss = getCriticalCss()

    expect(criticalCss).toContain('.ranking-table-grid.ranking-row{display:grid')
    expect(criticalCss).not.toContain('\n.ranking-row{display:grid')
  })
})
