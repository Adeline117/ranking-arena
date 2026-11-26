import { render, screen } from '@testing-library/react'
import { TraderHeaderBadges } from '../TraderHeaderBadges'

jest.mock(
  'next/dynamic',
  () => () => (props: { rank?: number }) =>
    props.rank != null ? <span data-testid="percentile-badge">{props.rank}</span> : null
)

const t = (key: string) => key

describe('TraderHeaderBadges score confidence', () => {
  it('preserves a trusted zero score and labels insufficient confidence explicitly', () => {
    render(<TraderHeaderBadges arenaScore={0} scoreConfidence="insufficient" t={t} />)

    expect(screen.getByText('0')).toBeInTheDocument()
    expect(screen.getByText('confidenceBadgeInsufficient').parentElement).toHaveAttribute(
      'title',
      'confidenceInsufficient'
    )
  })

  it('labels missing confidence as unknown when a score is present', () => {
    render(<TraderHeaderBadges arenaScore={50} scoreConfidence={null} t={t} />)

    expect(screen.getByText('confidenceBadgeUnknown').parentElement).toHaveAttribute(
      'title',
      'confidenceUnknown'
    )
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 100.01])(
    'does not render score or confidence badges for invalid score %p',
    (arenaScore) => {
      const { container } = render(
        <TraderHeaderBadges arenaScore={arenaScore} scoreConfidence="partial" t={t} />
      )

      expect(container).toBeEmptyDOMElement()
    }
  )
})

describe('TraderHeaderBadges cross-exchange percentile', () => {
  it('shows the 90D-denominator percentile for a 90D (or legacy default) rank', () => {
    const { rerender } = render(<TraderHeaderBadges rank={12} headlineWindow="90d" t={t} />)
    expect(screen.getByTestId('percentile-badge')).toHaveTextContent('12')
    rerender(<TraderHeaderBadges rank={12} t={t} />)
    expect(screen.getByTestId('percentile-badge')).toBeInTheDocument()
  })

  it.each(['7d', '30d'])('hides it when the rank comes from the %s board', (headlineWindow) => {
    render(<TraderHeaderBadges rank={12} headlineWindow={headlineWindow} t={t} />)
    expect(screen.queryByTestId('percentile-badge')).toBeNull()
  })
})

describe('TraderHeaderBadges idle window', () => {
  it('says there was no trading and shows no score, even if one is passed', () => {
    render(<TraderHeaderBadges idleWindow arenaScore={0.01} scoreConfidence="minimal" t={t} />)
    expect(screen.getByTestId('header-idle-window')).toHaveTextContent('noTradingThisPeriod')
    expect(screen.queryByText('<1')).toBeNull()
    expect(screen.queryByText(/confidenceBadge/)).toBeNull()
  })

  it('shows the score and no idle note for an account that traded', () => {
    render(<TraderHeaderBadges arenaScore={72} scoreConfidence="full" t={t} />)
    expect(screen.getByText('72')).toBeInTheDocument()
    expect(screen.queryByTestId('header-idle-window')).toBeNull()
  })
})
