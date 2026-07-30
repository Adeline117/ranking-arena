import { fireEvent, render, screen, within } from '@testing-library/react'
import TokenRankingClient, { type TokenTrader } from '../TokenRankingClient'

const mockReplace = jest.fn()
const mockSearchParams = new URLSearchParams()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => '/rankings/tokens/BTC',
  useSearchParams: () => mockSearchParams,
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/app/components/common/ProvenanceFooter', () => ({
  __esModule: true,
  default: () => null,
}))

type RankedTokenTrader = Omit<TokenTrader, 'token_rank'> & { token_rank: number | null }

function trader(
  id: string,
  handle: string,
  tokenRank: number | null,
  tokenPnl: number,
  totalPnl: number
): RankedTokenTrader {
  return {
    source: 'binance_futures',
    source_trader_id: id,
    handle,
    avatar_url: null,
    arena_score: null,
    roi: null,
    total_pnl: totalPnl,
    token_pnl: tokenPnl,
    token_trade_count: 5,
    token_win_rate: null,
    token_avg_pnl_pct: null,
    token_rank: tokenRank,
  }
}

function rowFor(name: string): HTMLElement {
  const row = screen.getByText(name).closest('[role="row"]')
  if (!(row instanceof HTMLElement)) throw new Error(`Missing row for ${name}`)
  return row
}

function displayedRank(name: string): string {
  return within(rowFor(name)).getAllByRole('cell')[0]?.textContent?.trim() ?? ''
}

describe('TokenRankingClient token-PnL rank authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSearchParams.delete('page')
    mockSearchParams.delete('period')
  })

  it('uses server token_rank and preserves it while browsing by another metric', () => {
    const ranked = [
      trader('alpha-id', 'Alpha', 7, 100, 10),
      trader('bravo-id', 'Bravo', 12, 90, 1_000),
      trader('partial-id', 'Unpublished rank', null, 80, 2_000),
      trader('outside-total-id', 'Outside total', 13, 70, 3_000),
    ]

    render(
      <TokenRankingClient
        token="BTC"
        initialPeriod="90D"
        initialTraders={ranked as TokenTrader[]}
        initialTotal={12}
        asOf="2026-07-29T00:00:00.000Z"
      />
    )

    expect(displayedRank('Alpha')).toBe('7')
    expect(displayedRank('Bravo')).toBe('12')
    expect(screen.queryByText('Unpublished rank')).not.toBeInTheDocument()
    expect(screen.queryByText('Outside total')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('columnheader', { name: 'tokenRankingTotalPnl — sort' }))

    const displayedNames = screen
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.textContent ?? '')
    expect(displayedNames[0]).toContain('Bravo')
    expect(displayedRank('Bravo')).toBe('12')
    expect(displayedRank('Alpha')).toBe('7')
  })
})
