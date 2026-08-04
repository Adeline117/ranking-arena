import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

jest.mock('@/lib/hooks/useAuthSession', () => ({ useAuthSession: jest.fn() }))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))
jest.mock('@/lib/api/client', () => ({ authedFetch: jest.fn() }))
jest.mock('@/lib/analytics/track', () => ({ trackEvent: jest.fn() }))

import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { authedFetch } from '@/lib/api/client'
import { trackEvent } from '@/lib/analytics/track'
import { __resetViewerScopeForTests, synchronizeViewerScope } from '@/lib/auth/viewer-scope'
import ReferralCard from '../ReferralCard'
import { BASE_URL } from '@/lib/constants/urls'

const mockUseAuthSession = useAuthSession as jest.Mock
const mockAuthedFetch = authedFetch as jest.Mock
const mockTrackEvent = trackEvent as jest.Mock
const USER_A = '11111111-1111-4111-8111-111111111111'
const USER_B = '22222222-2222-4222-8222-222222222222'
const CODE_A = `ra_${'a'.repeat(32)}`
const CODE_B = `ra_${'b'.repeat(32)}`
const CREATED_AT = '2026-08-03T12:00:00.000Z'

function jwt(userId: string): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${encode({ alg: 'none' })}.${encode({ sub: userId })}.signature`
}

function authFor(userId: string, sessionGeneration: number, tokenUserId = userId) {
  return {
    accessToken: jwt(tokenUserId),
    authChecked: true,
    email: `${userId}@example.com`,
    loading: false,
    sessionGeneration,
    userId,
    viewerKey: `user:${userId}` as const,
  }
}

function referral(
  userId: string,
  hasCode = true,
  options: {
    code?: string | null
    codeSource?: 'none' | 'handle' | 'custom'
    count?: number
    rewardStatus?: 'not_granted' | 'pending' | 'active' | 'expired' | 'revoked'
  } = {}
) {
  const code =
    options.code === undefined
      ? hasCode
        ? userId === USER_A
          ? CODE_A
          : CODE_B
        : null
      : options.code
  const rewardStatus = options.rewardStatus ?? 'not_granted'
  return {
    success: true,
    data: {
      referral: {
        owner_id: userId,
        referral_code: code,
        qualified_referral_count: options.count ?? 1,
        referral_link: code ? `${BASE_URL}/?ref=${code}` : null,
        code_source: options.codeSource ?? (code ? 'custom' : 'none'),
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
                  entitlement_starts_at: '2020-01-01T00:00:00.000Z',
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

function codeCreation(userId: string, code: string) {
  return {
    success: true,
    data: {
      mutation: {
        action: 'create',
        owner_id: userId,
        referral_code: code,
        referral_link: `${BASE_URL}/?ref=${code}`,
        code_source: 'custom',
      },
    },
    meta: { timestamp: CREATED_AT },
  }
}

function ok<T>(data: T) {
  return { ok: true, status: 200, data }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('ReferralCard viewer ownership', () => {
  let currentAuth: ReturnType<typeof authFor>

  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
    const scope = synchronizeViewerScope(true, USER_A)
    currentAuth = authFor(USER_A, scope.sessionGeneration)
    mockUseAuthSession.mockImplementation(() => currentAuth)
  })

  it('fails empty on the first B render and loads only B referral data', async () => {
    const userB = deferred<ReturnType<typeof ok>>()
    mockAuthedFetch.mockImplementation(
      (
        _url: string,
        method: string,
        _token: string,
        _body: unknown,
        _timeout: number,
        scope: { expectedUserId: string }
      ) => {
        if (method !== 'GET') throw new Error('unexpected method')
        return scope.expectedUserId === USER_A
          ? Promise.resolve(ok(referral(USER_A)))
          : userB.promise
      }
    )

    const view = render(<ReferralCard />)
    await screen.findByDisplayValue(`${BASE_URL}/?ref=${CODE_A}`)

    const scopeB = synchronizeViewerScope(true, USER_B)
    currentAuth = authFor(USER_B, scopeB.sessionGeneration)
    view.rerender(<ReferralCard />)

    expect(screen.queryByDisplayValue(`${BASE_URL}/?ref=${CODE_A}`)).not.toBeInTheDocument()

    await act(async () => {
      userB.resolve(ok(referral(USER_B)))
    })
    await screen.findByDisplayValue(`${BASE_URL}/?ref=${CODE_B}`)
  })

  it('discards an A load that resolves after B is already visible', async () => {
    const userA = deferred<ReturnType<typeof ok>>()
    mockAuthedFetch.mockImplementation(
      (
        _url: string,
        _method: string,
        _token: string,
        _body: unknown,
        _timeout: number,
        scope: { expectedUserId: string }
      ) => (scope.expectedUserId === USER_A ? userA.promise : Promise.resolve(ok(referral(USER_B))))
    )

    const view = render(<ReferralCard />)
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))

    const scopeB = synchronizeViewerScope(true, USER_B)
    currentAuth = authFor(USER_B, scopeB.sessionGeneration)
    view.rerender(<ReferralCard />)
    await screen.findByDisplayValue(`${BASE_URL}/?ref=${CODE_B}`)

    await act(async () => {
      userA.resolve(ok(referral(USER_A)))
    })
    expect(screen.getByDisplayValue(`${BASE_URL}/?ref=${CODE_B}`)).toBeInTheDocument()
    expect(screen.queryByDisplayValue(`${BASE_URL}/?ref=${CODE_A}`)).not.toBeInTheDocument()
  })

  it('does not land an A generate response in B', async () => {
    const generateA = deferred<ReturnType<typeof ok>>()
    mockAuthedFetch.mockImplementation(
      (
        _url: string,
        method: string,
        _token: string,
        _body: unknown,
        _timeout: number,
        scope: { expectedUserId: string }
      ) => {
        if (method === 'POST') return generateA.promise
        return Promise.resolve(ok(referral(scope.expectedUserId, scope.expectedUserId !== USER_A)))
      }
    )

    const view = render(<ReferralCard />)
    fireEvent.click(await screen.findByRole('button', { name: 'referralGenerate' }))
    await waitFor(() =>
      expect(mockAuthedFetch).toHaveBeenCalledWith(
        '/api/referral',
        'POST',
        jwt(USER_A),
        { action: 'create' },
        15_000,
        expect.objectContaining({ expectedUserId: USER_A, signal: expect.any(AbortSignal) })
      )
    )

    const scopeB = synchronizeViewerScope(true, USER_B)
    currentAuth = authFor(USER_B, scopeB.sessionGeneration)
    view.rerender(<ReferralCard />)
    await screen.findByDisplayValue(`${BASE_URL}/?ref=${CODE_B}`)

    await act(async () => {
      generateA.resolve({ ...ok(codeCreation(USER_A, CODE_A)), status: 201 })
    })
    expect(screen.queryByDisplayValue(`${BASE_URL}/?ref=${CODE_A}`)).not.toBeInTheDocument()
    expect(screen.getByDisplayValue(`${BASE_URL}/?ref=${CODE_B}`)).toBeInTheDocument()
  })

  it('does not show A clipboard completion or analytics under B', async () => {
    mockAuthedFetch.mockImplementation(
      (
        _url: string,
        _method: string,
        _token: string,
        _body: unknown,
        _timeout: number,
        scope: { expectedUserId: string }
      ) => Promise.resolve(ok(referral(scope.expectedUserId)))
    )
    const clipboard = deferred<void>()
    const writeText = jest.fn(() => clipboard.promise)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    const view = render(<ReferralCard />)
    fireEvent.click(await screen.findByRole('button', { name: 'copy' }))
    expect(writeText).toHaveBeenCalledWith(`${BASE_URL}/?ref=${CODE_A}`)

    const scopeB = synchronizeViewerScope(true, USER_B)
    currentAuth = authFor(USER_B, scopeB.sessionGeneration)
    view.rerender(<ReferralCard />)
    await screen.findByDisplayValue(`${BASE_URL}/?ref=${CODE_B}`)

    await act(async () => clipboard.resolve())
    expect(screen.getByRole('button', { name: 'copy' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'copiedToClipboard' })).not.toBeInTheDocument()
    expect(mockTrackEvent).not.toHaveBeenCalled()
  })

  it('renders nothing and sends no request when the token subject mismatches the viewer', () => {
    currentAuth = authFor(USER_A, synchronizeViewerScope(true, USER_A).sessionGeneration, USER_B)

    const view = render(<ReferralCard />)

    expect(view.container).toBeEmptyDOMElement()
    expect(mockAuthedFetch).not.toHaveBeenCalled()
  })

  it('shows a scoped error for an expanded response and can retry safely', async () => {
    mockAuthedFetch
      .mockResolvedValueOnce(ok({ ...referral(USER_A), extra: true }))
      .mockResolvedValueOnce(ok(referral(USER_A)))

    render(<ReferralCard />)

    expect(await screen.findByText('loadFailedRetryShort')).toBeInTheDocument()
    expect(screen.queryByDisplayValue(`${BASE_URL}/?ref=${CODE_A}`)).not.toBeInTheDocument()
    const retry = screen.getByRole('button', { name: 'retry' })
    expect(retry).toHaveStyle({ minHeight: '44px' })
    fireEvent.click(retry)

    expect(await screen.findByDisplayValue(`${BASE_URL}/?ref=${CODE_A}`)).toBeInTheDocument()
    expect(mockAuthedFetch).toHaveBeenCalledTimes(2)
  })

  it('does not infer an active reward from count and unlocks only from active authority', async () => {
    mockAuthedFetch.mockResolvedValueOnce(
      ok(referral(USER_A, true, { count: 9, rewardStatus: 'not_granted' }))
    )
    const view = render(<ReferralCard />)

    expect(await screen.findByText('9/3')).toBeInTheDocument()
    expect(screen.queryByText('referralRewardUnlocked')).not.toBeInTheDocument()

    const scopeB = synchronizeViewerScope(true, USER_B)
    currentAuth = authFor(USER_B, scopeB.sessionGeneration)
    mockAuthedFetch.mockResolvedValueOnce(
      ok(referral(USER_B, true, { count: 1, rewardStatus: 'active' }))
    )
    view.rerender(<ReferralCard />)

    expect(await screen.findByText('referralRewardUnlocked')).toBeInTheDocument()
  })

  it.each([
    ['pending', 'processing'],
    ['expired', /complete · /],
    ['revoked', 'apiKeyRevokedSection'],
  ] as const)('labels %s authority without calling current Pro unlocked', async (status, label) => {
    mockAuthedFetch.mockResolvedValueOnce(
      ok(referral(USER_A, true, { count: 3, rewardStatus: status }))
    )

    render(<ReferralCard />)

    expect(await screen.findByText(label)).toBeInTheDocument()
    expect(screen.queryByText('referralRewardUnlocked')).not.toBeInTheDocument()
  })

  it('reconciles a cross-tab 409 and replaces the old handle with authoritative custom code', async () => {
    const handle = 'owner_handle'
    mockAuthedFetch
      .mockResolvedValueOnce(ok(referral(USER_A, true, { code: handle, codeSource: 'handle' })))
      .mockResolvedValueOnce({ ok: false, status: 409, data: { error: 'already exists' } })
      .mockResolvedValueOnce(ok(referral(USER_A)))

    render(<ReferralCard />)
    expect(await screen.findByDisplayValue(`${BASE_URL}/?ref=${handle}`)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'referralGenerate' }))

    expect(await screen.findByDisplayValue(`${BASE_URL}/?ref=${CODE_A}`)).toBeInTheDocument()
    expect(mockAuthedFetch).toHaveBeenCalledTimes(3)
    expect(mockAuthedFetch).toHaveBeenNthCalledWith(
      2,
      '/api/referral',
      'POST',
      jwt(USER_A),
      { action: 'create' },
      15_000,
      expect.objectContaining({ expectedUserId: USER_A, signal: expect.any(AbortSignal) })
    )
    expect(screen.queryByRole('button', { name: 'referralGenerate' })).not.toBeInTheDocument()
  })
})
