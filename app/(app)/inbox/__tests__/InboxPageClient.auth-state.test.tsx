import { render, screen } from '@testing-library/react'

const mockAuthState = {
  isLoading: true,
  isLoggedIn: false,
}
const mockSearchParams = new URLSearchParams()

jest.mock('next/navigation', () => ({
  redirect: jest.fn(),
  useSearchParams: () => mockSearchParams,
}))

jest.mock('@/lib/hooks/useRequireAuth', () => ({
  useRequireAuth: () => mockAuthState,
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/app/components/ui/PageSkeleton', () => ({
  NotificationsPageSkeleton: () => <div>Inbox skeleton</div>,
}))

jest.mock('@/app/components/inbox/NotificationsList', () => ({
  __esModule: true,
  default: () => <div>Notifications content</div>,
}))

jest.mock('@/app/components/inbox/ConversationsList', () => ({
  __esModule: true,
  default: () => <div>Conversations content</div>,
}))

import InboxPageClient from '../InboxPageClient'

describe('InboxPageClient auth restoration', () => {
  it('keeps the skeleton while auth is restoring', () => {
    mockAuthState.isLoading = true
    mockAuthState.isLoggedIn = false

    render(<InboxPageClient />)

    expect(screen.getByText('Inbox skeleton')).toBeInTheDocument()
    expect(screen.queryByText('Notifications content')).not.toBeInTheDocument()
  })

  it('does not flash an empty inbox while redirecting a signed-out viewer', () => {
    mockAuthState.isLoading = false
    mockAuthState.isLoggedIn = false

    render(<InboxPageClient />)

    expect(screen.getByText('Inbox skeleton')).toBeInTheDocument()
    expect(screen.queryByText('Notifications content')).not.toBeInTheDocument()
  })

  it('renders inbox content only after authentication is confirmed', () => {
    mockAuthState.isLoading = false
    mockAuthState.isLoggedIn = true

    render(<InboxPageClient />)

    expect(screen.getByText('Notifications content')).toBeInTheDocument()
    expect(screen.queryByText('Inbox skeleton')).not.toBeInTheDocument()
  })
})
