import { render, screen, within } from '@testing-library/react'
import { MetricBadgesGrid } from '../MetricBadgesGrid'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/app/components/ranking/AntiGamingBadge', () => ({
  __esModule: true,
  default: () => null,
}))

function grid(maxDrawdown: number | undefined) {
  return (
    <MetricBadgesGrid
      sharpeRatio={undefined}
      maxDrawdown={maxDrawdown}
      winRate={undefined}
      winningPositions={undefined}
      totalPositions={undefined}
      sortinoRatio={undefined}
      calmarRatio={undefined}
      alpha={undefined}
      tradesCount={undefined}
      avgHoldingTimeHours={undefined}
      isVisible
    />
  )
}

function drawdownBadge() {
  const badge = screen.getByText('maxDrawdownShort').parentElement
  if (!badge) throw new Error('drawdown badge missing')
  return badge
}

describe('MetricBadgesGrid drawdown trust states', () => {
  it('keeps a measured zero neutral while marking non-zero drawdown as negative', () => {
    const { rerender } = render(grid(0))

    let badge = drawdownBadge()
    expect(within(badge).getByText('0.0%')).toHaveStyle({ color: 'var(--color-text-primary)' })
    expect(badge).toHaveAttribute('title', 'mddTooltip')

    rerender(grid(0.01))

    badge = drawdownBadge()
    expect(within(badge).getByText('< 0.1%')).toHaveStyle({ color: 'var(--color-accent-error)' })

    rerender(grid(12.34))

    badge = drawdownBadge()
    expect(within(badge).getByText('-12.3%')).toHaveStyle({ color: 'var(--color-accent-error)' })
  })

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, 100.01])(
    'renders invalid drawdown %p as unknown and neutral',
    (maxDrawdown) => {
      render(grid(maxDrawdown))

      const badge = drawdownBadge()
      expect(within(badge).getByText('--')).toHaveStyle({ color: 'var(--color-text-tertiary)' })
      expect(badge).toHaveAttribute('title', 'drawdownNotAvailable')
    }
  )
})
