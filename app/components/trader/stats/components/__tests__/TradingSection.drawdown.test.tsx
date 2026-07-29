import { render, screen, within } from '@testing-library/react'
import { TradingSection } from '../TradingSection'

jest.mock('../PositionHistorySection', () => ({
  PositionHistorySection: () => null,
}))

const t = (key: string) => key

function section(maxDrawdown: number) {
  return (
    <TradingSection
      trading={undefined}
      additionalStats={{ maxDrawdown }}
      positionHistory={[]}
      t={t}
      delay={0}
    />
  )
}

function drawdownCard() {
  const card = screen.getByText('maxDrawdown').closest('.metric-item')
  if (!card) throw new Error('drawdown card missing')
  return card as HTMLElement
}

describe('TradingSection drawdown trust states', () => {
  it('keeps a measured zero neutral while marking non-zero drawdown as negative', () => {
    const { rerender } = render(section(0))

    let card = drawdownCard()
    expect(within(card).getByText('0.0%')).toHaveStyle({ color: 'var(--color-text-primary)' })

    rerender(section(0.01))

    card = drawdownCard()
    expect(within(card).getByText('< 0.1%')).toHaveStyle({ color: 'var(--color-accent-error)' })

    rerender(section(12.34))

    card = drawdownCard()
    expect(within(card).getByText('-12.3%')).toHaveStyle({ color: 'var(--color-accent-error)' })
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 100.01])(
    'renders invalid drawdown %p as unknown and neutral',
    (maxDrawdown) => {
      render(section(maxDrawdown))

      const card = drawdownCard()
      expect(within(card).getByText('—')).toHaveStyle({ color: 'var(--color-text-tertiary)' })
    }
  )
})
