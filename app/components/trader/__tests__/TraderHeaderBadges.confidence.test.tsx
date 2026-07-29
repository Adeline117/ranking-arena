import { render, screen } from '@testing-library/react'
import { TraderHeaderBadges } from '../TraderHeaderBadges'

jest.mock('next/dynamic', () => () => () => null)

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
