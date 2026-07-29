import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

const mockPush = jest.fn()
const mockShowToast = jest.fn()
const mockShowConfirm = jest.fn()
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

function signedOut(generation: number): MockAuth {
  return {
    accessToken: null,
    authChecked: true,
    email: null,
    loading: false,
    sessionGeneration: generation,
    userId: null,
    viewerKey: 'anon',
  }
}

let mockAuth: MockAuth = signedOut(1)

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

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

function claimStatusResponse(userId: string) {
  return {
    data: {
      success: true,
      data: {
        claim: null,
        is_verified: false,
        linked_traders: [] as Array<{ user_id: string }>,
      },
    },
    ok: true,
    status: 200,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('ClaimTraderButton login intent', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuth = signedOut(1)
    mockShowConfirm.mockResolvedValue(true)
  })

  it('does not send a signed-out CEX claimant back to the trader page or homepage', async () => {
    render(
      <ClaimTraderButton
        traderId="account/42"
        handle="Alice Trader"
        userId={VIEWER_A}
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
        userId={VIEWER_A}
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

  it('does not redirect after a confirmation opened by the previous viewer', async () => {
    mockAuth = signedIn(VIEWER_A, 'access-token-a', 2)
    mockAuthedFetch.mockResolvedValue(claimStatusResponse(VIEWER_A))
    const confirmation = deferred<boolean>()
    mockShowConfirm.mockReturnValue(confirmation.promise)
    const view = render(
      <ClaimTraderButton
        traderId="account/42"
        handle="Alice Trader"
        userId={VIEWER_A}
        source="binance"
      />
    )

    fireEvent.click(await screen.findByRole('button', { name: 'claimTrader' }))
    await waitFor(() => expect(mockShowConfirm).toHaveBeenCalledTimes(1))

    mockAuth = signedIn(VIEWER_B, 'access-token-b', 3)
    mockAuthedFetch.mockResolvedValue(claimStatusResponse(VIEWER_B))
    view.rerender(
      <ClaimTraderButton
        traderId="account/42"
        handle="Alice Trader"
        userId={VIEWER_B}
        source="binance"
      />
    )

    await act(async () => {
      confirmation.resolve(true)
      await confirmation.promise
    })

    expect(mockPush).not.toHaveBeenCalled()
  })
})
