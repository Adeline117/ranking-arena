import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'

const mockPush = jest.fn()
const mockShowToast = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => new URLSearchParams(),
}))

jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
      getUser: jest.fn().mockResolvedValue({ data: { user: null } }),
    },
  },
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/app/components/base', () => ({
  Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}))

jest.mock('../components/HeroSection', () => ({ HeroSection: () => null }))
jest.mock('../components/BenefitsSection', () => ({ BenefitsSection: () => null }))
jest.mock('../components/FaqSection', () => ({ FaqSection: () => null }))
jest.mock('../components/LinkedAccountsSidebar', () => ({ LinkedAccountsSidebar: () => null }))
jest.mock('../components/CexVerifyForm', () => ({ CexVerifyForm: () => null }))
jest.mock('../components/DexVerifyForm', () => ({ DexVerifyForm: () => null }))
jest.mock('../components/SearchSection', () => ({
  SearchSection: ({
    onSelect,
  }: {
    onSelect: (trader: { handle: string; source: string; source_trader_id: string }) => void
  }) => (
    <button
      type="button"
      onClick={() =>
        onSelect({
          handle: 'Alice Trader',
          source: 'binance',
          source_trader_id: 'account/42',
        })
      }
    >
      select trader
    </button>
  ),
}))

import ClaimPage from '../page'

describe('claim page login intent', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('carries an anonymous search selection through login to verification', () => {
    render(<ClaimPage />)

    fireEvent.click(screen.getByRole('button', { name: 'select trader' }))

    expect(mockPush).toHaveBeenCalledWith(
      '/login?returnUrl=%2Fclaim%3Ftrader%3Daccount%252F42%26source%3Dbinance%26handle%3DAlice%2BTrader%26step%3Dverify'
    )
    expect(mockShowToast).toHaveBeenCalledWith('pleaseLoginFirst', 'warning')
  })
})
