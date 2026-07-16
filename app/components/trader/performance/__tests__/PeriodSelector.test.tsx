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
})
