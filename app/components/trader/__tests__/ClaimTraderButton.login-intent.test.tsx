import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

const mockPush = jest.fn()
const mockGetSession = jest.fn()
const mockShowToast = jest.fn()
const mockShowConfirm = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
    },
  },
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/app/components/ui/Dialog', () => ({
  useDialog: () => ({ showConfirm: mockShowConfirm }),
}))

jest.mock('@/app/components/base', () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children?: ReactNode
    disabled?: boolean
    onClick?: () => void
  }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}))

import ClaimTraderButton from '../ClaimTraderButton'

describe('ClaimTraderButton login intent', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ data: { session: null } })
    mockShowConfirm.mockResolvedValue(true)
  })

  it('does not send a signed-out CEX claimant back to the trader page or homepage', async () => {
    render(
      <ClaimTraderButton
        traderId="account/42"
        handle="Alice Trader"
        userId="stale-viewer"
        source="binance"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'claimTrader' }))

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith(
        '/login?returnUrl=%2Fclaim%3Ftrader%3Daccount%252F42%26source%3Dbinance%26handle%3DAlice%2BTrader%26step%3Dverify'
      )
    )
    expect(mockShowToast).toHaveBeenCalledWith('pleaseLoginFirst', 'warning')
  })

  it('uses the same exact login handoff for a signed-out wallet claim', async () => {
    render(
      <ClaimTraderButton
        traderId="0xabc"
        handle="Wallet Trader"
        userId="stale-viewer"
        source="hyperliquid"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'claimTrader' }))

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith(
        '/login?returnUrl=%2Fclaim%3Ftrader%3D0xabc%26source%3Dhyperliquid%26handle%3DWallet%2BTrader%26step%3Dverify'
      )
    )
  })
})
