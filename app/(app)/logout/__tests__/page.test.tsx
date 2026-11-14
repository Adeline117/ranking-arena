import { render, screen, waitFor } from '@testing-library/react'

const mockPush = jest.fn()
const mockSignOut = jest.fn()
const mockSignOutAndForgetAccounts = jest.fn()

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }))
jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => ({ signOut: mockSignOut }),
}))
jest.mock('@/lib/hooks/useMultiAccount', () => ({
  signOutAndForgetAccounts: (...args: unknown[]) => mockSignOutAndForgetAccounts(...args),
}))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => (key === 'signingOut' ? 'Signing out...' : key) }),
}))
jest.mock('@/lib/logger', () => ({ logger: { error: jest.fn() } }))

import LogoutPage from '../page'

describe('/logout', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSignOutAndForgetAccounts.mockResolvedValue(undefined)
  })

  it('forgets stored multi-account sessions instead of a bare sign-out', async () => {
    render(<LogoutPage />)

    expect(screen.getByText('Signing out...')).toBeInTheDocument()
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/login'))
    expect(mockSignOutAndForgetAccounts).toHaveBeenCalledWith(mockSignOut)
    expect(mockSignOut).not.toHaveBeenCalled()
  })
})
