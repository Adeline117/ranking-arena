import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { InputHTMLAttributes, ReactNode } from 'react'

const mockPush = jest.fn()
const mockShowToast = jest.fn()
const mockAuthedFetch = jest.fn()
const mockTrackEvent = jest.fn()
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

jest.mock('@/app/components/ui/PasswordInput', () => ({
  __esModule: true,
  default: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}))

jest.mock('@/app/components/base', () => ({
  Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}))

import { CexVerifyForm } from '../CexVerifyForm'

function response(data: unknown, status = 200) {
  return {
    data,
    ok: status >= 200 && status < 300,
    status,
  }
}

function ownershipAcknowledgement(
  overrides: Partial<{
    exchange: string
    source: string
    traderId: string
    uid: string
    viewerId: string
  }> = {}
) {
  const uid = overrides.uid ?? 'account/42'
  return {
    success: true,
    verified: true,
    uid,
    data: {
      viewerId: overrides.viewerId ?? VIEWER_A,
      exchange: overrides.exchange ?? 'binance',
      source: overrides.source ?? 'binance',
      traderId: overrides.traderId ?? 'account/42',
      verifiedUid: uid,
    },
  }
}

type MockFetchResult = ReturnType<typeof response>

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function renderForm(onSuccess = jest.fn()) {
  return render(
    <CexVerifyForm
      trader={{
        handle: 'Alice Trader',
        source: 'binance',
        source_trader_id: 'account/42',
      }}
      onSuccess={onSuccess}
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
    mockAuth = signedOut(1)
  })

  it('routes a missing session back to the exact selected account', async () => {
    renderForm()
    fillCredentials()

    fireEvent.click(screen.getByRole('button', { name: 'claimVerifyAndClaim' }))

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith(
        '/login?returnUrl=%2Fclaim%3Ftrader%3Daccount%252F42%26source%3Dbinance%26handle%3DAlice%2BTrader%26step%3Dverify'
      )
    )
    expect(mockAuthedFetch).not.toHaveBeenCalled()
  })

  it('routes an ownership-check 401 through the same claim return URL', async () => {
    mockAuth = signedIn(VIEWER_A, 'expired-token', 2)
    mockAuthedFetch.mockResolvedValueOnce(response({ error: 'Unauthorized' }, 401))
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

  it('submits both ownership steps with one exact viewer scope', async () => {
    mockAuth = signedIn(VIEWER_A, 'access-token-a', 3)
    mockAuthedFetch
      .mockResolvedValueOnce(response(ownershipAcknowledgement()))
      .mockResolvedValueOnce(
        response({
          success: true,
          data: {
            claim: {
              user_id: VIEWER_A,
              trader_id: 'account/42',
              source: 'binance',
              status: 'reviewing',
              verification_method: 'api_key',
            },
            auto_approved: false,
          },
        })
      )
    const onSuccess = jest.fn()
    renderForm(onSuccess)
    fillCredentials()

    fireEvent.click(screen.getByRole('button', { name: 'claimVerifyAndClaim' }))

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1))
    expect(mockAuthedFetch).toHaveBeenNthCalledWith(
      1,
      '/api/exchange/verify-ownership',
      'POST',
      'access-token-a',
      expect.objectContaining({
        traderId: 'account/42',
        apiKey: 'api-key',
        apiSecret: 'api-secret',
      }),
      45_000,
      expect.objectContaining({
        expectedUserId: VIEWER_A,
        expectedSessionGeneration: 3,
        signal: expect.any(AbortSignal),
      })
    )
    expect(mockAuthedFetch).toHaveBeenNthCalledWith(
      2,
      '/api/traders/claim',
      'POST',
      'access-token-a',
      expect.objectContaining({
        trader_id: 'account/42',
        source: 'binance',
        verification_method: 'api_key',
      }),
      30_000,
      expect.objectContaining({
        expectedUserId: VIEWER_A,
        expectedSessionGeneration: 3,
        signal: expect.any(AbortSignal),
      })
    )
    expect(mockTrackEvent).toHaveBeenCalledWith('claim_trader', { method: 'cex_api_key' })
    expect(mockShowToast).toHaveBeenCalledWith('claimSubmitted', 'success')
  })

  it('clears secrets and stops the claim chain when the viewer changes', async () => {
    mockAuth = signedIn(VIEWER_A, 'access-token-a', 4)
    const verification = deferred<MockFetchResult>()
    mockAuthedFetch.mockReturnValueOnce(verification.promise)
    const onSuccess = jest.fn()
    const view = renderForm(onSuccess)
    fillCredentials()

    fireEvent.click(screen.getByRole('button', { name: 'claimVerifyAndClaim' }))
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))

    mockAuth = signedIn(VIEWER_B, 'access-token-b', 5)
    view.rerender(
      <CexVerifyForm
        trader={{
          handle: 'Alice Trader',
          source: 'binance',
          source_trader_id: 'account/42',
        }}
        onSuccess={onSuccess}
      />
    )
    expect(screen.getByPlaceholderText('enterApiKeyPlaceholder')).toHaveValue('')
    expect(screen.getByPlaceholderText('enterApiSecretPlaceholder')).toHaveValue('')

    await act(async () => {
      verification.resolve(response(ownershipAcknowledgement()))
      await verification.promise
    })

    expect(mockAuthedFetch).toHaveBeenCalledTimes(1)
    expect(onSuccess).not.toHaveBeenCalled()
    expect(mockTrackEvent).not.toHaveBeenCalled()
    expect(mockShowToast).not.toHaveBeenCalledWith('claimSubmitted', 'success')
  })

  it('rejects a verification acknowledgement for another viewer', async () => {
    mockAuth = signedIn(VIEWER_A, 'access-token-a', 6)
    mockAuthedFetch.mockResolvedValueOnce(
      response(ownershipAcknowledgement({ viewerId: VIEWER_B }))
    )
    const onSuccess = jest.fn()
    renderForm(onSuccess)
    fillCredentials()

    fireEvent.click(screen.getByRole('button', { name: 'claimVerifyAndClaim' }))

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('claimApiKeyMismatch', 'error'))
    expect(mockAuthedFetch).toHaveBeenCalledTimes(1)
    expect(onSuccess).not.toHaveBeenCalled()
    expect(mockTrackEvent).not.toHaveBeenCalled()
  })

  it('starts only one ownership request for a same-tick double click', async () => {
    mockAuth = signedIn(VIEWER_A, 'access-token-a', 7)
    const verification = deferred<MockFetchResult>()
    mockAuthedFetch.mockReturnValue(verification.promise)
    renderForm()
    fillCredentials()

    const button = screen.getByRole('button', { name: 'claimVerifyAndClaim' })
    act(() => {
      button.click()
      button.click()
    })

    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))
  })
})
