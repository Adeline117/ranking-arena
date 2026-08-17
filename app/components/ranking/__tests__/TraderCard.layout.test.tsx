import { fireEvent, render, screen, within } from '@testing-library/react'
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
  MetricStat: ({
    label,
    value,
    nullTooltip,
  }: {
    label: string
    value?: React.ReactNode
    nullTooltip?: string
  }) => (
    <span data-testid={`metric-${label}`} title={nullTooltip}>
      {label}:{value ?? '—'}
    </span>
  ),
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
// eslint-disable-next-line react/display-name -- concise default-export module mock
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

  it.each([
    [0, '0.0%'],
    [0.01, '< 0.1%'],
    [12.34, '-12.3%'],
    [100.01, '—'],
    [null, '—'],
  ])('renders max drawdown %p as %s', (maxDrawdown, expected) => {
    render(
      <TraderCard
        trader={{ ...trader, max_drawdown: maxDrawdown }}
        rank={4}
        language="en"
        getMedalGlowClass={() => ''}
        parseSourceInfo={() => ({
          exchange: 'Binance',
          type: 'Futures',
          typeColor: '#777',
        })}
      />
    )

    expect(screen.getByTestId('metric-MDD')).toHaveTextContent(expected)
    if (maxDrawdown === 0 || maxDrawdown == null || maxDrawdown > 100) {
      expect(screen.getByTestId('metric-MDD')).not.toHaveTextContent('▼')
    }
    if (maxDrawdown == null || maxDrawdown > 100) {
      expect(screen.getByTestId('metric-MDD')).toHaveAttribute('title')
    }
  })

  it('labels estimated drawdown consistently with the table row', () => {
    render(
      <TraderCard
        trader={{ ...trader, max_drawdown: 0, metrics_estimated: true }}
        rank={4}
        language="en"
        getMedalGlowClass={() => ''}
        parseSourceInfo={() => ({
          exchange: 'Binance',
          type: 'Futures',
          typeColor: '#777',
        })}
      />
    )

    const mdd = screen.getByTestId('metric-MDD')
    expect(mdd).toHaveTextContent('~0.0%')
    expect(within(mdd).getByTitle('estimatedFromRoi')).toBeInTheDocument()
  })

  it('keeps unknown ROI and score unknown in the card aria label and share text', async () => {
    const share = jest.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'share', { configurable: true, value: share })

    render(
      <TraderCard
        trader={{ ...trader, roi: null, arena_score: null }}
        rank={4}
        language="en"
        getMedalGlowClass={() => ''}
        parseSourceInfo={() => ({ exchange: 'Binance', type: 'Futures', typeColor: '#777' })}
      />
    )

    expect(screen.getByRole('link', { name: /ROI unknown/i })).toBeInTheDocument()
    expect(screen.queryByText('Sparkline')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Share/i }))
    await Promise.resolve()
    expect(share).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining('ROI unknown, Arena Score unknown'),
      })
    )
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'renders non-finite supporting metrics as unknown for %p',
    (metric) => {
      const { container } = render(
        <TraderCard
          trader={{ ...trader, sharpe_ratio: metric, win_rate: metric }}
          rank={4}
          language="en"
          getMedalGlowClass={() => ''}
          parseSourceInfo={() => ({ exchange: 'Binance', type: 'Futures', typeColor: '#777' })}
        />
      )

      expect(screen.getByTestId('metric-Sharpe')).toHaveTextContent('Sharpe:—')
      expect(screen.getByTestId('metric-WIN%')).toHaveTextContent('WIN%:—')
      expect(container).not.toHaveTextContent('NaN')
      expect(container).not.toHaveTextContent('Infinity')
    }
  )
})
