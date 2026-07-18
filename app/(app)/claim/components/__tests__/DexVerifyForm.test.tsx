import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

const mockGetSession = jest.fn()
const mockShowToast = jest.fn()
const mockTrackEvent = jest.fn()
const mockPush = jest.fn()

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

jest.mock('@/lib/api/client', () => ({
  getCsrfHeaders: () => ({ 'x-csrf-token': 'csrf-token' }),
}))

jest.mock('@/lib/analytics/track', () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}))

jest.mock('@/app/components/base', () => ({
  Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}))

import { DexVerifyForm } from '../DexVerifyForm'

const originalFetch = global.fetch
const checksumWallet = '0xAbCdEf0123456789aBCdEf0123456789AbCdEf01'

describe('DexVerifyForm proof submission', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: 'access-token' } },
    })
    Object.defineProperty(window, 'ethereum', {
      configurable: true,
      value: {
        request: jest.fn(({ method }: { method: string }) => {
          if (method === 'eth_requestAccounts') return Promise.resolve([checksumWallet])
          if (method === 'personal_sign') return Promise.resolve('0xsigned-proof')
          return Promise.reject(new Error(`Unexpected wallet method: ${method}`))
        }),
      },
    })
  })

  afterAll(() => {
    global.fetch = originalFetch
  })

  it('submits a signed proof exactly once through the atomic claim endpoint', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { claim: { status: 'reviewing' }, auto_approved: false },
      }),
    })
    global.fetch = fetchMock as typeof fetch
    const onSuccess = jest.fn()

    render(
      <DexVerifyForm
        trader={{
          handle: 'Wallet Trader',
          source: 'hyperliquid',
          source_trader_id: checksumWallet.toLowerCase(),
        }}
        onSuccess={onSuccess}
      />
    )

    const timeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementationOnce(() => 0 as never)
    fireEvent.click(screen.getByRole('button', { name: 'claimWalletSignMessage' }))
    timeoutSpy.mockRestore()

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/traders/claim',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer access-token',
          'x-csrf-token': 'csrf-token',
        }),
      })
    )

    const request = fetchMock.mock.calls[0][1] as RequestInit
    expect(JSON.parse(String(request.body))).toMatchObject({
      trader_id: checksumWallet.toLowerCase(),
      source: 'hyperliquid',
      verification_method: 'signature',
      verification_data: {
        wallet_address: checksumWallet,
        signature: '0xsigned-proof',
      },
    })
    expect(mockShowToast).toHaveBeenCalledWith('claimSubmitted', 'success')
    expect(mockTrackEvent).toHaveBeenCalledWith('claim_trader', { method: 'dex_wallet' })
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/traders/claim/verify-wallet')).toBe(
      false
    )
  })

  it('returns an expired claim to the exact wallet verification flow', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Unauthorized' }),
    }) as typeof fetch

    render(
      <DexVerifyForm
        trader={{
          handle: 'Wallet Trader',
          source: 'hyperliquid',
          source_trader_id: checksumWallet.toLowerCase(),
        }}
        onSuccess={jest.fn()}
      />
    )

    const timeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementationOnce(() => 0 as never)
    fireEvent.click(screen.getByRole('button', { name: 'claimWalletSignMessage' }))
    timeoutSpy.mockRestore()

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith(
        `/login?returnUrl=${encodeURIComponent(
          `/claim?trader=${encodeURIComponent(checksumWallet.toLowerCase())}&source=hyperliquid&handle=Wallet+Trader&step=verify`
        )}`
      )
    )
    expect(mockShowToast).toHaveBeenCalledWith('loginExpiredPleaseRelogin', 'error')
  })
})
