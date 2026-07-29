import { act, render, screen } from '@testing-library/react'
import { getScoreColor, ScoreBar } from '../ScoreBar'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

describe('ScoreBar trusted score states', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    act(() => jest.runOnlyPendingTimers())
    jest.useRealTimers()
  })

  it.each([
    [0, '0.0', 0],
    [42.5, '42.5', 42.5],
    [100, '100.0', 100],
  ] as const)('renders valid score %p without losing exact zero', (score, display, width) => {
    render(<ScoreBar label="Profitability" score={score} maxScore={100} delay={0} />)

    act(() => jest.runOnlyPendingTimers())

    const progress = screen.getByRole('progressbar', { name: 'Profitability' })
    expect(screen.getByText(display)).toBeInTheDocument()
    expect(progress).toHaveAttribute('aria-valuenow', String(score))
    expect(progress).toHaveAttribute('aria-valuetext', `${display} / 100`)
    expect(progress.firstElementChild).toHaveStyle({ width: `${width}%` })
  })

  it.each([null, Number.NaN, Number.POSITIVE_INFINITY, -0.01, 100.01])(
    'renders invalid score %p as unknown',
    (score) => {
      render(<ScoreBar label="Risk" score={score} maxScore={100} delay={0} />)

      act(() => jest.runOnlyPendingTimers())

      const progress = screen.getByRole('progressbar', { name: 'Risk' })
      expect(screen.getByText('—')).toHaveStyle({ color: 'var(--color-text-tertiary)' })
      expect(progress).not.toHaveAttribute('aria-valuenow')
      expect(progress).toHaveAttribute('aria-valuetext', 'notAvailable')
      expect(progress.firstElementChild).toHaveStyle({ width: '0%' })
    }
  )

  it('treats an invalid scale as unknown', () => {
    render(<ScoreBar label="Risk" score={0} maxScore={0} delay={0} />)

    const progress = screen.getByRole('progressbar', { name: 'Risk' })
    expect(progress).not.toHaveAttribute('aria-valuemax')
    expect(progress).not.toHaveAttribute('aria-valuenow')
    expect(getScoreColor(0, 0)).toBe('var(--color-text-tertiary)')
  })
})
