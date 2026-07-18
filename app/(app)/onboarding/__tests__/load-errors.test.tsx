import { fireEvent, render, screen } from '@testing-library/react'
import GroupsStep from '../components/GroupsStep'
import TradersStep from '../components/TradersStep'
import type { OnboardingTheme } from '../components/types'

const theme: OnboardingTheme = {
  isDark: true,
  cardBg: 'card',
  cardBorder: 'border',
  textPrimary: 'primary',
  textSecondary: 'secondary',
  optionBg: 'option',
  optionBorder: 'option-border',
  selectedBg: 'selected',
  selectedBorder: 'selected-border',
  brandGradient: 'brand',
}

const translations: Record<string, string> = {
  back: 'Back',
  continueButton: 'Continue',
  loadFailedRetryMsg: 'Failed to load, please try again',
  noDataShort: 'No data',
  noGroupsYet: 'No groups',
  onboardingFollowDesc: 'Follow traders',
  onboardingFollowTitle: 'Traders',
  onboardingGroupDesc: 'Join groups',
  onboardingGroupTitle: 'Groups',
  retryButton: 'Retry',
  saving: 'Saving',
  skip: 'Skip',
}

const tr = (key: string) => translations[key] || key

describe('onboarding discovery error states', () => {
  it('shows a retryable trader error instead of the no-data state', () => {
    const onRetry = jest.fn()
    render(
      <TradersStep
        theme={theme}
        language="en"
        traders={[]}
        followedTraders={new Set()}
        loadingTraders={false}
        loadFailed
        tr={tr}
        onFollowTrader={jest.fn()}
        onRetry={onRetry}
        onBack={jest.fn()}
        onContinue={jest.fn()}
      />
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load, please try again')
    expect(screen.queryByText('No data')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('shows a retryable group error instead of the no-groups state', () => {
    const onRetry = jest.fn()
    render(
      <GroupsStep
        theme={theme}
        language="en"
        groups={[]}
        joinedGroups={new Set()}
        loadingGroups={false}
        loadFailed
        saving={false}
        tr={tr}
        onJoinGroup={jest.fn()}
        onRetry={onRetry}
        onBack={jest.fn()}
        onComplete={jest.fn()}
      />
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load, please try again')
    expect(screen.queryByText('No groups')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})
