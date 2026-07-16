import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

jest.mock('@/lib/hooks/useAuthSession', () => ({ useAuthSession: jest.fn() }))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))
jest.mock('@/lib/api/client', () => ({ authedFetch: jest.fn() }))
jest.mock('@/app/(app)/settings/components/shared', () => ({
  ToggleSwitch: ({
    checked,
    onChange,
  }: {
    checked: boolean
    onChange: (checked: boolean) => void
  }) => (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}>
      toggle
    </button>
  ),
}))

import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { authedFetch } from '@/lib/api/client'
import { __resetViewerScopeForTests, synchronizeViewerScope } from '@/lib/auth/viewer-scope'
import { PushNotificationToggle } from '../PushNotificationToggle'

const mockUseAuthSession = useAuthSession as jest.Mock
const mockAuthedFetch = authedFetch as jest.Mock

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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function ok<T>(data: T) {
  return { ok: true, status: 200, data }
}

function subscriptionStatus(subscribed: boolean) {
  return ok({ success: true, data: { subscribed } })
}

describe('PushNotificationToggle viewer ownership', () => {
  const endpoint = 'https://push.test/subscription'
  const unsubscribeBrowser = jest.fn()
  const subscription = {
    endpoint,
    toJSON: () => ({ keys: { p256dh: 'p256dh', auth: 'auth' } }),
    unsubscribe: unsubscribeBrowser,
  }
  const getSubscription = jest.fn<Promise<typeof subscription | null>, []>()
  const subscribeBrowser = jest.fn<Promise<typeof subscription>, []>()
  const registration = { pushManager: { getSubscription, subscribe: subscribeBrowser } }
  const requestPermission = jest.fn<Promise<NotificationPermission>, []>()
  const onToast = jest.fn()
  let currentAuth: ReturnType<typeof authFor>

  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
    const scope = synchronizeViewerScope(true, 'user-a')
    currentAuth = authFor('user-a', scope.sessionGeneration)
    mockUseAuthSession.mockImplementation(() => currentAuth)
    mockAuthedFetch.mockImplementation((url: string) =>
      Promise.resolve(
        url === '/api/push/subscribe/status' ? subscriptionStatus(false) : ok({ success: true })
      )
    )
    getSubscription.mockResolvedValue(subscription)
    subscribeBrowser.mockResolvedValue(subscription)
    requestPermission.mockResolvedValue('granted')
    Object.defineProperty(window, 'PushManager', {
      configurable: true,
      value: function PushManager() {},
    })
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: { permission: 'default', requestPermission },
    })
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve(registration) },
    })
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = 'AQ'
  })

  it('uses the server as truth and hides A state on the first B render', async () => {
    mockAuthedFetch.mockImplementation(
      (
        url: string,
        _method: string,
        _token: string,
        _body: unknown,
        _timeout: number,
        scope: { expectedUserId: string }
      ) =>
        Promise.resolve(
          url === '/api/push/subscribe/status'
            ? subscriptionStatus(scope.expectedUserId === 'user-a')
            : ok({ success: true })
        )
    )

    const view = render(<PushNotificationToggle onToast={onToast} />)
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'))

    const scopeB = synchronizeViewerScope(true, 'user-b')
    currentAuth = authFor('user-b', scopeB.sessionGeneration)
    view.rerender(<PushNotificationToggle onToast={onToast} />)

    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
    await waitFor(() => expect(getSubscription).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  })

  it('discards a delayed A status after B becomes current', async () => {
    const userAStatus = deferred<ReturnType<typeof subscriptionStatus>>()
    mockAuthedFetch.mockImplementation(
      (
        url: string,
        _method: string,
        _token: string,
        _body: unknown,
        _timeout: number,
        scope: { expectedUserId: string }
      ) => {
        if (url !== '/api/push/subscribe/status') return Promise.resolve(ok({ success: true }))
        return scope.expectedUserId === 'user-a'
          ? userAStatus.promise
          : Promise.resolve(subscriptionStatus(false))
      }
    )

    const view = render(<PushNotificationToggle onToast={onToast} />)
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))

    const scopeB = synchronizeViewerScope(true, 'user-b')
    currentAuth = authFor('user-b', scopeB.sessionGeneration)
    view.rerender(<PushNotificationToggle onToast={onToast} />)
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false'))

    await act(async () => userAStatus.resolve(subscriptionStatus(true)))
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  })

  it('stops after an A permission callback resolves under B', async () => {
    getSubscription.mockResolvedValue(null)
    const permission = deferred<NotificationPermission>()
    requestPermission.mockReturnValue(permission.promise)
    const view = render(<PushNotificationToggle onToast={onToast} />)
    await waitFor(() => expect(getSubscription).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false'))

    fireEvent.click(screen.getByRole('switch'))
    expect(requestPermission).toHaveBeenCalledTimes(1)

    const scopeB = synchronizeViewerScope(true, 'user-b')
    currentAuth = authFor('user-b', scopeB.sessionGeneration)
    view.rerender(<PushNotificationToggle onToast={onToast} />)
    await act(async () => permission.resolve('granted'))

    expect(subscribeBrowser).not.toHaveBeenCalled()
    expect(
      mockAuthedFetch.mock.calls.filter(
        ([url, method]) => url === '/api/push/subscribe' && method === 'POST'
      )
    ).toHaveLength(0)
    expect(onToast).not.toHaveBeenCalled()
  })

  it('does not record or toast an A server completion under B', async () => {
    const server = deferred<ReturnType<typeof ok>>()
    mockAuthedFetch.mockImplementation((url: string, method: string) => {
      if (url === '/api/push/subscribe/status') {
        return Promise.resolve(subscriptionStatus(false))
      }
      if (url === '/api/push/subscribe' && method === 'POST') return server.promise
      return Promise.resolve(ok({ success: true }))
    })
    const view = render(<PushNotificationToggle onToast={onToast} />)
    await waitFor(() => expect(getSubscription).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false'))

    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() =>
      expect(mockAuthedFetch).toHaveBeenCalledWith(
        '/api/push/subscribe',
        'POST',
        jwt('user-a'),
        expect.objectContaining({ endpoint }),
        15_000,
        expect.objectContaining({ expectedUserId: 'user-a' })
      )
    )

    const scopeB = synchronizeViewerScope(true, 'user-b')
    currentAuth = authFor('user-b', scopeB.sessionGeneration)
    view.rerender(<PushNotificationToggle onToast={onToast} />)
    await act(async () => server.resolve(ok({ success: true })))

    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
    expect(onToast).not.toHaveBeenCalled()
  })

  it('removes B server ownership without local registry and never destroys the browser subscription', async () => {
    const scopeB = synchronizeViewerScope(true, 'user-b')
    currentAuth = authFor('user-b', scopeB.sessionGeneration)
    mockAuthedFetch.mockImplementation((url: string) =>
      Promise.resolve(
        url === '/api/push/subscribe/status' ? subscriptionStatus(true) : ok({ success: true })
      )
    )

    render(<PushNotificationToggle onToast={onToast} />)
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'))
    fireEvent.click(screen.getByRole('switch'))

    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false'))
    expect(mockAuthedFetch).toHaveBeenCalledWith(
      '/api/push/subscribe',
      'DELETE',
      jwt('user-b'),
      { token: endpoint },
      15_000,
      expect.objectContaining({ expectedUserId: 'user-b' })
    )
    expect(unsubscribeBrowser).not.toHaveBeenCalled()
  })

  it('keeps an unknown server status disabled instead of presenting a false off state', async () => {
    mockAuthedFetch.mockResolvedValue({ ok: false, status: 503, data: null })

    const view = render(<PushNotificationToggle onToast={onToast} />)

    await waitFor(() => expect(view.container).toBeEmptyDOMElement())
  })

  it('renders nothing for a mismatched JWT subject', () => {
    currentAuth = authFor('user-a', currentAuth.sessionGeneration, 'user-b')

    const view = render(<PushNotificationToggle onToast={onToast} />)

    expect(view.container).toBeEmptyDOMElement()
    expect(getSubscription).not.toHaveBeenCalled()
  })
})
