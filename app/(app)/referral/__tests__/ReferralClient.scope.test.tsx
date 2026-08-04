import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AnchorHTMLAttributes, ReactNode } from 'react'

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

jest.mock('@/app/components/layout/FloatingActionButton', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/app/components/ui/LoadingSkeleton', () => ({
  __esModule: true,
  default: () => <div>loading-skeleton</div>,
}))

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { children?: ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}))

import ReferralClient from '../ReferralClient'
import { BASE_URL } from '@/lib/constants/urls'

const CODE_A = `ra_${'a'.repeat(32)}`
const CODE_B = `ra_${'b'.repeat(32)}`
const CREATED_AT = '2026-08-03T12:00:00.000Z'

function referralSnapshot(
  ownerId: string,
  options: {
    code?: string | null
    codeSource?: 'none' | 'handle' | 'custom'
    count?: number
    rewardStatus?: 'not_granted' | 'pending' | 'scheduled' | 'active' | 'expired' | 'revoked'
  } = {}
) {
  const code = options.code === undefined ? (ownerId === VIEWER_A ? CODE_A : CODE_B) : options.code
  const rewardStatus = options.rewardStatus ?? 'not_granted'
  return {
    success: true,
    data: {
      referral: {
        owner_id: ownerId,
        referral_code: code,
        referral_link: code ? `${BASE_URL}/?ref=${code}` : null,
        code_source: options.codeSource ?? (code ? 'custom' : 'none'),
        qualified_referral_count: options.count ?? 2,
        advocate_reward:
          rewardStatus === 'not_granted'
            ? {
                reward_id: null,
                status: 'not_granted',
                granted_days: null,
                entitlement_granted_at: null,
                entitlement_starts_at: null,
                entitlement_expires_at: null,
                entitlement_revoked_at: null,
              }
            : rewardStatus === 'pending'
              ? {
                  reward_id: '33333333-3333-4333-8333-333333333333',
                  status: 'pending',
                  granted_days: 30,
                  entitlement_granted_at: null,
                  entitlement_starts_at: null,
                  entitlement_expires_at: null,
                  entitlement_revoked_at: null,
                }
              : {
                  reward_id: '33333333-3333-4333-8333-333333333333',
                  status: rewardStatus,
                  granted_days: 30,
                  entitlement_granted_at: CREATED_AT,
                  entitlement_starts_at:
                    rewardStatus === 'scheduled'
                      ? '2098-01-01T00:00:00.000Z'
                      : '2020-01-01T00:00:00.000Z',
                  entitlement_expires_at:
                    rewardStatus === 'expired'
                      ? '2020-02-01T00:00:00.000Z'
                      : '2099-01-01T00:00:00.000Z',
                  entitlement_revoked_at:
                    rewardStatus === 'revoked' ? '2026-08-03T13:00:00.000Z' : null,
                },
      },
    },
    meta: { timestamp: CREATED_AT },
  }
}

function codeCreation(ownerId: string, code: string) {
  return {
    success: true,
    data: {
      mutation: {
        action: 'create',
        owner_id: ownerId,
        referral_code: code,
        referral_link: `${BASE_URL}/?ref=${code}`,
        code_source: 'custom',
      },
    },
    meta: { timestamp: CREATED_AT },
  }
}

function response(data: unknown, status = 200) {
  return {
    data,
    ok: status >= 200 && status < 300,
    status,
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

describe('ReferralClient viewer scope', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuth = signedIn(VIEWER_A, 'access-token-a', 1)
  })

  it('never displays a late referral response from the previous viewer', async () => {
    const firstLoad = deferred<MockFetchResult>()
    mockAuthedFetch
      .mockReturnValueOnce(firstLoad.promise)
      .mockResolvedValueOnce(response(referralSnapshot(VIEWER_B)))
    const view = render(<ReferralClient />)
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))
    expect(mockAuthedFetch).toHaveBeenNthCalledWith(
      1,
      '/api/referral',
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

    mockAuth = signedIn(VIEWER_B, 'access-token-b', 2)
    view.rerender(<ReferralClient />)
    expect(await screen.findByText(`${BASE_URL}/?ref=${CODE_B}`)).toBeInTheDocument()

    await act(async () => {
      firstLoad.resolve(response(referralSnapshot(VIEWER_A, { count: 99 })))
      await firstLoad.promise
    })

    expect(screen.queryByText(`${BASE_URL}/?ref=${CODE_A}`)).not.toBeInTheDocument()
    expect(screen.getByText(`${BASE_URL}/?ref=${CODE_B}`)).toBeInTheDocument()
  })

  it('does not apply an old generate response after an account switch', async () => {
    const oldGenerate = deferred<MockFetchResult>()
    mockAuthedFetch
      .mockResolvedValueOnce(
        response(referralSnapshot(VIEWER_A, { code: null, codeSource: 'none', count: 0 }))
      )
      .mockReturnValueOnce(oldGenerate.promise)
      .mockResolvedValueOnce(response(referralSnapshot(VIEWER_B, { count: 4 })))
    const view = render(<ReferralClient />)

    fireEvent.click(await screen.findByRole('button', { name: 'referralGenerate' }))
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(2))
    expect(mockAuthedFetch).toHaveBeenNthCalledWith(
      2,
      '/api/referral',
      'POST',
      'access-token-a',
      { action: 'create' },
      15_000,
      expect.objectContaining({
        expectedUserId: VIEWER_A,
        expectedSessionGeneration: 1,
        signal: expect.any(AbortSignal),
      })
    )

    mockAuth = signedIn(VIEWER_B, 'access-token-b', 2)
    view.rerender(<ReferralClient />)
    expect(await screen.findByText(`${BASE_URL}/?ref=${CODE_B}`)).toBeInTheDocument()

    await act(async () => {
      oldGenerate.resolve(response(codeCreation(VIEWER_A, CODE_A), 201))
      await oldGenerate.promise
    })

    expect(mockAuthedFetch).toHaveBeenCalledTimes(3)
    expect(screen.queryByText(`${BASE_URL}/?ref=${CODE_A}`)).not.toBeInTheDocument()
    expect(screen.getByText(`${BASE_URL}/?ref=${CODE_B}`)).toBeInTheDocument()
  })

  it('shows the sign-in gate without issuing a viewer-bound request', () => {
    mockAuth = signedOut(3)
    render(<ReferralClient />)

    expect(screen.getByText('referralSignInGateTitle')).toBeInTheDocument()
    expect(mockAuthedFetch).not.toHaveBeenCalled()
  })

  it('fails closed on an expanded acknowledgement and retries in the same viewer scope', async () => {
    mockAuthedFetch
      .mockResolvedValueOnce(response({ ...referralSnapshot(VIEWER_A), extra: true }))
      .mockResolvedValueOnce(response(referralSnapshot(VIEWER_A)))

    render(<ReferralClient />)

    expect(await screen.findByText('loadFailedRetryShort')).toBeInTheDocument()
    expect(screen.queryByText(`${BASE_URL}/?ref=${CODE_A}`)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'retry' }))

    expect(await screen.findByText(`${BASE_URL}/?ref=${CODE_A}`)).toBeInTheDocument()
    expect(mockAuthedFetch).toHaveBeenCalledTimes(2)
  })

  it('never infers an active Pro reward from a threshold-sized qualified count', async () => {
    mockAuthedFetch.mockResolvedValueOnce(
      response(referralSnapshot(VIEWER_A, { count: 99, rewardStatus: 'not_granted' }))
    )

    render(<ReferralClient />)

    expect(await screen.findByText('99/3')).toBeInTheDocument()
    expect(screen.queryByText('referralRewardUnlocked')).not.toBeInTheDocument()
  })

  it('shows unlocked only when the entitlement authority says the reward is active', async () => {
    mockAuthedFetch.mockResolvedValueOnce(
      response(referralSnapshot(VIEWER_A, { count: 1, rewardStatus: 'active' }))
    )

    render(<ReferralClient />)

    expect(await screen.findByText('referralRewardUnlocked')).toBeInTheDocument()
    expect(screen.queryByText('1/3')).not.toBeInTheDocument()
  })

  it.each([
    ['pending', 'processing'],
    ['scheduled', /processing · /],
    ['expired', /complete · /],
    ['revoked', 'apiKeyRevokedSection'],
  ] as const)(
    'labels a %s reward without claiming current Pro is unlocked',
    async (status, label) => {
      mockAuthedFetch.mockResolvedValueOnce(
        response(referralSnapshot(VIEWER_A, { count: 3, rewardStatus: status }))
      )

      render(<ReferralClient />)

      expect(await screen.findByText(label)).toBeInTheDocument()
      expect(screen.queryByText('referralRewardUnlocked')).not.toBeInTheDocument()
    }
  )

  it('keeps the last-good handle link when code creation returns a malformed receipt', async () => {
    const handle = 'owner_handle'
    mockAuthedFetch
      .mockResolvedValueOnce(
        response(referralSnapshot(VIEWER_A, { code: handle, codeSource: 'handle', count: 1 }))
      )
      .mockResolvedValueOnce(response({ ...codeCreation(VIEWER_A, CODE_A), extra: true }, 201))
      .mockResolvedValueOnce(
        response(referralSnapshot(VIEWER_A, { code: handle, codeSource: 'handle', count: 1 }))
      )

    render(<ReferralClient />)
    expect(await screen.findByText(`${BASE_URL}/?ref=${handle}`)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'referralGenerate' }))

    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(3))
    expect(screen.getByText(`${BASE_URL}/?ref=${handle}`)).toBeInTheDocument()
    expect(screen.queryByText(`${BASE_URL}/?ref=${CODE_A}`)).not.toBeInTheDocument()
  })

  it('does not offer destructive regeneration for a permanent custom code', async () => {
    mockAuthedFetch.mockResolvedValueOnce(response(referralSnapshot(VIEWER_A)))
    render(<ReferralClient />)

    expect(await screen.findByText(`${BASE_URL}/?ref=${CODE_A}`)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'referralRegenerate' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'referralGenerate' })).not.toBeInTheDocument()
  })
})
