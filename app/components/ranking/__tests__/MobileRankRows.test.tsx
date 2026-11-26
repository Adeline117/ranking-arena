import { fireEvent, render, screen } from '@testing-library/react'
import { MobileRankHeader, TraderMobileRow } from '../MobileRankRows'
import { LS_KEY_MOBILE_METRIC, MOBILE_METRIC_ATTR } from '../mobile-metric'
import { TraderMetricCells } from '../TraderMetricCells'
import type { Trader } from '../RankingTable'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))
jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: jest.fn() }),
}))

const trader: Trader = {
  id: 'mobile-1',
  handle: 'Mobile Trader',
  source: 'binance_futures',
  roi: 42.5,
  pnl: 1250,
  win_rate: 61.2,
  max_drawdown: 12.34,
  followers: 0,
  arena_score: 87.4,
  rank: 2,
  score_confidence: 'full',
}

const parseSourceInfo = () => ({ type: 'Futures', typeColor: '#888' }) as never

describe('Mobile compact ranking rows (owner 2026-11-13)', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute(MOBILE_METRIC_ATTR)
  })

  it('renders one flat link row: rank, name + source tag, Score and all four metric slots', () => {
    render(
      <TraderMobileRow trader={trader} rank={2} language="en" parseSourceInfo={parseSourceInfo} />
    )
    const link = screen.getByRole('link')

    expect(link).toHaveAttribute('href', '/trader/mobile-1?platform=binance_futures')
    expect(link).toHaveClass('mrow', 'mrow-top', 'mrow-top-2')
    // Localized via i18n keys (the mock t echoes the key), never inline English.
    expect(link).toHaveAccessibleName('#2 Mobile Trader, arenaScoreAria, roiValueAria')
    expect(link.querySelector('.mrow-rank')).toHaveTextContent('2')
    expect(link.querySelector('.mrow-name')).toHaveTextContent('Mobile Trader')
    expect(link.querySelector('.mrow-tag')).toHaveTextContent('Futures')
    expect(link.querySelector('.mrow-score')).toHaveTextContent('87')
    expect(link.querySelector('.mrow-m-roi')).toHaveTextContent('+42.50%')
    expect(link.querySelector('.mrow-m-win')).toHaveTextContent('61.2%')
    expect(link.querySelector('.mrow-m-mdd')).toHaveTextContent('-12.3%')
    // No card chrome or grey metric tiles inside the row.
    expect(link.querySelector('.glass-card, .trader-card-contained')).toBeNull()
  })

  it('an idle-window row shows the no-trading label instead of a score', () => {
    render(
      <TraderMobileRow
        trader={{ ...trader, idle_window: true, arena_score: 0.01, roi: 0, pnl: 0 }}
        rank={4261}
        language="en"
        parseSourceInfo={parseSourceInfo}
      />
    )
    const link = screen.getByRole('link')
    expect(link).toHaveAccessibleName('#4261 Mobile Trader, noTradingThisPeriod, roiValueAria')
    expect(link.querySelector('.mrow-tag')).toHaveTextContent('noTradingThisPeriod')
    expect(link.querySelector('.mrow-score')).toHaveTextContent('—')
    expect(link.querySelector('.mrow-score')).not.toHaveTextContent('0')
    // Its own win rate and drawdown are still shown when present.
    expect(link.querySelector('.mrow-m-win')).toHaveTextContent('61.2%')
  })

  it.each([
    ['partial', 'scoreConfidencePartial'],
    ['minimal', 'scoreConfidenceMinimal'],
  ] as const)(
    'marks a %s-data score with a localized, named note and no penalty figure',
    (confidence, key) => {
      render(
        <TraderMobileRow
          trader={{ ...trader, score_confidence: confidence }}
          rank={7}
          language="en"
          parseSourceInfo={parseSourceInfo}
        />
      )
      // Hidden from the row's own accessible name (the cell is aria-hidden), so
      // look it up by title: the copy is an i18n key, never inline English.
      const note = screen.getByTitle(key)
      expect(note).toHaveAttribute('aria-label', key)
      expect(note.getAttribute('title')).not.toMatch(/%|\u00d7/)
    }
  )

  it('shows no data note on a score with complete data', () => {
    render(
      <TraderMobileRow trader={trader} rank={7} language="en" parseSourceInfo={parseSourceInfo} />
    )
    expect(screen.queryByTitle(/scoreConfidence/)).toBeNull()
  })

  it('keeps gain/loss color on ROI/PnL only — Win% and MDD are neutral, MDD has no arrow', () => {
    render(
      <TraderMobileRow trader={trader} rank={9} language="en" parseSourceInfo={parseSourceInfo} />
    )
    const link = screen.getByRole('link')

    expect(link.querySelector('.mrow-m-roi')?.innerHTML).toContain('accent-success')
    expect(link.querySelector('.mrow-m-win')?.innerHTML).not.toContain('accent-success')
    expect(link.querySelector('.mrow-m-mdd')?.innerHTML).not.toContain('accent-error')
    expect(link.querySelector('.mrow-m-mdd')).not.toHaveTextContent('▼')
    expect(link).not.toHaveClass('mrow-top')
  })

  it('persists the secondary-metric choice and exposes it on <html> for the CSS', () => {
    render(<MobileRankHeader />)
    const select = screen.getByRole('combobox', { name: 'rankingMobileMetricLabel' })

    expect(select).toHaveValue('roi')
    fireEvent.change(select, { target: { value: 'mdd' } })
    expect(localStorage.getItem(LS_KEY_MOBILE_METRIC)).toBe('mdd')
    expect(document.documentElement.getAttribute(MOBILE_METRIC_ATTR)).toBe('mdd')
  })

  it('restores a stored choice on mount', () => {
    localStorage.setItem(LS_KEY_MOBILE_METRIC, 'pnl')
    render(<MobileRankHeader />)

    expect(screen.getByRole('combobox')).toHaveValue('pnl')
    expect(document.documentElement.getAttribute(MOBILE_METRIC_ATTR)).toBe('pnl')
  })
})

describe('Desktop metric cells — Score-primary hierarchy', () => {
  it('renders Win% and MDD as neutral supporting stats (no green win, no red ▼ drawdown)', () => {
    const { container } = render(
      <div>
        <TraderMetricCells
          trader={{ ...trader, win_rate: 75 }}
          rank={8}
          language="en"
          getPnLTooltipFn={() => ''}
          t={(key) => key}
        />
      </div>
    )
    const win = container.querySelector('.col-winrate') as HTMLElement
    const mdd = container.querySelector('.col-mdd') as HTMLElement

    expect(win.innerHTML).toContain('var(--color-text-secondary)')
    expect(win.innerHTML).not.toContain('accent-success')
    expect(mdd).toHaveTextContent('-12.3%')
    expect(mdd).not.toHaveTextContent('▼')
    expect(mdd.innerHTML).not.toContain('accent-error')
    // ROI keeps its sign color and direction arrow.
    const roi = container.querySelector('.roi-cell') as HTMLElement
    expect(roi.innerHTML).toContain('accent-success')
    expect(roi).toHaveTextContent('▲')
  })

  it('without a sort handler (SSR-equivalent) the trader column stays a static label', () => {
    render(<MobileRankHeader />)
    expect(screen.queryByTestId('mobile-rank-sort-select')).toBeNull()
    expect(screen.getByTestId('mobile-rank-header')).toHaveTextContent('trader')
  })

  it('keeps an off-list current sort (e.g. sortino from a URL) selectable', () => {
    render(<MobileRankHeader sortColumn="sortino" sortDir="asc" onSortChange={jest.fn()} />)
    expect(screen.getByTestId('mobile-rank-sort-select')).toHaveValue('sortino:asc')
  })
})
