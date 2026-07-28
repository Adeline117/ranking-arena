import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'

const mockLoadProfile = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
}))

jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: () =>
    function MockDynamicComponent() {
      return null
    },
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: jest.fn() }),
}))

jest.mock('@/app/components/ui/Dialog', () => ({
  useDialog: () => ({ showConfirm: jest.fn() }),
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => ({
    authChecked: true,
    loading: false,
    userId: 'user-a',
    sessionGeneration: 1,
  }),
}))

jest.mock('../hooks/useActiveSection', () => ({
  useActiveSection: () => ({ activeSection: 'profile', scrollToSection: jest.fn() }),
}))

jest.mock('../hooks/useSettingsHandlers', () => ({
  useSettingsHandlers: () => ({
    loading: false,
    userId: 'user-a',
    profileLoadFailed: true,
    loadProfile: mockLoadProfile,
    hasUnsavedChanges: () => false,
    loadBlockedUsers: jest.fn(),
    loadPasskeys: jest.fn(),
    loadSessions: jest.fn(),
    loadingBlockedUsers: false,
    loadingPasskeys: false,
    loadingSessions: false,
  }),
}))

jest.mock('@/app/components/base', () => ({
  Box: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  Text: ({ children, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
    <span {...props}>{children}</span>
  ),
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}))

jest.mock('@/app/components/ui/PageHeader', () => ({
  __esModule: true,
  default: ({ title }: { title: string }) => <h1>{title}</h1>,
}))

jest.mock('@/app/components/ui/ErrorState', () => ({
  __esModule: true,
  default: ({ description, retry }: { description: string; retry: () => void }) => (
    <section role="alert">
      <p>{description}</p>
      <button onClick={retry}>retry</button>
    </section>
  ),
}))

jest.mock('../components', () => ({
  SECTION_IDS: ['profile'],
  SECTION_ICONS: { profile: null },
  SECTION_KEYS: { profile: 'profileSection' },
  SectionCard: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  ProfileSection: () => <div data-testid="profile-section" />,
  SecuritySection: () => null,
  NotificationsSection: () => null,
  PrivacySection: () => null,
  AccountSection: () => null,
  DeleteAccountModal: () => null,
  TraderLinksSection: () => null,
  ExchangeBindingBanner: () => null,
}))

jest.mock('../components/ApiKeysSection', () => ({ ApiKeysSection: () => null }))
jest.mock('@/app/components/alerts/TraderAlertsManager', () => () => null)
jest.mock('@/lib/logger', () => ({ logger: { error: jest.fn() } }))

import { SettingsContent } from '../page'

describe('Settings profile initialization failure', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('hides editable defaults and exposes an in-place retry', () => {
    render(<SettingsContent />)

    expect(screen.getByRole('alert')).toHaveTextContent('loadFailedRetryShort')
    expect(screen.queryByTestId('profile-section')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    expect(mockLoadProfile).toHaveBeenCalledTimes(1)
  })
})
