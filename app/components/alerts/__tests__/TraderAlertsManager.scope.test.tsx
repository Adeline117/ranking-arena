import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

jest.mock('@/lib/hooks/useAuthSession', () => ({ useAuthSession: jest.fn() }))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))
jest.mock('@/app/components/ui/Toast', () => ({ useToast: jest.fn() }))
jest.mock('@/lib/api/client', () => ({ authedFetch: jest.fn() }))

import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useToast } from '@/app/components/ui/Toast'
import { authedFetch } from '@/lib/api/client'
import { __resetViewerScopeForTests, synchronizeViewerScope } from '@/lib/auth/viewer-scope'
import TraderAlertsManager from '../TraderAlertsManager'

const mockUseAuthSession = useAuthSession as jest.Mock
const mockUseToast = useToast as jest.Mock
const mockAuthedFetch = authedFetch as jest.Mock
const mockShowToast = jest.fn()

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

function alert(userId: string) {
  return {
    id: `alert-${userId}`,
    trader_id: `trader-${userId}`,
    source: 'binance',
    alert_roi_change: true,
    alert_drawdown: false,
    alert_score_change: false,
    alert_rank_change: false,
    enabled: true,
  }
}

function ok<T>(data: T) {
  return { ok: true, status: 200, data }
}

function alertsFor(userId: string) {
  return ok({ data: { alerts: [alert(userId)] } })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('TraderAlertsManager viewer ownership', () => {
  let currentAuth: ReturnType<typeof authFor>

  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
    const scope = synchronizeViewerScope(true, 'user-a')
    currentAuth = authFor('user-a', scope.sessionGeneration)
    mockUseAuthSession.mockImplementation(() => currentAuth)
    mockUseToast.mockReturnValue({ showToast: mockShowToast })
    window.confirm = jest.fn(() => true)
  })

  it('hides A alerts on the first B render and then displays B alerts', async () => {
    const userB = deferred<ReturnType<typeof alertsFor>>()
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
          ? Promise.resolve(alertsFor('user-a'))
          : userB.promise
      }
    )

    const view = render(<TraderAlertsManager />)
    await screen.findByText('trader-user-a')

    const scopeB = synchronizeViewerScope(true, 'user-b')
    currentAuth = authFor('user-b', scopeB.sessionGeneration)
    view.rerender(<TraderAlertsManager />)

    expect(screen.queryByText('trader-user-a')).not.toBeInTheDocument()
    expect(screen.getByText('loading')).toBeInTheDocument()

    await act(async () => userB.resolve(alertsFor('user-b')))
    await screen.findByText('trader-user-b')
  })

  it('discards an A load that resolves after B', async () => {
    const userA = deferred<ReturnType<typeof alertsFor>>()
    mockAuthedFetch.mockImplementation(
      (
        _url: string,
        _method: string,
        _token: string,
        _body: unknown,
        _timeout: number,
        scope: { expectedUserId: string }
      ) =>
        scope.expectedUserId === 'user-a' ? userA.promise : Promise.resolve(alertsFor('user-b'))
    )

    const view = render(<TraderAlertsManager />)
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))

    const scopeB = synchronizeViewerScope(true, 'user-b')
    currentAuth = authFor('user-b', scopeB.sessionGeneration)
    view.rerender(<TraderAlertsManager />)
    await screen.findByText('trader-user-b')

    await act(async () => userA.resolve(alertsFor('user-a')))
    expect(screen.getByText('trader-user-b')).toBeInTheDocument()
    expect(screen.queryByText('trader-user-a')).not.toBeInTheDocument()
    expect(mockShowToast).not.toHaveBeenCalled()
  })

  it('does not remove or toast in B when A deletion resolves late', async () => {
    const deleteA = deferred<ReturnType<typeof ok>>()
    mockAuthedFetch.mockImplementation(
      (
        _url: string,
        method: string,
        _token: string,
        _body: unknown,
        _timeout: number,
        scope: { expectedUserId: string }
      ) => {
        if (method === 'DELETE') return deleteA.promise
        return Promise.resolve(alertsFor(scope.expectedUserId))
      }
    )

    const view = render(<TraderAlertsManager />)
    await screen.findByText('trader-user-a')
    fireEvent.click(screen.getByRole('button', { name: 'traderAlertsRemove' }))
    await waitFor(() =>
      expect(mockAuthedFetch).toHaveBeenCalledWith(
        '/api/trader-alerts?id=alert-user-a',
        'DELETE',
        jwt('user-a'),
        undefined,
        15_000,
        expect.objectContaining({ expectedUserId: 'user-a' })
      )
    )

    const scopeB = synchronizeViewerScope(true, 'user-b')
    currentAuth = authFor('user-b', scopeB.sessionGeneration)
    view.rerender(<TraderAlertsManager />)
    await screen.findByText('trader-user-b')

    await act(async () => deleteA.resolve(ok({ deleted: true })))
    expect(screen.getByText('trader-user-b')).toBeInTheDocument()
    expect(mockShowToast).not.toHaveBeenCalled()
  })

  it('fails closed when the JWT subject does not match the rendered user', () => {
    currentAuth = authFor('user-a', currentAuth.sessionGeneration, 'user-b')

    render(<TraderAlertsManager />)

    expect(screen.getByText('loading')).toBeInTheDocument()
    expect(mockAuthedFetch).not.toHaveBeenCalled()
  })
})
