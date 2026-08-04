import { act, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

const mockAuthedFetch = jest.fn()
const VIEWER_A = '11111111-1111-4111-8111-111111111111'
const VIEWER_B = '22222222-2222-4222-8222-222222222222'

type MockAuth = {
  accessToken: string | null
  authChecked: boolean
  email: string | null
  loading: boolean
  sessionGeneration: number
  userId: string | null
  viewerKey: 'anon' | `user:${string}`
}

function signedIn(userId: string, token: string, generation: number): MockAuth {
  return {
    accessToken: token,
    authChecked: true,
    email: null,
    loading: false,
    sessionGeneration: generation,
    userId,
    viewerKey: `user:${userId}`,
  }
}

let mockAuth: MockAuth = signedIn(VIEWER_A, 'access-token-a', 1)

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuth,
}))

jest.mock('@/app/(app)/settings/hooks/settings-viewer-scope', () => ({
  captureSettingsViewer: (auth: MockAuth) => {
    if (
      auth.loading ||
      !auth.authChecked ||
      !auth.userId ||
      !auth.accessToken ||
      auth.viewerKey !== `user:${auth.userId}`
    ) {
      return null
    }
    return {
      accessToken: auth.accessToken,
      email: auth.email,
      sessionGeneration: auth.sessionGeneration,
      userId: auth.userId,
      viewerKey: auth.viewerKey,
    }
  },
  isSettingsViewerCurrent: (
    viewer: { sessionGeneration: number; userId: string; viewerKey: string },
    auth: MockAuth
  ) =>
    auth.authChecked &&
    !auth.loading &&
    auth.userId === viewer.userId &&
    auth.viewerKey === viewer.viewerKey &&
    auth.sessionGeneration === viewer.sessionGeneration,
}))

jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
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

const checksumEvm = '0xAbCdEf0123456789aBCdEf0123456789AbCdEf01'
const canonicalEvm = checksumEvm.toLowerCase()
const solanaTrader = '7YWHMfk9JZe0LMJ9aWbKQR1FV5G7e2SGZts6Dwr5BzKp'

function claimStatusResponse(
  userId: string,
  data: {
    claim: { trader_id: string; source: string; status: string } | null
    is_verified?: boolean
    linked_traders?: Array<{ trader_id: string; source: string }>
  }
) {
  return {
    data: {
      success: true,
      data: {
        claim: data.claim ? { ...data.claim, user_id: userId } : null,
        is_verified: data.is_verified ?? false,
        linked_traders: (data.linked_traders ?? []).map((trader) => ({
          ...trader,
          user_id: userId,
        })),
        linked_count: data.linked_traders?.length ?? 0,
        verified_trader: data.is_verified ? { user_id: userId } : null,
      },
      meta: { timestamp: '2026-01-01T00:00:00.000Z' },
    },
    ok: true,
    status: 200,
  }
}

type MockFetchResult = ReturnType<typeof claimStatusResponse>

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function renderClaimButton(traderId: string, source: string, userId = VIEWER_A) {
  return render(
    <ClaimTraderButton traderId={traderId} handle="Trader" userId={userId} source={source} />
  )
}

describe('ClaimTraderButton claim identity scope', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuth = signedIn(VIEWER_A, 'access-token-a', 1)
  })

  it('keeps the current trader actionable when a different trader is under review', async () => {
    mockAuthedFetch.mockResolvedValue(
      claimStatusResponse(VIEWER_A, {
        claim: { trader_id: 'trader-b', source: 'binance', status: 'reviewing' },
        linked_traders: [{ trader_id: 'trader-b', source: 'binance' }],
      })
    )

    renderClaimButton('trader-a', 'binance')

    const button = await screen.findByRole('button', { name: 'linkToProfile' })
    expect(button).toBeEnabled()
    expect(mockAuthedFetch).toHaveBeenCalledWith(
      '/api/traders/claim?trader_id=trader-a&source=binance',
      'GET',
      'access-token-a',
      undefined,
      15_000,
      expect.objectContaining({
        expectedUserId: VIEWER_A,
        expectedSessionGeneration: 1,
        signal: expect.any(AbortSignal),
      })
    )
  })

  it('reads the standard response envelope and disables a matching review claim', async () => {
    mockAuthedFetch.mockResolvedValue(
      claimStatusResponse(VIEWER_A, {
        claim: { trader_id: 'trader-a', source: 'binance', status: 'reviewing' },
        linked_traders: [],
      })
    )

    renderClaimButton('trader-a', 'BINANCE')

    expect(await screen.findByRole('button', { name: 'claimSubmitted' })).toBeDisabled()
  })

  it('ignores an internally inconsistent linked-account count', async () => {
    const response = claimStatusResponse(VIEWER_A, {
      claim: { trader_id: 'trader-a', source: 'binance', status: 'reviewing' },
      linked_traders: [],
    })
    response.data.data.linked_count = 1
    mockAuthedFetch.mockResolvedValue(response)

    renderClaimButton('trader-a', 'binance')

    expect(await screen.findByRole('button', { name: 'claimTrader' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'claimSubmitted' })).not.toBeInTheDocument()
  })

  it('matches EVM case-insensitively but preserves Solana Base58 identity case', async () => {
    mockAuthedFetch
      .mockResolvedValueOnce(
        claimStatusResponse(VIEWER_A, {
          claim: { trader_id: canonicalEvm, source: 'hyperliquid', status: 'reviewing' },
          linked_traders: [],
        })
      )
      .mockResolvedValueOnce(
        claimStatusResponse(VIEWER_A, {
          claim: {
            trader_id: solanaTrader.toLowerCase(),
            source: 'drift',
            status: 'reviewing',
          },
          linked_traders: [],
        })
      )

    const evm = renderClaimButton(checksumEvm, 'hyperliquid')
    expect(await screen.findByRole('button', { name: 'claimSubmitted' })).toBeDisabled()
    evm.unmount()

    renderClaimButton(solanaTrader, 'drift')
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('button', { name: 'claimTrader' })).toBeEnabled()
  })

  it('never applies the previous viewer claim status to the replacement viewer', async () => {
    const firstStatus = deferred<MockFetchResult>()
    mockAuthedFetch.mockReturnValueOnce(firstStatus.promise).mockResolvedValueOnce(
      claimStatusResponse(VIEWER_B, {
        claim: null,
        linked_traders: [],
      })
    )
    const view = renderClaimButton('trader-a', 'binance')
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))

    mockAuth = signedIn(VIEWER_B, 'access-token-b', 2)
    view.rerender(
      <ClaimTraderButton traderId="trader-a" handle="Trader" userId={VIEWER_B} source="binance" />
    )
    expect(await screen.findByRole('button', { name: 'claimTrader' })).toBeEnabled()

    await act(async () => {
      firstStatus.resolve(
        claimStatusResponse(VIEWER_A, {
          claim: { trader_id: 'trader-a', source: 'binance', status: 'reviewing' },
          linked_traders: [],
        })
      )
      await firstStatus.promise
    })

    expect(screen.getByRole('button', { name: 'claimTrader' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'claimSubmitted' })).not.toBeInTheDocument()
  })
})
