import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { InputHTMLAttributes, ReactNode } from 'react'

const mockPush = jest.fn()
const mockGetSession = jest.fn()
const mockShowToast = jest.fn()

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

jest.mock('@/lib/analytics/track', () => ({ trackEvent: jest.fn() }))

jest.mock('@/app/components/ui/PasswordInput', () => ({
  __esModule: true,
  default: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}))

jest.mock('@/app/components/base', () => ({
  Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}))

import { CexVerifyForm } from '../CexVerifyForm'

const originalFetch = global.fetch

function renderForm() {
  return render(
    <CexVerifyForm
      trader={{
        handle: 'Alice Trader',
        source: 'binance',
        source_trader_id: 'account/42',
      }}
      onSuccess={jest.fn()}
    />
  )
}

function fillCredentials() {
  fireEvent.change(screen.getByPlaceholderText('enterApiKeyPlaceholder'), {
    target: { value: 'api-key' },
  })
  fireEvent.change(screen.getByPlaceholderText('enterApiSecretPlaceholder'), {
    target: { value: 'api-secret' },
  })
}

describe('CexVerifyForm login intent', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = jest.fn() as typeof fetch
  })

  afterAll(() => {
    global.fetch = originalFetch
  })

  it('routes a missing session back to the exact selected account', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } })
    renderForm()
    fillCredentials()

    fireEvent.click(screen.getByRole('button', { name: 'claimVerifyAndClaim' }))

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith(
        '/login?returnUrl=%2Fclaim%3Ftrader%3Daccount%252F42%26source%3Dbinance%26handle%3DAlice%2BTrader%26step%3Dverify'
      )
    )
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('routes an ownership-check 401 through the same claim return URL', async () => {
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: 'expired-token' } },
    })
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Unauthorized' }),
    }) as typeof fetch
    renderForm()
    fillCredentials()

    fireEvent.click(screen.getByRole('button', { name: 'claimVerifyAndClaim' }))

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith(
        '/login?returnUrl=%2Fclaim%3Ftrader%3Daccount%252F42%26source%3Dbinance%26handle%3DAlice%2BTrader%26step%3Dverify'
      )
    )
    expect(mockShowToast).toHaveBeenCalledWith('loginExpiredPleaseRelogin', 'error')
  })
})
