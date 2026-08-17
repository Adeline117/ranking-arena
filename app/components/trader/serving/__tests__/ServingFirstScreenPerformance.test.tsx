import { render, screen } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import ServingFirstScreenPerformance from '../ServingFirstScreenPerformance'
import type { TraderFirstScreen } from '@/lib/data/serving/types'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      (
        ({
          performance: 'Performance',
          leaderboardSnapshot: 'Leaderboard snapshot',
          provenanceTracked: 'Tracked',
          provenanceAsOf: 'as of',
          derivedBoardBadge: 'Derived',
          derivedBoardTooltip: 'Derived board details',
          roi: 'ROI',
          pnl: 'PnL',
          winRate: 'Win Rate',
          rank: 'Rank',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

const firstScreen: TraderFirstScreen = {
  source: 'test_futures',
  exchangeTraderId: 'trader-1',
  nickname: 'Snapshot Trader',
  avatarMirrorUrl: null,
  avatarOriginUrl: null,
  avatarSrc: null,
  walletAddress: null,
  traderKind: 'human',
  botStrategy: null,
  entries: [
    {
      timeframe: 7,
      rank: 21,
      headlineRoi: 1.25,
      headlinePnl: { value: 14.5, currency: 'USD' },
      headlineWinRate: 50,
      extras: {},
      provenance: { source: 'test_futures', asOf: '2026-08-16T10:00:00.000Z' },
    },
    {
      timeframe: 30,
      rank: 9,
      headlineRoi: 6.75,
      headlinePnl: { value: 223.4, currency: 'USDT' },
      headlineWinRate: 58.2,
      extras: {},
      provenance: { source: 'test_futures', asOf: '2026-08-16T11:00:00.000Z' },
    },
    {
      timeframe: 90,
      rank: 4,
      headlineRoi: 12.5,
      headlinePnl: { value: 1234.5, currency: 'USDC' },
      headlineWinRate: 61.25,
      extras: {},
      provenance: { source: 'test_futures', asOf: '2026-08-16T12:00:00.000Z' },
    },
  ],
}

describe('ServingFirstScreenPerformance', () => {
  it('server-renders the preferred 90D leaderboard snapshot with its original money currency', () => {
    const markup = renderToStaticMarkup(<ServingFirstScreenPerformance firstScreen={firstScreen} />)

    expect(markup).toContain('Leaderboard snapshot')
    expect(markup).toContain('90D')
    expect(markup).toContain('+12.50%')
    expect(markup).toContain('+$1.23K USDC')
    expect(markup).toContain('61.25%')
    expect(markup).toContain('#4')
    expect(markup).toContain('2026-08-16T12:00:00.000Z')
  })

  it('falls back from 90D to the highest available snapshot window', () => {
    render(
      <ServingFirstScreenPerformance
        firstScreen={{
          ...firstScreen,
          entries: firstScreen.entries.filter((entry) => entry.timeframe !== 90),
        }}
      />
    )

    expect(screen.getByRole('region', { name: 'Leaderboard snapshot · 30D' })).toBeInTheDocument()
    expect(screen.getByText('+$223.40 USDT')).toBeInTheDocument()
  })

  it('uses the selected window while its matching core module is still loading', () => {
    render(<ServingFirstScreenPerformance firstScreen={firstScreen} preferredTimeframe={7} />)

    expect(screen.getByRole('region', { name: 'Leaderboard snapshot · 7D' })).toBeInTheDocument()
    expect(screen.getByText('+$14.50 USD')).toBeInTheDocument()
  })

  it('discloses a capability-derived leaderboard snapshot before core data arrives', () => {
    render(
      <ServingFirstScreenPerformance
        firstScreen={firstScreen}
        periodAvailability={{ '7D': 'native', '30D': 'native', '90D': 'derived' }}
      />
    )

    expect(screen.getByText('Derived')).toHaveAttribute('title', 'Derived board details')
  })

  it('uses the availability of the rendered fallback entry for its derived disclosure', () => {
    render(
      <ServingFirstScreenPerformance
        firstScreen={{
          ...firstScreen,
          entries: firstScreen.entries.filter((entry) => entry.timeframe !== 90),
        }}
        preferredTimeframe={90}
        periodAvailability={{ '7D': 'native', '30D': 'derived', '90D': 'native' }}
      />
    )

    expect(screen.getByRole('region', { name: 'Leaderboard snapshot · 30D' })).toBeInTheDocument()
    expect(screen.getByText('Derived')).toBeInTheDocument()
  })

  it('skips a preferred cached window when the authority matrix has withdrawn it', () => {
    render(
      <ServingFirstScreenPerformance
        firstScreen={firstScreen}
        preferredTimeframe={90}
        periodAvailability={{ '7D': 'absent', '30D': 'native', '90D': 'absent' }}
      />
    )

    expect(screen.getByRole('region', { name: 'Leaderboard snapshot · 30D' })).toBeInTheDocument()
    expect(screen.queryByText('+$1.23K USDC')).not.toBeInTheDocument()
  })

  it('does not revive a cached snapshot for a window the authority matrix marks absent', () => {
    const { container } = render(
      <ServingFirstScreenPerformance
        firstScreen={firstScreen}
        periodAvailability={{ '7D': 'absent', '30D': 'absent', '90D': 'absent' }}
      />
    )

    expect(container).toBeEmptyDOMElement()
  })

  it('keeps missing snapshot metrics visibly unknown instead of inventing zeroes', () => {
    render(
      <ServingFirstScreenPerformance
        firstScreen={{
          ...firstScreen,
          entries: [
            {
              ...firstScreen.entries[2],
              headlineRoi: null,
              headlinePnl: null,
              headlineWinRate: null,
            },
          ],
        }}
      />
    )

    expect(screen.getAllByText('—')).toHaveLength(3)
    expect(screen.queryByText(/\$0(?:\.00)?/)).not.toBeInTheDocument()
  })

  it('does not invent metrics when the Tier-A payload has no entries', () => {
    const { container } = render(
      <ServingFirstScreenPerformance firstScreen={{ ...firstScreen, entries: [] }} />
    )

    expect(container).toBeEmptyDOMElement()
  })
})
