import { render, screen, within } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ScoreBreakdownSection } from '../ScoreBreakdownSection'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/app/components/ranking/ScoreRadar', () => ({
  ScoreRadar: ({
    profitability,
    riskControl,
    arenaScore,
  }: {
    profitability: number | null
    riskControl: number | null
    arenaScore: number | null
  }) => (
    <div
      data-testid="score-radar"
      data-profitability={profitability == null ? 'unknown' : String(profitability)}
      data-risk={riskControl == null ? 'unknown' : String(riskControl)}
      data-arena={arenaScore == null ? 'unknown' : String(arenaScore)}
    />
  ),
}))

function section(overrides: Partial<React.ComponentProps<typeof ScoreBreakdownSection>> = {}) {
  return (
    <ScoreBreakdownSection
      periodArenaScore={undefined}
      periodProfitabilityScore={undefined}
      periodRiskControlScore={undefined}
      arenaScoreV3={undefined}
      scoreConfidence={null}
      {...overrides}
    />
  )
}

describe('ScoreBreakdownSection trusted score states', () => {
  it('renders a risk-only measured zero without fabricating profitability', () => {
    render(section({ periodRiskControlScore: 0 }))

    expect(screen.getByRole('progressbar', { name: 'scoreRisk' })).toHaveAttribute(
      'aria-valuenow',
      '0'
    )
    expect(screen.getByRole('progressbar', { name: 'scoreProfit' })).not.toHaveAttribute(
      'aria-valuenow'
    )
    expect(screen.getByTestId('score-radar')).toHaveAttribute('data-profitability', 'unknown')
    expect(screen.getByTestId('score-radar')).toHaveAttribute('data-risk', '0')
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.01, 100.01])(
    'hides an otherwise empty section for invalid score %p',
    (score) => {
      const { container } = render(section({ periodProfitabilityScore: score }))

      expect(container).toBeEmptyDOMElement()
    }
  )

  it('prefers the current-period Arena Score over the compatibility score', () => {
    render(section({ arenaScoreV3: 0, periodArenaScore: 55 }))

    const badge = screen.getByText('arenaScore').parentElement
    if (!badge) throw new Error('Arena Score badge missing')
    expect(screen.queryByText('V3')).not.toBeInTheDocument()
    expect(within(badge).getByText('55')).toHaveStyle({ color: 'var(--color-score-average)' })
    expect(screen.getByTestId('score-radar')).toHaveAttribute('data-arena', '55')
  })

  it('uses a trusted compatibility zero only when the current-period total is missing', () => {
    render(section({ arenaScoreV3: 0, periodArenaScore: undefined }))

    const badge = screen.getByText('arenaScore').parentElement
    if (!badge) throw new Error('Arena Score badge missing')
    expect(within(badge).getByText('0')).toHaveStyle({ color: 'var(--color-score-low)' })
    expect(screen.getByTestId('score-radar')).toHaveAttribute('data-arena', '0')
  })

  it('does not mask an invalid current-period total with the compatibility score', () => {
    const { container } = render(section({ arenaScoreV3: 55, periodArenaScore: Number.NaN }))

    expect(container).toBeEmptyDOMElement()
  })

  it.each([
    ['partial', 'confidencePartial'],
    ['minimal', 'confidenceMinimal'],
    ['insufficient', 'confidenceInsufficient'],
    [null, 'confidenceUnknown'],
  ] as const)('discloses %p confidence for the rendered period', (confidence, message) => {
    render(section({ periodArenaScore: 50, scoreConfidence: confidence }))

    expect(screen.getByRole('status')).toHaveTextContent(message)
  })

  it('does not show a confidence warning for full inputs', () => {
    render(section({ periodArenaScore: 50, scoreConfidence: 'full' }))

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('exposes the score guide to keyboard and assistive-technology users', () => {
    render(section({ periodArenaScore: 50, scoreConfidence: 'full' }))

    const trigger = screen.getByRole('button', { name: 'scoreGuide' })
    const tooltip = screen.getByRole('tooltip', { hidden: true })
    expect(trigger).toHaveAttribute('aria-describedby', tooltip.id)
    expect(tooltip).toHaveTextContent('scoreGuideDetail')
  })

  it('keeps score text readable in the server first paint', () => {
    const markup = renderToStaticMarkup(
      section({
        periodArenaScore: 58,
        periodProfitabilityScore: 63,
        periodRiskControlScore: 47,
        scoreConfidence: 'full',
      })
    )
    const sectionStyle = markup.match(/^<div style="([^"]*)"/)?.[1]

    expect(markup).toContain('scoreBreakdown')
    expect(markup).toContain('58')
    expect(sectionStyle).toBeDefined()
    expect(sectionStyle).not.toContain('opacity')
    expect(sectionStyle).not.toContain('transition')
  })
})
