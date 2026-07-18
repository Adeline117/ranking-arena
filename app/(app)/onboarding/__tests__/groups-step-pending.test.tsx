import { render, screen } from '@testing-library/react'
import GroupsStep from '../components/GroupsStep'
import type { OnboardingTheme } from '../components/types'

const theme: OnboardingTheme = {
  brandGradient: 'linear-gradient(#000, #111)',
  cardBg: '#000',
  cardBorder: '#111',
  isDark: true,
  optionBg: '#111',
  optionBorder: '#222',
  selectedBg: '#333',
  selectedBorder: '#444',
  textPrimary: '#fff',
  textSecondary: '#aaa',
}

describe('onboarding groups pending state', () => {
  it('locks every conflicting action while completion is pending', () => {
    render(
      <GroupsStep
        theme={theme}
        language="en"
        groups={[
          {
            avatar_url: null,
            description: null,
            id: '20000000-0000-4000-8000-000000000002',
            member_count: 3,
            name: 'Test group',
            name_en: 'Test group',
          },
        ]}
        joinedGroups={new Set()}
        loadingGroups={false}
        loadFailed={false}
        saving
        tr={(key) => key}
        onJoinGroup={jest.fn()}
        onRetry={jest.fn()}
        onBack={jest.fn()}
        onComplete={jest.fn()}
      />
    )

    expect(screen.getByRole('button', { name: 'back' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'onboardingJoinBtn' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'skip' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'saving' })).toBeDisabled()
    expect(screen.getAllByRole('button', { busy: true })).toHaveLength(2)
  })
})
