import { render, screen, within } from '@testing-library/react'
import SSRRankingTable from '../SSRRankingTable'
import type { InitialTrader } from '@/lib/getInitialTraders'
import { getCriticalCss } from '@/lib/performance/critical-css'

jest.mock('@/lib/i18n/server', () => {
  const en = jest.requireActual('@/lib/i18n/en').default as Record<string, string>
  return {
    getStaticTranslation: () => ({
      t: (key: string) => (key === 'holderBadge' ? 'Holder' : (en[key] ?? key)),
    }),
  }
})

const traders: InitialTrader[] = [
  {
    id: 'alpha-id',
    handle: 'Alpha Trader',
    rank: 7,
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
    rank: 11,
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
    expect(firstRow).toHaveAccessibleName(expect.stringContaining('Rank 7:'))
    expect(within(firstRow).getByText('7')).toBeInTheDocument()
    expect(within(firstRow).getByText('88')).toBeInTheDocument()
    expect(firstRow.querySelector('.ssr-rank-cell')).not.toBeNull()
    expect(firstRow.querySelector('.ssr-trader-cell')).not.toBeNull()
    expect(firstRow.querySelector('.ssr-score-cell')).not.toBeNull()
    expect(firstRow.querySelector('.ssr-roi-cell')).not.toBeNull()
    expect(firstRow.querySelector('.ssr-supporting-metrics')).not.toBeNull()
    expect(container.querySelectorAll('.ssr-card')).toHaveLength(0)
  })

  it('keeps the desktop grid in critical CSS and reflows the same cells into compact rows below 768px', () => {
    const css = getCriticalCss().replace(/\s+/g, '')

    expect(css).toContain(
      // Mirrors RankingTable's default desktop template (score/roi/pnl/win/mdd).
      '.ssr-ranking-grid{display:grid;grid-template-columns:40pxminmax(0,1.5fr)58px96px80px64px64px;'
    )
    // Owner decision 2026-11-13: ~56px flat rows (rank | trader | score | one
    // metric) shared with the client MobileRankRows — no per-row cards/tiles.
    expect(css).toContain(
      '.ssr-ranking-table{padding:0;background:transparent}.ssr-ranking-header{display:none}'
    )
    expect(css).toContain(
      '.mrow-head,.mrow{display:grid;grid-template-columns:24pxminmax(0,1fr)44px84px;'
    )
    expect(css).toContain('.mrow{position:relative;height:56px;min-height:56px;margin:0;')
    expect(css).toContain('.mrow-top-1{box-shadow:inset3px00var(--color-rank-gold)}')
    expect(css).toContain('.ssr-supporting-metrics{display:contents}')
    // Only the chosen secondary metric is visible (default ROI).
    expect(css).toContain('html:not([data-rank-metric]).mrow.mrow-m-roi')
    expect(css).not.toContain('grid-template-areas:"ranktraderscore""roiroiroi"')
    expect(css).not.toContain('.ssr-desktop-row')
    expect(css).not.toContain('.ssr-mobile-card')
  })

  it('marks every SSR row cell with the shared compact-row classes', async () => {
    const view = await SSRRankingTable({ traders })
    const { container } = render(view)
    const row = container.querySelector('.ssr-ranking-entry')

    expect(row).toHaveClass('mrow')
    for (const cls of [
      '.mrow-rank',
      '.mrow-trader',
      '.mrow-name',
      '.mrow-tag',
      '.mrow-score',
      '.mrow-m-roi',
      '.mrow-m-pnl',
      '.mrow-m-win',
      '.mrow-m-mdd',
    ]) {
      expect(row?.querySelector(cls)).not.toBeNull()
    }
    expect(container.querySelector('.mrow-head')).not.toBeNull()
  })

  it('renders Win% and MDD neutral and keeps gain/loss color only on ROI and PnL', async () => {
    const view = await SSRRankingTable({ traders })
    const { container } = render(view)
    const row = container.querySelector('.ssr-ranking-entry') as HTMLElement

    const win = row.querySelector('.ssr-winrate-cell .ssr-metric-value') as HTMLElement
    expect(win.getAttribute('style')).toBeNull()
    const mdd = row.querySelector('.ssr-mdd-cell') as HTMLElement
    expect(mdd).toHaveTextContent('-8.4%')
    expect(mdd).not.toHaveTextContent('▼')
    expect(mdd.innerHTML).not.toContain('accent-error')
    expect(row.querySelector('.ssr-roi-cell')?.innerHTML).toContain('accent-success')
  })

  it('distinguishes zero, tiny, and invalid drawdown in the server-rendered shell', async () => {
    const drawdownCases: InitialTrader[] = [
      { ...traders[0], id: 'zero-mdd', handle: 'Zero MDD', max_drawdown: 0 },
      { ...traders[0], id: 'tiny-mdd', handle: 'Tiny MDD', max_drawdown: 0.01 },
      { ...traders[0], id: 'invalid-mdd', handle: 'Invalid MDD', max_drawdown: 100.01 },
    ]
    const view = await SSRRankingTable({ traders: drawdownCases })
    const { container } = render(view)
    const mddCells = container.querySelectorAll('.ssr-mdd-cell')

    expect(mddCells).toHaveLength(3)
    expect(mddCells[0]).toHaveTextContent('0.0%')
    expect(mddCells[0]).not.toHaveTextContent('▼')
    expect(mddCells[1]).toHaveTextContent('< 0.1%')
    expect(mddCells[2]).toHaveTextContent('—')
    expect(mddCells[2]).not.toHaveTextContent('▼')
  })

  it('server-renders an idle-window row with the no-trading label and no score', async () => {
    const view = await SSRRankingTable({
      traders: [
        { ...traders[0], id: 'idle', handle: 'Idle Trader', idle_window: true, arena_score: 0.01 },
      ],
    })
    const { container } = render(view)

    expect(container.querySelector('[data-testid="idle-window-label"]')).not.toBeNull()
    expect(container.querySelector('.ssr-score-badge')).toHaveTextContent('—')
  })

  it('keeps unknown source metrics unknown without a fabricated zero bar or aria value', async () => {
    const view = await SSRRankingTable({
      traders: [
        {
          ...traders[0],
          id: 'unknown-metrics',
          handle: 'Unknown Metrics',
          roi: null,
          pnl: null,
          arena_score: null,
          score_confidence: null,
        },
      ],
    })
    const { container } = render(view)
    const row = screen.getByRole('link', { name: /unknown metrics/i })

    expect(row).toHaveAccessibleName(expect.stringContaining('Arena Score unknown, ROI unknown'))
    expect(within(row).getAllByText('—').length).toBeGreaterThanOrEqual(3)
    expect(container.querySelector('.ssr-roi-track')).toBeNull()
    expect(row).not.toHaveAccessibleName(expect.stringContaining('ROI +0.00%'))
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'does not server-render non-finite supporting metrics for %p',
    async (metric) => {
      const view = await SSRRankingTable({
        traders: [
          {
            ...traders[0],
            id: 'unknown-supporting-metrics',
            handle: 'Unknown Supporting Metrics',
            win_rate: metric,
            sharpe: metric,
          },
        ],
      })
      const { container } = render(view)

      expect(container.querySelector('.ssr-winrate-cell')).toHaveTextContent('—')
      expect(container.querySelector('.ssr-sharpe-cell')).toHaveTextContent('—')
      expect(container).not.toHaveTextContent('NaN')
      expect(container).not.toHaveTextContent('Infinity')
    }
  )

  it('uses neutral empty-state copy instead of an unverified refresh cadence', async () => {
    const view = await SSRRankingTable({ traders: [] })
    render(view)

    expect(
      screen.getByText(
        'Latest published ranking data will appear here / 最新已发布排行数据将在此显示'
      )
    ).toBeInTheDocument()
    expect(screen.queryByText(/refreshes every few minutes/i)).not.toBeInTheDocument()
  })
})
