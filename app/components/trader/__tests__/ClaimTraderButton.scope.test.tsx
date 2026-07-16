import { render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

const mockGetSession = jest.fn()

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
  useToast: () => ({ showToast: jest.fn() }),
}))

jest.mock('@/app/components/ui/Dialog', () => ({
  useDialog: () => ({ showConfirm: jest.fn() }),
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

const originalFetch = global.fetch
const checksumEvm = '0xAbCdEf0123456789aBCdEf0123456789AbCdEf01'
const canonicalEvm = checksumEvm.toLowerCase()
const solanaTrader = '7YWHMfk9JZe0LMJ9aWbKQR1FV5G7e2SGZts6Dwr5BzKp'

function claimStatusResponse(data: {
  claim: { trader_id: string; source: string; status: string } | null
  is_verified?: boolean
  linked_traders?: Array<{ trader_id: string; source: string }>
}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ success: true, data }),
  }
}

function renderClaimButton(traderId: string, source: string) {
  return render(
    <ClaimTraderButton traderId={traderId} handle="Trader" userId="user-1" source={source} />
  )
}

describe('ClaimTraderButton claim identity scope', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: 'access-token' } },
    })
  })

  afterAll(() => {
    global.fetch = originalFetch
  })

  it('keeps the current trader actionable when a different trader is under review', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      claimStatusResponse({
        claim: { trader_id: 'trader-b', source: 'binance', status: 'reviewing' },
        linked_traders: [{ trader_id: 'trader-b', source: 'binance' }],
      })
    )
    global.fetch = fetchMock as typeof fetch

    renderClaimButton('trader-a', 'binance')

    const button = await screen.findByRole('button', { name: 'linkToProfile' })
    expect(button).toBeEnabled()
    expect(fetchMock).toHaveBeenCalledWith('/api/traders/claim?trader_id=trader-a&source=binance', {
      headers: { Authorization: 'Bearer access-token' },
    })
  })

  it('reads the standard response envelope and disables a matching review claim', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      claimStatusResponse({
        claim: { trader_id: 'trader-a', source: 'binance', status: 'reviewing' },
        linked_traders: [],
      })
    ) as typeof fetch

    renderClaimButton('trader-a', 'BINANCE')

    expect(await screen.findByRole('button', { name: 'claimSubmitted' })).toBeDisabled()
  })

  it('matches EVM case-insensitively but preserves Solana Base58 identity case', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        claimStatusResponse({
          claim: { trader_id: canonicalEvm, source: 'hyperliquid', status: 'reviewing' },
          linked_traders: [],
        })
      )
      .mockResolvedValueOnce(
        claimStatusResponse({
          claim: {
            trader_id: solanaTrader.toLowerCase(),
            source: 'drift',
            status: 'reviewing',
          },
          linked_traders: [],
        })
      )
    global.fetch = fetchMock as typeof fetch

    const evm = renderClaimButton(checksumEvm, 'hyperliquid')
    expect(await screen.findByRole('button', { name: 'claimSubmitted' })).toBeDisabled()
    evm.unmount()

    renderClaimButton(solanaTrader, 'drift')
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('button', { name: 'claimTrader' })).toBeEnabled()
  })
})
