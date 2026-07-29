import { render, screen } from '@testing-library/react'
import { SnapshotCard } from '../TraderPageV2'
import type { SnapshotMetrics } from '@/lib/types/trading-platform'

jest.mock('next/dynamic', () => () => () => null)

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

function metrics(maxDrawdown: number | null): SnapshotMetrics {
  return {
    roi: 10,
    pnl: 100,
    win_rate: null,
    max_drawdown: maxDrawdown,
    trades_count: null,
    followers: null,
    copiers: null,
    aum: null,
    sharpe_ratio: null,
    arena_score: null,
    return_score: null,
    drawdown_score: null,
    stability_score: null,
    rank: null,
  }
}

function drawdownValue() {
  const row = screen.getByText('mddLabel').parentElement
  if (!row) throw new Error('drawdown row missing')
  const value = row.querySelector('span:last-child')
  if (!value) throw new Error('drawdown value missing')
  return value
}

describe('TraderPageV2 snapshot drawdown trust states', () => {
  it.each([
    [0, '0.0%', 'var(--color-text-primary)'],
    [-0, '0.0%', 'var(--color-text-primary)'],
    [0.01, '< 0.1%', 'var(--color-accent-error)'],
    [12.34, '-12.3%', 'var(--color-accent-error)'],
  ] as const)('renders measured drawdown %p as %s', (maxDrawdown, display, color) => {
    render(<SnapshotCard window="30D" metrics={metrics(maxDrawdown)} />)

    expect(drawdownValue()).toHaveTextContent(display)
    expect(drawdownValue()).toHaveStyle({ color })
  })

  it.each([null, Number.NaN, Number.POSITIVE_INFINITY, 100.01])(
    'renders invalid drawdown %p as unknown',
    (maxDrawdown) => {
      render(<SnapshotCard window="30D" metrics={metrics(maxDrawdown)} />)

      expect(drawdownValue()).toHaveTextContent('—')
      expect(drawdownValue()).toHaveStyle({ color: 'var(--color-text-tertiary)' })
    }
  )
})
