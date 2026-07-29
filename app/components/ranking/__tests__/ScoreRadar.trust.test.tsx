import { render, screen } from '@testing-library/react'
import { ScoreRadar } from '../ScoreRadar'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      key === 'scoreRadarAria'
        ? 'Score radar: {profitLabel} {profit}/100, {riskLabel} {risk}/100'
        : key,
  }),
}))

describe('ScoreRadar trusted score states', () => {
  it('keeps a measured zero point but does not draw unknown as zero', () => {
    const { container } = render(
      <ScoreRadar profitability={0} riskControl={null} arenaScore={null} />
    )

    expect(screen.getByRole('img')).toHaveAttribute(
      'aria-label',
      'Score radar: scoreRadarProfit 0/100, scoreRadarRisk —/100'
    )
    expect(container.querySelector('.score-radar-data-shape')).not.toBeInTheDocument()
    expect(container.querySelectorAll('.score-radar-data-point')).toHaveLength(1)
    expect(container.querySelector('.score-radar-data-point')).toHaveAttribute(
      'fill',
      'var(--color-text-tertiary)'
    )
  })

  it('draws the complete shape when both axes are trusted zeroes', () => {
    const { container } = render(<ScoreRadar profitability={0} riskControl={-0} arenaScore={0} />)

    expect(container.querySelector('.score-radar-data-shape')).toBeInTheDocument()
    expect(container.querySelectorAll('.score-radar-data-point')).toHaveLength(2)
    expect(screen.getByRole('img')).toHaveAttribute(
      'aria-label',
      'Score radar: scoreRadarProfit 0/100, scoreRadarRisk 0/100'
    )
  })

  it('rejects non-finite and out-of-range axes instead of clamping them', () => {
    const { container } = render(
      <ScoreRadar
        profitability={100.01}
        riskControl={Number.NaN}
        arenaScore={Number.POSITIVE_INFINITY}
      />
    )

    expect(container.querySelector('.score-radar-data-shape')).not.toBeInTheDocument()
    expect(container.querySelectorAll('.score-radar-data-point')).toHaveLength(0)
    expect(screen.getByRole('img')).toHaveAttribute(
      'aria-label',
      'Score radar: scoreRadarProfit —/100, scoreRadarRisk —/100'
    )
  })
})
