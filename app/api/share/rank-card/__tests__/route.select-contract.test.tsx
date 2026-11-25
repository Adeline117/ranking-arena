/**
 * Runs the rank-card route against the REAL publication policy.
 *
 * The sibling rank-authority test mocks the policy, so it could not notice
 * that the route's select list omitted columns the real row check reads
 * (pnl, max_drawdown): every row was rejected and the card showed "--".
 *
 * Here the fake view behaves like PostgREST: it returns only the columns the
 * route actually selected. A missing column therefore fails these tests.
 */
import React from 'react'

let mockImageTree: React.ReactNode = null
const mockFrom = jest.fn()

jest.mock('next/og', () => ({
  ImageResponse: jest.fn().mockImplementation((element: React.ReactNode) => {
    mockImageTree = element
    return { element }
  }),
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom }),
}))

jest.mock('@/lib/rankings/public-response-cache', () => ({
  publicRankingResponseCacheHeaders: () => ({}),
  publicRankingResponseRejectionHeaders: () => ({}),
  redirectToPublicRankingResponseCacheEpoch: () => null,
}))

import { GET } from '../route'
import { isPublicRankingRowEligible } from '@/lib/rankings/publication-policy'

/** Every column of a view row; the route may select any subset. */
function viewRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    season_id: '7D',
    source: 'binance_futures',
    source_trader_id: 'trader-1',
    handle: 'Top Trader',
    avatar_url: null,
    rank: 3,
    arena_score: 91.5,
    roi: 12.5,
    pnl: 4321.5,
    win_rate: 68,
    max_drawdown: 14.2,
    score_completeness: 'full',
    metrics_estimated: false,
    is_outlier: false,
    computed_at: new Date().toISOString(),
    ...overrides,
  }
}

function sourceQuery() {
  const chain: Record<string, jest.Mock> = {}
  for (const method of ['select', 'or', 'limit', 'eq']) chain[method] = jest.fn(() => chain)
  chain.maybeSingle = jest.fn().mockResolvedValue({
    data: { handle: 'Top Trader', source: 'binance_futures', source_trader_id: 'trader-1' },
    error: null,
  })
  return chain
}

/** Projects the full row onto the selected columns, as PostgREST would. */
function viewQuery(fullRow: Record<string, unknown>, selected: { columns: string[] }) {
  const chain: Record<string, jest.Mock> = {}
  chain.select = jest.fn((columns: string) => {
    selected.columns = columns.split(',').map((column) => column.trim())
    return chain
  })
  chain.eq = jest.fn(() => chain)
  chain.maybeSingle = jest.fn(async () => ({
    data: Object.fromEntries(
      selected.columns.filter((column) => column in fullRow).map((c) => [c, fullRow[c]])
    ),
    error: null,
  }))
  return chain
}

type ElementProps = { children?: React.ReactNode }

function collectText(node: React.ReactNode, found: string[] = []) {
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, found)
    return found
  }
  if (typeof node === 'string' || typeof node === 'number') {
    found.push(String(node))
    return found
  }
  if (React.isValidElement(node)) collectText((node.props as ElementProps).children, found)
  return found
}

async function renderCard(fullRow: Record<string, unknown>) {
  const selected = { columns: [] as string[] }
  mockFrom.mockReturnValueOnce(sourceQuery()).mockReturnValueOnce(viewQuery(fullRow, selected))
  await GET({
    url: 'https://arenafi.org/api/share/rank-card?handle=Top%20Trader&platform=binance_futures&window=7d',
  } as never)
  return { text: collectText(mockImageTree), columns: selected.columns }
}

describe('share rank card select list vs the real publication policy', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockImageTree = null
  })

  it('renders real numbers for a valid full row', async () => {
    const { text } = await renderCard(viewRow())

    expect(text).toContain('3') // rank
    expect(text).toContain('92') // arena score, rounded
    expect(text).toContain('+12.5%') // ROI
    expect(text).toContain('68%') // win rate
    expect(text).not.toContain('--')
    expect(text).not.toContain('—')
  })

  it('selects every column the row check needs', async () => {
    const { columns } = await renderCard(viewRow())

    expect(columns).toEqual(
      expect.arrayContaining([
        'source',
        'source_trader_id',
        'season_id',
        'rank',
        'roi',
        'pnl',
        'win_rate',
        'max_drawdown',
        'arena_score',
        'score_completeness',
        'metrics_estimated',
        'is_outlier',
        'computed_at',
      ])
    )

    // Independent of the list above: a valid row cut down to the selected
    // columns must still pass the real check. This catches a column the policy
    // starts reading later, without this test having to name it.
    const full = viewRow()
    const projected = Object.fromEntries(columns.map((column) => [column, full[column]]))
    expect(isPublicRankingRowEligible(full, { expectedPeriod: '7D' })).toBe(true)
    expect(isPublicRankingRowEligible(projected, { expectedPeriod: '7D' })).toBe(true)
  })

  it('shows "—", not 0%, when win rate was not provided', async () => {
    const { text } = await renderCard(viewRow({ win_rate: null, score_completeness: 'partial' }))

    expect(text).toContain('+12.5%')
    expect(text).toContain('92')
    expect(text).toContain('—')
    expect(text).not.toContain('0%')
    expect(text).not.toContain('--')
  })

  it('still renders numbers when both win rate and drawdown are absent', async () => {
    const { text } = await renderCard(
      viewRow({ win_rate: null, max_drawdown: null, score_completeness: 'minimal' })
    )

    expect(text).toContain('3')
    expect(text).toContain('+12.5%')
    expect(text).toContain('—')
    expect(text).not.toContain('--')
  })
})
