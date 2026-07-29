import React from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { tokens } from '@/lib/design-tokens'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))
jest.mock('@/app/components/ui/ExchangeLogo', () => ({
  __esModule: true,
  default: ({ exchange }: { exchange: string }) => <span data-exchange={exchange} />,
}))
jest.mock('@/app/components/base', () => ({
  Box: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  Text: ({
    as: Component = 'span',
    children,
    ...props
  }: {
    as?: React.ElementType
    children?: React.ReactNode
    [key: string]: unknown
  }) => {
    const { size: _size, weight: _weight, color: _color, ...domProps } = props
    return <Component {...domProps}>{children}</Component>
  },
}))

import AggregatedStats from '../AggregatedStats'

type Account = {
  platform: string
  traderKey: string
  handle: string | null
  label: string | null
  roi: number | null
  pnl: number | null
  arenaScore: number | null
  winRate: number | null
  maxDrawdown: number | null
  isPrimary?: boolean
}

function account(index: number, overrides: Partial<Account> = {}): Account {
  return {
    platform: `exchange_${index}`,
    traderKey: `trader_${index}`,
    handle: `Trader ${index}`,
    label: `Account ${index}`,
    roi: 10,
    pnl: null,
    arenaScore: null,
    winRate: 50,
    maxDrawdown: 10,
    ...overrides,
  }
}

function renderStats(accounts: Account[]) {
  return render(
    <AggregatedStats combinedPnl={null} bestRoi={null} weightedScore={null} accounts={accounts} />
  )
}

function openComparison() {
  fireEvent.click(screen.getByRole('button', { name: 'traderCompareAccounts' }))
}

function comparisonValues(label: string): HTMLElement[] {
  const labelCell = screen.getByText(label, { selector: 'td' })
  return within(labelCell.closest('tr')!).getAllByRole('cell').slice(1)
}

describe('AggregatedStats trusted metric display', () => {
  it('normalizes drawdown signs, preserves zero, and rejects invalid magnitudes', () => {
    renderStats([
      account(0, { maxDrawdown: -20 }),
      account(1, { maxDrawdown: 5 }),
      account(2, { maxDrawdown: 0 }),
      account(3, { maxDrawdown: 100.001 }),
      account(4, { maxDrawdown: Number.NaN }),
    ])
    openComparison()

    const cells = comparisonValues('maxDrawdown · 90D')
    expect(cells[0]).toHaveTextContent('-20.0%')
    expect(cells[1]).toHaveTextContent('-5.0%')
    expect(cells[2]).toHaveTextContent('0.0%')
    expect(cells[2]).toHaveStyle({ color: tokens.colors.text.tertiary })
    for (const cell of cells.slice(3)) expect(cell).toHaveTextContent('—')
    expect(screen.queryByText('compareBestValue')).not.toBeInTheDocument()
  })

  it('does not label a partial or even complete comparison as best without comparability proof', () => {
    const { rerender } = renderStats([
      account(0, { roi: 10 }),
      account(1, { roi: 5 }),
      account(2, { roi: null }),
    ])
    openComparison()
    expect(screen.queryByText('compareBestValue')).not.toBeInTheDocument()

    rerender(
      <AggregatedStats
        combinedPnl={null}
        bestRoi={null}
        weightedScore={null}
        accounts={[account(0, { roi: 10 }), account(1, { roi: 5 })]}
      />
    )
    expect(screen.queryByText('compareBestValue')).not.toBeInTheDocument()
  })

  it('hides untrusted cross-account money, score, and best-ROI surfaces', () => {
    const UnsafeAggregatedStats = AggregatedStats as unknown as React.ComponentType<{
      combinedPnl: number
      bestRoi: { value: number; platform: string; traderKey: string }
      weightedScore: number
      accounts: Account[]
    }>
    const { container } = render(
      <UnsafeAggregatedStats
        combinedPnl={100}
        bestRoi={{ value: 10, platform: 'exchange_0', traderKey: 'trader_0' }}
        weightedScore={80}
        accounts={[account(0), account(1)]}
      />
    )

    expect(screen.getByText('traderAggregateUnavailable')).toBeInTheDocument()
    for (const label of ['traderCombinedPnl', 'traderBestRoi', 'traderWeightedScore']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument()
    }
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument()
    expect(container.querySelector('.agg-stats-grid')).not.toBeInTheDocument()

    openComparison()
    expect(screen.queryByText('PnL', { selector: 'td' })).not.toBeInTheDocument()
    expect(screen.queryByText('Arena Score', { selector: 'td' })).not.toBeInTheDocument()
  })

  it('renders only available account-level evidence rows', () => {
    renderStats([
      account(0, { roi: 10_001, winRate: null, maxDrawdown: null }),
      account(1, { roi: null, winRate: null, maxDrawdown: null }),
    ])

    expect(screen.queryByRole('button', { name: 'traderCompareAccounts' })).not.toBeInTheDocument()
    expect(screen.queryByRole('table', { name: 'traderCompareAccounts' })).not.toBeInTheDocument()
  })

  it('exposes a reversible comparison disclosure', () => {
    renderStats([account(0), account(1)])

    expect(screen.getByText('traderAccountMetricsPartial')).toBeInTheDocument()

    const compare = screen.getByRole('button', { name: 'traderCompareAccounts' })
    expect(compare).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(compare)
    expect(compare).toHaveAttribute('aria-expanded', 'true')
    expect(document.getElementById(compare.getAttribute('aria-controls')!)).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'traderCompareAccounts' })).toBeInTheDocument()
    fireEvent.click(compare)
    expect(compare).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('table', { name: 'traderCompareAccounts' })).not.toBeInTheDocument()
  })
})
