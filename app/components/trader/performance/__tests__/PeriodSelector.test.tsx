import React from 'react'
import { render, screen } from '@testing-library/react'
import { PeriodSelector } from '../PeriodSelector'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))

describe('PeriodSelector source semantics', () => {
  beforeAll(() => {
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: jest.fn(() => 1),
    })
    Object.defineProperty(window, 'cancelAnimationFrame', {
      configurable: true,
      value: jest.fn(),
    })
  })

  it.each(['30D', '90D'] as const)(
    'does not mislabel the exact GMX %s window as cumulative',
    (period) => {
      render(<PeriodSelector period={period} onPeriodChange={jest.fn()} source="gmx" />)

      expect(screen.queryByText('cumulativeRoiLabel')).not.toBeInTheDocument()
    }
  )

  it('retains the cumulative warning for a source that still returns cumulative ROI', () => {
    render(<PeriodSelector period="30D" onPeriodChange={jest.fn()} source="bybit" />)

    expect(screen.getByText('cumulativeRoiLabel')).toBeInTheDocument()
  })

  describe('updated time', () => {
    beforeEach(() => jest.useFakeTimers({ now: Date.parse('2026-11-11T12:00:00.000Z') }))
    afterEach(() => jest.useRealTimers())

    it('keeps the date of an old source time and flags it as possibly delayed', () => {
      render(
        <PeriodSelector
          period="90D"
          onPeriodChange={jest.fn()}
          source="bybit"
          lastUpdated="2026-08-16T09:30:00.000Z"
        />
      )
      const time = document.querySelector('time')
      expect(time).toHaveAttribute('dateTime', '2026-08-16T09:30:00.000Z')
      expect(time?.textContent).toMatch(/Aug 1[56]/)
      expect(screen.getByTestId('period-data-stale')).toHaveTextContent('dataStaleWarning')
    })

    it('does not flag a recent source time', () => {
      render(
        <PeriodSelector
          period="90D"
          onPeriodChange={jest.fn()}
          source="bybit"
          lastUpdated="2026-11-11T11:00:00.000Z"
        />
      )
      expect(document.querySelector('time')).toBeInTheDocument()
      expect(screen.queryByTestId('period-data-stale')).not.toBeInTheDocument()
    })

    it('hides the label for the epoch unknown sentinel', () => {
      render(
        <PeriodSelector
          period="90D"
          onPeriodChange={jest.fn()}
          source="bybit"
          lastUpdated="1970-01-01T00:00:00.000Z"
        />
      )
      expect(screen.queryByText(/updatedAt/)).not.toBeInTheDocument()
    })
  })
})
