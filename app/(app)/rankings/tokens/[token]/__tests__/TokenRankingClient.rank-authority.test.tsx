import { fireEvent, render, screen, within } from '@testing-library/react'
import TokenRankingClient, {
  type TokenRankingSnapshotSeed,
  type TokenTrader,
} from '../TokenRankingClient'

const mockPush = jest.fn()
const mockReplace = jest.fn()
const mockRouter = { push: mockPush, replace: mockReplace }
const mockSearchParams = new URLSearchParams('generation=7')

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
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

const PUBLISHED_AT = '2026-07-29T20:00:00.123Z'

function trader(
  id: string,
  handle: string,
  tokenRank: number,
  tokenPnl: number,
  totalPnl: number
): TokenTrader {
  return {
    source: 'binance_futures',
    source_trader_id: id,
    handle,
    avatar_url: null,
    arena_score: 80,
    roi: 12,
    total_pnl: totalPnl,
    token_pnl: tokenPnl,
    token_trade_count: 5,
    token_win_rate: 60,
    token_avg_pnl_pct: 2,
    token_rank: tokenRank,
  }
}

function snapshot(traders: TokenTrader[]): TokenRankingSnapshotSeed {
  return {
    contract: 'token-ranking-page@1',
    generation: '7',
    profilePublicationId: 'leaderboard-publication-7',
    publishedAt: PUBLISHED_AT,
    publishedAtEpochMs: Date.parse(PUBLISHED_AT),
    windowThroughDate: '2026-07-29',
    sourceAsOf: '2026-07-29T19:55:00.000Z',
    sourceThroughDate: '2026-07-29',
    dailyRowCount: 123,
    popularRowCount: 25,
    token: 'BTC',
    period: '90D',
    lookbackDays: 90,
    limit: 50,
    offset: 0,
    total: traders.length,
    traders,
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

describe('TokenRankingClient published token-rank authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    for (const key of Array.from(mockSearchParams.keys())) mockSearchParams.delete(key)
    mockSearchParams.set('generation', '7')
    global.fetch = jest.fn()
  })

  it('keeps exact server ranks attached to traders while locally browsing another metric', () => {
    const ranked = [
      trader('alpha-id', 'Alpha', 1, 100, 10),
      trader('bravo-id', 'Bravo', 2, 90, 1_000),
      trader('charlie-id', 'Charlie', 3, 80, 500),
    ]

    render(
      <TokenRankingClient
        token="BTC"
        initialPeriod="90D"
        initialPage={0}
        requestedGeneration="7"
        initialSnapshot={snapshot(ranked)}
      />
    )

    expect(displayedRank('Alpha')).toBe('1')
    expect(displayedRank('Bravo')).toBe('2')
    expect(displayedRank('Charlie')).toBe('3')

    fireEvent.click(screen.getByRole('columnheader', { name: 'tokenRankingTotalPnl — sort' }))

    const displayedNames = screen
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.textContent ?? '')
    expect(displayedNames[0]).toContain('Bravo')
    expect(displayedNames[1]).toContain('Charlie')
    expect(displayedNames[2]).toContain('Alpha')
    expect(displayedRank('Bravo')).toBe('2')
    expect(displayedRank('Charlie')).toBe('3')
    expect(displayedRank('Alpha')).toBe('1')
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
