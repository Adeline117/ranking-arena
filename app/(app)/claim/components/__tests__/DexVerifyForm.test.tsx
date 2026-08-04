import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

const mockShowToast = jest.fn()
const mockTrackEvent = jest.fn()
const mockPush = jest.fn()
const mockAuthedFetch = jest.fn()
const checksumWallet = '0xAbCdEf0123456789aBCdEf0123456789AbCdEf01'
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

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
}))

jest.mock('@/lib/analytics/track', () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}))

jest.mock('@/app/components/base', () => ({
  Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}))

import { DexVerifyForm } from '../DexVerifyForm'

function response(data: unknown, status = 200) {
  return {
    data,
    ok: status >= 200 && status < 300,
    status,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function claimAcknowledgement(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      claimId: 'claim-1',
      traderId: checksumWallet.toLowerCase(),
      source: 'hyperliquid',
      viewerId: VIEWER_A,
      method: 'signature',
      status: 'reviewing',
      autoApproved: false,
      ...overrides,
    },
    meta: { timestamp: '2026-08-03T12:00:00.000Z' },
  }
}

describe('DexVerifyForm proof submission', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuth = signedIn(VIEWER_A, 'access-token-a', 1)
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

  it('submits a signed proof exactly once through the atomic claim endpoint', async () => {
    mockAuthedFetch.mockResolvedValueOnce(response(claimAcknowledgement()))
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
    expect(mockAuthedFetch).toHaveBeenCalledTimes(1)
    expect(mockAuthedFetch).toHaveBeenCalledWith(
      '/api/traders/claim',
      'POST',
      'access-token-a',
      expect.objectContaining({
        trader_id: checksumWallet.toLowerCase(),
        source: 'hyperliquid',
        verification_method: 'signature',
        verification_data: expect.objectContaining({
          wallet_address: checksumWallet,
          signature: '0xsigned-proof',
          message: expect.stringContaining(`User ID: ${VIEWER_A}`),
        }),
      }),
      30_000,
      expect.objectContaining({
        expectedUserId: VIEWER_A,
        expectedSessionGeneration: 1,
        signal: expect.any(AbortSignal),
      })
    )

    expect(mockShowToast).toHaveBeenCalledWith('claimSubmitted', 'success')
    expect(mockTrackEvent).toHaveBeenCalledWith('claim_trader', { method: 'dex_wallet' })
    expect(
      mockAuthedFetch.mock.calls.some(([url]) => url === '/api/traders/claim/verify-wallet')
    ).toBe(false)
  })

  it('single-flights same-frame wallet verification attempts', async () => {
    const accounts = deferred<string[]>()
    const request = jest.fn(({ method }: { method: string }) => {
      if (method === 'eth_requestAccounts') return accounts.promise
      if (method === 'personal_sign') return Promise.resolve('0xsigned-proof')
      return Promise.reject(new Error(`Unexpected wallet method: ${method}`))
    })
    Object.defineProperty(window, 'ethereum', {
      configurable: true,
      value: { request },
    })
    mockAuthedFetch.mockResolvedValueOnce(response(claimAcknowledgement()))
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

    const button = screen.getByRole('button', { name: 'claimWalletSignMessage' })
    const timeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(() => 0 as never)
    act(() => {
      button.click()
      button.click()
    })
    timeoutSpy.mockRestore()

    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith({ method: 'eth_requestAccounts' })

    await act(async () => {
      accounts.resolve([checksumWallet])
      await accounts.promise
    })

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1))
    expect(mockAuthedFetch).toHaveBeenCalledTimes(1)
  })

  it('returns an expired claim to the exact wallet verification flow', async () => {
    mockAuthedFetch.mockResolvedValueOnce(response({ error: 'Unauthorized' }, 401))

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

  it('does not submit a proof signed after the viewer changes', async () => {
    const signature = deferred<string>()
    const request = jest.fn(({ method }: { method: string }) => {
      if (method === 'eth_requestAccounts') return Promise.resolve([checksumWallet])
      if (method === 'personal_sign') return signature.promise
      return Promise.reject(new Error(`Unexpected wallet method: ${method}`))
    })
    Object.defineProperty(window, 'ethereum', {
      configurable: true,
      value: { request },
    })
    const onSuccess = jest.fn()
    const view = render(
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
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'personal_sign',
        })
      )
    )

    mockAuth = signedIn(VIEWER_B, 'access-token-b', 2)
    view.rerender(
      <DexVerifyForm
        trader={{
          handle: 'Wallet Trader',
          source: 'hyperliquid',
          source_trader_id: checksumWallet.toLowerCase(),
        }}
        onSuccess={onSuccess}
      />
    )

    await act(async () => {
      signature.resolve('0xold-viewer-proof')
      await signature.promise
    })

    expect(mockAuthedFetch).not.toHaveBeenCalled()
    expect(onSuccess).not.toHaveBeenCalled()
    expect(mockTrackEvent).not.toHaveBeenCalled()
    expect(mockShowToast).not.toHaveBeenCalledWith('claimSubmitted', 'success')
  })

  it('ignores an old claim response after the selected wallet changes', async () => {
    const claim = deferred<ReturnType<typeof response>>()
    mockAuthedFetch.mockReturnValueOnce(claim.promise)
    const onSuccess = jest.fn()
    const view = render(
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
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))

    view.rerender(
      <DexVerifyForm
        trader={{
          handle: 'Another Wallet',
          source: 'hyperliquid',
          source_trader_id: '0x1111111111111111111111111111111111111111',
        }}
        onSuccess={onSuccess}
      />
    )

    await act(async () => {
      claim.resolve(response(claimAcknowledgement()))
      await claim.promise
    })

    expect(onSuccess).not.toHaveBeenCalled()
    expect(mockTrackEvent).not.toHaveBeenCalled()
    expect(mockShowToast).not.toHaveBeenCalledWith('claimSubmitted', 'success')
  })

  it.each([
    ['a non-200 claim response', claimAcknowledgement(), 202],
    ['a claim for another viewer', claimAcknowledgement({ viewerId: VIEWER_B }), 200],
    ['a claim for another wallet', claimAcknowledgement({ traderId: '0xother' }), 200],
    ['a claim for another source', claimAcknowledgement({ source: 'drift' }), 200],
    ['a claim with another method', claimAcknowledgement({ method: 'api_key' }), 200],
    [
      'a widened claim payload',
      {
        ...claimAcknowledgement(),
        data: { ...claimAcknowledgement().data, autoActivated: true },
      },
      200,
    ],
  ])('rejects %s', async (_label, acknowledgement, status) => {
    mockAuthedFetch.mockResolvedValueOnce(response(acknowledgement, status))
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

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('claimFailed', 'error'))
    expect(onSuccess).not.toHaveBeenCalled()
    expect(mockTrackEvent).not.toHaveBeenCalled()
  })
})
