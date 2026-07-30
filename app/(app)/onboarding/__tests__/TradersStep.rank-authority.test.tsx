import { render, screen } from '@testing-library/react'
import TradersStep from '../components/TradersStep'
import type { OnboardingTheme } from '../components/types'

const theme: OnboardingTheme = {
  isDark: true,
  cardBg: 'card',
  cardBorder: 'border',
  textPrimary: 'primary',
  textSecondary: '#123456',
  optionBg: 'option',
  optionBorder: 'option-border',
  selectedBg: 'selected',
  selectedBorder: 'selected-border',
  brandGradient: 'brand',
}

describe('TradersStep rank authority', () => {
  it('renders persisted ranks instead of recommendation positions', () => {
    render(
      <TradersStep
        theme={theme}
        language="en"
        traders={[
          {
            source: 'binance_futures',
            source_trader_id: 'one',
            handle: 'One',
            avatar_url: null,
            roi: 10,
            arena_score: 99,
            rank: 1,
          },
          {
            source: 'okx_futures',
            source_trader_id: 'twelve',
            handle: 'Twelve',
            avatar_url: null,
            roi: 8,
            arena_score: 95,
            rank: 12,
          },
          {
            source: 'binance_futures',
            source_trader_id: 'two',
            handle: 'Two',
            avatar_url: null,
            roi: 7,
            arena_score: 90,
            rank: 2,
          },
        ]}
        followedTraders={new Set()}
        loadingTraders={false}
        loadFailed={false}
        tr={(key) => key}
        onFollowTrader={jest.fn()}
        onRetry={jest.fn()}
        onBack={jest.fn()}
        onContinue={jest.fn()}
      />
    )

    expect(screen.getByText('#1')).toBeInTheDocument()
    expect(screen.getByText('#12')).toBeInTheDocument()
    expect(screen.getByText('#2')).toBeInTheDocument()
    expect(screen.queryByText('#3')).not.toBeInTheDocument()

    expect(screen.getByText('#1').style.color).toBe('var(--color-accent-warning)')
    expect(screen.getByText('#2').style.color).toBe('var(--color-text-tertiary)')
    expect(screen.getByText('#12').style.color).toBe('rgb(18, 52, 86)')
  })
})
