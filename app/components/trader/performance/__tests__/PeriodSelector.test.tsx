import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
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

  it('disables source-declared absent periods and explains the authority verdict', () => {
    const onPeriodChange = jest.fn()
    render(
      <PeriodSelector
        period="30D"
        onPeriodChange={onPeriodChange}
        availability={{ '7D': 'absent', '30D': 'native', '90D': 'absent' }}
      />
    )

    const unavailableSevenDay = screen.getByRole('button', { name: '7D period' })
    const availableThirtyDay = screen.getByRole('button', { name: '30D period' })
    const unavailableNinetyDay = screen.getByRole('button', { name: '90D period' })

    expect(unavailableSevenDay).toBeDisabled()
    expect(unavailableSevenDay).toHaveAttribute('title', 'tfNotProvided')
    expect(availableThirtyDay).not.toBeDisabled()
    expect(unavailableNinetyDay).toBeDisabled()

    fireEvent.click(unavailableSevenDay)
    fireEvent.click(availableThirtyDay)

    expect(onPeriodChange).toHaveBeenCalledTimes(1)
    expect(onPeriodChange).toHaveBeenCalledWith('30D')
  })
})
