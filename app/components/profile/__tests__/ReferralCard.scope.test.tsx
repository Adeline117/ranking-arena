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

const mockUseAuthSession = useAuthSession as jest.Mock
const mockAuthedFetch = authedFetch as jest.Mock
const mockTrackEvent = trackEvent as jest.Mock

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

function referral(userId: string, hasCode = true) {
  return {
    referral_code: hasCode ? `code-${userId}` : '',
    referral_count: 1,
    referral_link: hasCode ? `https://example.test/?ref=${userId}` : '',
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
    const scope = synchronizeViewerScope(true, 'user-a')
    currentAuth = authFor('user-a', scope.sessionGeneration)
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
        return scope.expectedUserId === 'user-a'
          ? Promise.resolve(ok(referral('user-a')))
          : userB.promise
      }
    )

    const view = render(<ReferralCard />)
    await screen.findByDisplayValue('https://example.test/?ref=user-a')

    const scopeB = synchronizeViewerScope(true, 'user-b')
    currentAuth = authFor('user-b', scopeB.sessionGeneration)
    view.rerender(<ReferralCard />)

    expect(screen.queryByDisplayValue('https://example.test/?ref=user-a')).not.toBeInTheDocument()

    await act(async () => {
      userB.resolve(ok(referral('user-b')))
    })
    await screen.findByDisplayValue('https://example.test/?ref=user-b')
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
      ) =>
        scope.expectedUserId === 'user-a' ? userA.promise : Promise.resolve(ok(referral('user-b')))
    )

    const view = render(<ReferralCard />)
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))

    const scopeB = synchronizeViewerScope(true, 'user-b')
    currentAuth = authFor('user-b', scopeB.sessionGeneration)
    view.rerender(<ReferralCard />)
    await screen.findByDisplayValue('https://example.test/?ref=user-b')

    await act(async () => {
      userA.resolve(ok(referral('user-a')))
    })
    expect(screen.getByDisplayValue('https://example.test/?ref=user-b')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('https://example.test/?ref=user-a')).not.toBeInTheDocument()
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
        return Promise.resolve(
          ok(referral(scope.expectedUserId, scope.expectedUserId !== 'user-a'))
        )
      }
    )

    const view = render(<ReferralCard />)
    fireEvent.click(await screen.findByRole('button', { name: 'referralGenerate' }))
    await waitFor(() =>
      expect(mockAuthedFetch).toHaveBeenCalledWith(
        '/api/referral',
        'POST',
        jwt('user-a'),
        undefined,
        15_000,
        expect.objectContaining({ expectedUserId: 'user-a' })
      )
    )

    const scopeB = synchronizeViewerScope(true, 'user-b')
    currentAuth = authFor('user-b', scopeB.sessionGeneration)
    view.rerender(<ReferralCard />)
    await screen.findByDisplayValue('https://example.test/?ref=user-b')

    await act(async () => {
      generateA.resolve(
        ok({ referral_code: 'late-a', referral_link: 'https://example.test/?ref=late-a' })
      )
    })
    expect(screen.queryByDisplayValue('https://example.test/?ref=late-a')).not.toBeInTheDocument()
    expect(screen.getByDisplayValue('https://example.test/?ref=user-b')).toBeInTheDocument()
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
    expect(writeText).toHaveBeenCalledWith('https://example.test/?ref=user-a')

    const scopeB = synchronizeViewerScope(true, 'user-b')
    currentAuth = authFor('user-b', scopeB.sessionGeneration)
    view.rerender(<ReferralCard />)
    await screen.findByDisplayValue('https://example.test/?ref=user-b')

    await act(async () => clipboard.resolve())
    expect(screen.getByRole('button', { name: 'copy' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'copiedToClipboard' })).not.toBeInTheDocument()
    expect(mockTrackEvent).not.toHaveBeenCalled()
  })

  it('renders nothing and sends no request when the token subject mismatches the viewer', () => {
    currentAuth = authFor(
      'user-a',
      synchronizeViewerScope(true, 'user-a').sessionGeneration,
      'user-b'
    )

    const view = render(<ReferralCard />)

    expect(view.container).toBeEmptyDOMElement()
    expect(mockAuthedFetch).not.toHaveBeenCalled()
  })
})
