import { render, screen, within } from '@testing-library/react'
import SSRRankingTable from '../SSRRankingTable'
import type { InitialTrader } from '@/lib/getInitialTraders'
import { getCriticalCss } from '@/lib/performance/critical-css'

jest.mock('@/lib/i18n/server', () => ({
  getStaticTranslation: () => ({
    t: (key: string) => (key === 'holderBadge' ? 'Holder' : key),
  }),
}))

const traders: InitialTrader[] = [
  {
    id: 'alpha-id',
    handle: 'Alpha Trader',
    roi: 42.5,
    pnl: 125000,
    win_rate: 61.2,
    max_drawdown: 8.4,
    followers: 10,
    source: 'binance_futures',
    source_type: 'futures',
    avatar_url: null,
    arena_score: 88,
    sharpe: 2.4,
    trades_count: 120,
    score_confidence: 'full',
  },
  {
    id: 'wallet-id',
    handle: 'Wallet Holder',
    roi: -4.25,
    pnl: -420,
    win_rate: null,
    max_drawdown: 0.01,
    followers: 0,
    source: 'hyperliquid',
    source_type: 'web3',
    avatar_url: null,
    arena_score: 64,
    sharpe: null,
    trades_count: 0,
    score_confidence: 'partial',
  },
]

describe('SSRRankingTable responsive layout', () => {
  it('renders a desktop table information architecture with one link/value tree per trader', async () => {
    const view = await SSRRankingTable({ traders })
    const { container } = render(view)

    const header = container.querySelector('.ssr-ranking-header')
    expect(header).not.toBeNull()
    expect(header).toHaveClass('ssr-ranking-grid')
    expect(header).toHaveTextContent('RankTraderScoreROI (90D)PnLWinMDD')

    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(traders.length)
    expect(screen.getAllByText('Alpha Trader')).toHaveLength(1)
    expect(screen.getAllByText('Wallet Holder')).toHaveLength(1)

    const firstRow = links[0]
    expect(firstRow).toHaveClass('ssr-ranking-entry', 'ssr-ranking-grid')
    expect(firstRow).toHaveAttribute('href', '/trader/alpha-id?platform=binance_futures')
    expect(within(firstRow).getByText('88')).toBeInTheDocument()
    expect(firstRow.querySelector('.ssr-rank-cell')).not.toBeNull()
    expect(firstRow.querySelector('.ssr-trader-cell')).not.toBeNull()
    expect(firstRow.querySelector('.ssr-score-cell')).not.toBeNull()
    expect(firstRow.querySelector('.ssr-roi-cell')).not.toBeNull()
    expect(firstRow.querySelector('.ssr-supporting-metrics')).not.toBeNull()
    expect(container.querySelectorAll('.ssr-card')).toHaveLength(0)
  })

  it('keeps the desktop grid in critical CSS and reflows the same cells below 768px', () => {
    const css = getCriticalCss().replace(/\s+/g, '')

    expect(css).toContain(
      '.ssr-ranking-grid{display:grid;grid-template-columns:40pxminmax(0,1.5fr)58pxminmax(72px,96px)minmax(64px,80px)60px60px;'
    )
    expect(css).toContain(
      '@media(max-width:767px){.ssr-ranking-table{padding:0010px;background:transparent}.ssr-ranking-header{display:none}'
    )
    expect(css).toContain(
      'grid-template-columns:32pxminmax(0,1fr)auto;grid-template-areas:"ranktraderscore""roiroiroi""supportsupportsupport";'
    )
    expect(css).toContain(
      '.ssr-supporting-metrics{grid-area:support;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));'
    )
    expect(css).not.toContain('.ssr-desktop-row')
    expect(css).not.toContain('.ssr-mobile-card')
  })
})
