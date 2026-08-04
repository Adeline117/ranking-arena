import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { User } from '@supabase/supabase-js'

const mockPush = jest.fn()
const mockShowToast = jest.fn()
const mockGetUser = jest.fn()
let mockSearchParams = new URLSearchParams()
let mockSelectedTrader = {
  handle: 'Alice Trader',
  source: 'binance',
  source_trader_id: 'account/42',
}

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => mockSearchParams,
}))

jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
      getUser: (...args: unknown[]) => mockGetUser(...args),
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
jest.mock('../components/DexVerifyForm', () => ({
  DexVerifyForm: () => <div>dex verify form</div>,
}))
jest.mock('../components/SearchSection', () => ({
  SearchSection: ({
    onSelect,
  }: {
    onSelect: (trader: { handle: string; source: string; source_trader_id: string }) => void
  }) => (
    <button type="button" onClick={() => onSelect(mockSelectedTrader)}>
      select trader
    </button>
  ),
}))

import ClaimPage from '../page'

describe('claim page login intent', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSearchParams = new URLSearchParams()
    mockSelectedTrader = {
      handle: 'Alice Trader',
      source: 'binance',
      source_trader_id: 'account/42',
    }
    mockGetUser.mockResolvedValue({ data: { user: null } })
  })

  it('shows an honest unsupported state for an anonymous CEX selection', async () => {
    render(<ClaimPage />)

    fireEvent.click(screen.getByRole('button', { name: 'select trader' }))

    expect(await screen.findByText('claimSourceUnsupportedTitle')).toBeInTheDocument()
    expect(mockPush).not.toHaveBeenCalled()
    expect(mockShowToast).not.toHaveBeenCalled()
  })

  it('waits for auth bootstrap before deciding whether a selection needs login', async () => {
    mockSelectedTrader = {
      handle: 'Wallet Trader',
      source: 'hyperliquid',
      source_trader_id: '0xabcdef0123456789abcdef0123456789abcdef01',
    }
    let resolveUser!: (value: { data: { user: User } }) => void
    mockGetUser.mockReturnValue(
      new Promise<{ data: { user: User } }>((resolve) => {
        resolveUser = resolve
      })
    )
    render(<ClaimPage />)

    fireEvent.click(screen.getByRole('button', { name: 'select trader' }))
    expect(mockPush).not.toHaveBeenCalled()

    resolveUser({ data: { user: { id: 'viewer-1' } as User } })

    expect(await screen.findByText('dex verify form')).toBeInTheDocument()
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('uses the wallet form only for a supported signature source', async () => {
    mockSearchParams = new URLSearchParams({
      trader: '0xabcdef0123456789abcdef0123456789abcdef01',
      source: 'hyperliquid',
      step: 'verify',
    })
    mockGetUser.mockResolvedValue({ data: { user: { id: 'viewer-1' } as User } })

    render(<ClaimPage />)

    expect(await screen.findByText('dex verify form')).toBeInTheDocument()
  })

  it('shows an honest unsupported state instead of falling through to API keys', async () => {
    mockSearchParams = new URLSearchParams({
      trader: 'stark-account-1',
      source: 'paradex',
      step: 'verify',
    })
    mockGetUser.mockResolvedValue({ data: { user: { id: 'viewer-1' } as User } })

    render(<ClaimPage />)

    expect(await screen.findByText('claimSourceUnsupportedTitle')).toBeInTheDocument()
    expect(screen.getByText('claimSourceUnsupportedBody')).toBeInTheDocument()
    expect(screen.queryByText('dex verify form')).not.toBeInTheDocument()
  })
})
