import { fireEvent, render, screen } from '@testing-library/react'
import ScoreMiniBar from '../ScoreMiniBar'
import { ScoreBreakdown } from '../ScoreBreakdown'
import { ScoreBreakdownTooltip } from '../ScoreBreakdownTooltip'
import { ArenaScoreBadge, ArenaScoreCircle, RankDisplay } from '../shared/TraderDisplay'
import type { Trader } from '../RankingTableTypes'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

function trader(overrides: Partial<Trader> = {}): Trader {
  return {
    id: 'score-boundary',
    handle: 'Score Boundary',
    roi: 12.5,
    followers: 0,
    arena_score: 75,
    ...overrides,
  }
}

describe('score presentation non-finite boundary', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'fails closed for %p in every standalone score visual',
    (score) => {
      const { container } = render(
        <>
          <ArenaScoreCircle score={score} />
          <ArenaScoreBadge score={score} />
          <ScoreMiniBar score={score} />
        </>
      )

      expect(container).toBeEmptyDOMElement()
      expect(container).not.toHaveTextContent('NaN')
      expect(container).not.toHaveTextContent('Infinity')
      expect(screen.queryByRole('img', { name: /arena score/i })).not.toBeInTheDocument()
    }
  )

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'does not leak a corrupt rank movement into visible or accessible copy for %p',
    (rankChange) => {
      const { container } = render(<RankDisplay rank={7} rankChange={rankChange} />)

      expect(container).toHaveTextContent('7')
      expect(container).not.toHaveTextContent('NaN')
      expect(container).not.toHaveTextContent('Infinity')
      expect(screen.queryByText(/Rank (up|down)/i)).not.toBeInTheDocument()
    }
  )

  it('does not leak non-finite raw metrics through a finite circle tooltip', () => {
    const { container } = render(
      <ArenaScoreCircle score={80} roi={12.5} pnl={Number.POSITIVE_INFINITY} />
    )

    fireEvent.mouseEnter(container.firstElementChild!)

    expect(screen.getByText('Arena Score')).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('NaN')
    expect(document.body).not.toHaveTextContent('Infinity')
  })

  it('does not open a breakdown trigger when every score field is non-finite', () => {
    const { container } = render(
      <ScoreBreakdownTooltip
        trader={trader({
          arena_score: Number.NaN,
          profitability_score: Number.POSITIVE_INFINITY,
          risk_control_score: Number.NEGATIVE_INFINITY,
          execution_score: Number.NaN,
        })}
        language="en"
      />
    )

    expect(container).toBeEmptyDOMElement()
  })

  it('renders unknown rather than non-finite score or metric text in a breakdown', () => {
    render(
      <ScoreBreakdownTooltip
        trader={trader({
          arena_score: 80,
          profitability_score: Number.NaN,
          risk_control_score: Number.POSITIVE_INFINITY,
          execution_score: Number.NEGATIVE_INFINITY,
          roi: Number.NaN,
          pnl: Number.POSITIVE_INFINITY,
          max_drawdown: Number.NaN,
          sharpe_ratio: Number.NEGATIVE_INFINITY,
          win_rate: Number.NaN,
        })}
        language="en"
      />
    )

    fireEvent.mouseEnter(screen.getByRole('button', { name: 'scoreBreakdownLabel' }))

    expect(screen.getByText('scoreBreakdownLabel')).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('NaN')
    expect(document.body).not.toHaveTextContent('Infinity')
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'does not draw a score-breakdown bar or radar value for %p',
    (score) => {
      const { container } = render(
        <ScoreBreakdown
          profitability_score={score}
          risk_control_score={score}
          execution_score={score}
          max_drawdown={score}
          win_rate={score}
          roi={score}
          arena_score={score}
          score_completeness="full"
        />
      )

      expect(container).toHaveTextContent('— / 100')
      expect(container.innerHTML).not.toMatch(/NaN|Infinity/)
      expect(container.querySelectorAll('.score-radar-data-shape')).toHaveLength(0)
      expect(container.querySelectorAll('.score-radar-data-point')).toHaveLength(0)
    }
  )
})
