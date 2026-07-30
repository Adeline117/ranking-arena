import { fireEvent, render, screen, within } from '@testing-library/react'
import WeeklyArenaClient from '../WeeklyArenaClient'
import type { WeeklyLeaderRow, WeeklyLeaders } from '@/lib/data/serving/weekly-leaders'

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    language: 'en',
    t: (key: string) =>
      (
        ({
          sortBy: 'Sort by',
          weeklyArenaTitle: 'Weekly Arena',
          weeklyArenaSubtitle: 'Pooled leaderboard',
          weeklyArenaColRank: 'Rank',
          weeklyArenaColTrader: 'Trader',
          weeklyArenaColExchange: 'Exchange',
          weeklyArenaColRoi: 'ROI',
          weeklyArenaColPnl: 'PnL',
          weeklyArenaColWinRate: 'Win Rate',
          weeklyArenaColAsOf: 'Updated',
          weeklyArenaNote: 'Note',
          share: 'Share',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

jest.mock('@/app/components/ui/PageHeader', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/app/components/common/DerivedBoardBadge', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/app/components/common/ProvenanceFooter', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/lib/utils/date', () => ({
  formatTimeAgo: (value: string) => value,
}))

function weeklyRow(
  source: string,
  exchangeTraderId: string,
  nickname: string,
  overrides: Partial<WeeklyLeaderRow> = {}
): WeeklyLeaderRow {
  return {
    source,
    exchangeSlug: source,
    exchangeName: `${source} Exchange`,
    productType: 'futures',
    exchangeTraderId,
    nickname,
    traderKind: 'human',
    avatarSrc: null,
    sourceRank: null,
    roi: 0,
    pnl: null,
    winRate: null,
    provenance: {
      source,
      asOf: '2026-07-29T00:00:00.000Z',
      derived: false,
    },
    ...overrides,
  }
}

function weeklyData(rows: WeeklyLeaderRow[]): WeeklyLeaders {
  return { nonLegacyCount: 5, rows, bitmart: null }
}

function tableOrder(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('tbody [data-trader-name]')).map(
    (node) => node.getAttribute('data-trader-name') ?? ''
  )
}

function tableRow(container: HTMLElement, traderName: string): HTMLTableRowElement {
  const trader = container.querySelector(`[data-trader-name="${traderName}"]`)
  const row = trader?.closest('tr')
  if (!(row instanceof HTMLTableRowElement)) {
    throw new Error(`Missing table row for ${traderName}`)
  }
  return row
}

function rankCell(container: HTMLElement, traderName: string): HTMLTableCellElement {
  const cell = tableRow(container, traderName).cells[0]
  if (!(cell instanceof HTMLTableCellElement)) {
    throw new Error(`Missing rank cell for ${traderName}`)
  }
  return cell
}

function expectOfficialRanks(container: HTMLElement) {
  expect(rankCell(container, 'Mike')).toHaveTextContent('🥇')
  expect(rankCell(container, 'Mike')).toHaveTextContent('#1')
  expect(rankCell(container, 'Zulu')).toHaveTextContent('🥈')
  expect(rankCell(container, 'Zulu')).toHaveTextContent('#2')
  expect(rankCell(container, 'Alpha')).toHaveTextContent('🥉')
  expect(rankCell(container, 'Alpha')).toHaveTextContent('#3')
  expect(rankCell(container, 'Echo')).toHaveTextContent('#4')
  expect(rankCell(container, 'Bravo')).toHaveTextContent('#5')
}

describe('WeeklyArenaClient pooled rank authority', () => {
  it('computes ROI rank once with an identity tie-break and preserves it across browsing sorts', () => {
    const rows = [
      weeklyRow('alpha', 'z-id', 'Zulu', {
        exchangeName: 'Bravo Exchange',
        roi: 100,
        pnl: { value: 10, currency: 'USDT' },
        winRate: 40,
        provenance: { source: 'alpha', asOf: '2026-07-25T00:00:00.000Z' },
      }),
      weeklyRow('beta', 'c-id', 'Alpha', {
        exchangeName: 'Alpha Exchange',
        roi: 50,
        pnl: null,
        winRate: 70,
        provenance: { source: 'beta', asOf: '2026-07-24T00:00:00.000Z' },
      }),
      weeklyRow('gamma', 'd-id', 'Echo', {
        exchangeName: 'Charlie Exchange',
        roi: 20,
        pnl: { value: -5, currency: 'USDT' },
        winRate: 55,
        provenance: { source: 'gamma', asOf: '2026-07-27T00:00:00.000Z' },
      }),
      // Same source + ROI as Zulu, but a-id is the lower canonical identity.
      // Input order is deliberately reversed so stable-array order cannot pass.
      weeklyRow('alpha', 'a-id', 'Mike', {
        exchangeName: 'Zulu Exchange',
        roi: 100,
        pnl: { value: 50, currency: 'USDT' },
        winRate: null,
        provenance: { source: 'alpha', asOf: '2026-07-29T00:00:00.000Z' },
      }),
      weeklyRow('delta', 'e-id', 'Bravo', {
        exchangeName: 'Delta Exchange',
        roi: 10,
        pnl: { value: 999, currency: 'USDT' },
        winRate: 10,
        provenance: { source: 'delta', asOf: '2026-07-26T00:00:00.000Z' },
      }),
    ]

    const { container } = render(<WeeklyArenaClient data={weeklyData(rows)} />)

    // Official pooled order: ROI DESC, then `${source}:${exchangeTraderId}` ASC.
    expectOfficialRanks(container)
    const podium = Array.from(container.querySelectorAll('.weekly-podium-card'))
    expect(podium).toHaveLength(3)
    expect(podium[0]).toHaveTextContent('Mike')
    expect(podium[1]).toHaveTextContent('Zulu')
    expect(podium[2]).toHaveTextContent('Alpha')

    const browsingSorts: Array<{ label: string; first: string }> = [
      { label: 'Trader', first: 'Alpha' },
      { label: 'Exchange', first: 'Alpha' },
      { label: 'PnL', first: 'Bravo' },
      { label: 'Win Rate', first: 'Alpha' },
      { label: 'Updated', first: 'Mike' },
    ]

    for (const { label, first } of browsingSorts) {
      fireEvent.click(screen.getByRole('button', { name: `Sort by ${label}` }))
      expect(tableOrder(container)[0]).toBe(first)
      expectOfficialRanks(container)
    }
  })

  it('excludes invalid ROI and treats null or non-finite secondary metrics as unknown-last', () => {
    const rows = [
      weeklyRow('invalid', 'nan-roi', 'Invalid ROI', { roi: Number.NaN }),
      weeklyRow('invalid', 'infinite-roi', 'Infinite ROI', {
        roi: Number.POSITIVE_INFINITY,
      }),
      weeklyRow('alpha', 'invalid-secondary', 'Invalid Secondary', {
        roi: 30,
        pnl: { value: Number.NaN, currency: 'USDT' },
        winRate: Number.POSITIVE_INFINITY,
      }),
      weeklyRow('beta', 'null-secondary', 'Null Secondary', {
        roi: 20,
        pnl: null,
        winRate: null,
      }),
      weeklyRow('gamma', 'valid-high', 'Valid High', {
        roi: 10,
        pnl: { value: 100, currency: 'USDT' },
        winRate: 80,
      }),
      weeklyRow('delta', 'valid-low', 'Valid Low', {
        roi: 5,
        pnl: { value: -10, currency: 'USDT' },
        winRate: 10,
      }),
    ]

    const { container } = render(<WeeklyArenaClient data={weeklyData(rows)} />)

    expect(screen.queryByText('Invalid ROI')).not.toBeInTheDocument()
    expect(screen.queryByText('Infinite ROI')).not.toBeInTheDocument()
    expect(rankCell(container, 'Invalid Secondary')).toHaveTextContent('🥇')
    expect(rankCell(container, 'Null Secondary')).toHaveTextContent('🥈')
    expect(rankCell(container, 'Valid High')).toHaveTextContent('🥉')
    expect(rankCell(container, 'Valid Low')).toHaveTextContent('#4')

    const invalidCells = within(tableRow(container, 'Invalid Secondary')).getAllByRole('cell')
    expect(invalidCells[4]).toHaveTextContent('—')
    expect(invalidCells[5]).toHaveTextContent('—')

    for (const label of ['PnL', 'Win Rate']) {
      const button = screen.getByRole('button', { name: `Sort by ${label}` })

      fireEvent.click(button) // default DESC
      expect(tableOrder(container).slice(0, 2)).toEqual(['Valid High', 'Valid Low'])
      expect(tableOrder(container).slice(-2).sort()).toEqual([
        'Invalid Secondary',
        'Null Secondary',
      ])

      fireEvent.click(button) // ASC
      expect(tableOrder(container).slice(0, 2)).toEqual(['Valid Low', 'Valid High'])
      expect(tableOrder(container).slice(-2).sort()).toEqual([
        'Invalid Secondary',
        'Null Secondary',
      ])
    }
  })
})
