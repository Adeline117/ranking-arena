import { fireEvent, render, screen, within } from '@testing-library/react'
import { tokens } from '@/lib/design-tokens'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))
jest.mock('@/app/components/ui/ExchangeLogo', () => ({
  __esModule: true,
  default: ({ exchange }: { exchange: string }) => <span data-exchange={exchange} />,
}))
jest.mock('@/app/components/base', () => {
  const React = jest.requireActual<typeof import('react')>('react')
  return {
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
  }
})

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
}

function account(index: number, overrides: Partial<Account> = {}): Account {
  return {
    platform: `exchange_${index}`,
    traderKey: `trader_${index}`,
    handle: `Trader ${index}`,
    label: `Account ${index}`,
    roi: 10,
    pnl: 100,
    arenaScore: 50,
    winRate: 50,
    maxDrawdown: 10,
    ...overrides,
  }
}

function renderStats(
  accounts: Account[],
  overrides: Partial<React.ComponentProps<typeof AggregatedStats>> = {}
) {
  return render(
    <AggregatedStats
      combinedPnl={100}
      bestRoi={{ value: 10, platform: 'exchange_0', traderKey: 'trader_0' }}
      weightedScore={50}
      accounts={accounts}
      {...overrides}
    />
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

    const cells = comparisonValues('maxDrawdown')
    expect(cells[0]).toHaveTextContent('-20.0%')
    expect(cells[1]).toHaveTextContent('-5.0%')
    expect(cells[2]).toHaveTextContent('0.0%')
    expect(cells[2]).toHaveStyle({ color: tokens.colors.text.tertiary })
    expect(within(cells[2]).getByText('compareBestValue')).toBeInTheDocument()
    for (const cell of cells.slice(3)) {
      expect(cell).toHaveTextContent('—')
      expect(within(cell).queryByText('compareBestValue')).not.toBeInTheDocument()
    }
  })

  it('uses normalized magnitude for best value and does not select tied values', () => {
    const { rerender } = renderStats([
      account(0, { maxDrawdown: -20 }),
      account(1, { maxDrawdown: 5 }),
    ])
    openComparison()

    let cells = comparisonValues('maxDrawdown')
    expect(within(cells[0]).queryByText('compareBestValue')).not.toBeInTheDocument()
    expect(within(cells[1]).getByText('compareBestValue')).toBeInTheDocument()

    rerender(
      <AggregatedStats
        combinedPnl={100}
        bestRoi={null}
        weightedScore={50}
        accounts={[account(0, { maxDrawdown: -100 }), account(1, { maxDrawdown: 100 })]}
      />
    )

    cells = comparisonValues('maxDrawdown')
    expect(cells[0]).toHaveTextContent('-100.0%')
    expect(cells[1]).toHaveTextContent('-100.0%')
    for (const cell of cells) {
      expect(within(cell).queryByText('compareBestValue')).not.toBeInTheDocument()
    }
  })

  it('fails closed for invalid score, win-rate, ROI, PnL, and summary inputs', () => {
    const { container } = renderStats(
      [
        account(0, {
          roi: Number.POSITIVE_INFINITY,
          pnl: null,
          arenaScore: 101,
          winRate: -1,
        }),
        account(1, { roi: 5, pnl: 10, arenaScore: 50, winRate: 60 }),
      ],
      {
        combinedPnl: Number.NaN,
        bestRoi: {
          value: Number.POSITIVE_INFINITY,
          platform: 'exchange_0',
          traderKey: 'trader_0',
        },
        weightedScore: 100.001,
      }
    )

    const summary = container.querySelector('.agg-stats-grid')!
    expect(within(summary).getAllByText('—')).toHaveLength(3)
    expect(screen.queryByText('+$0.00')).not.toBeInTheDocument()

    openComparison()
    for (const label of ['ROI', 'PnL', 'Arena Score', 'winRate']) {
      expect(comparisonValues(label)[0]).toHaveTextContent('—')
    }
  })

  it('exposes reversible tooltip and comparison disclosure states', () => {
    renderStats([account(0), account(1)])

    const info = screen.getByRole('button', { name: 'traderWeightedScore' })

    fireEvent.click(info)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    fireEvent.click(info)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    fireEvent.mouseEnter(info)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    fireEvent.mouseLeave(info)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    fireEvent.focus(info)
    let tooltip = screen.getByRole('tooltip')
    expect(info).toHaveAttribute('aria-expanded', 'true')
    expect(info).toHaveAttribute('aria-describedby', tooltip.id)
    fireEvent.blur(info)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    fireEvent.focus(info)
    tooltip = screen.getByRole('tooltip')
    expect(info).toHaveAttribute('aria-describedby', tooltip.id)
    fireEvent.keyDown(info, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    const compare = screen.getByRole('button', { name: 'traderCompareAccounts' })
    expect(compare).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(compare)
    expect(compare).toHaveAttribute('aria-expanded', 'true')
    expect(document.getElementById(compare.getAttribute('aria-controls')!)).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'traderCompareAccounts' })).toBeInTheDocument()
  })
})
