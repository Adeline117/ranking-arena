import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockAuthedFetch = jest.fn()
const mockShowToast = jest.fn()
const mockUseAuthSession = jest.fn()
const mockTranslations: Record<string, string> = {
  adminLoadFailed: 'Failed to load alerts',
  alertDisabled: 'Alerts disabled',
  alertEnabled: 'Alerts enabled',
  alertSettings: 'Alert settings',
  delete: 'Delete',
  loading: 'Loading',
  loginRequired: 'Login required',
  pricingProAlerts: 'Real-time trader alerts',
  save: 'Save',
  saveFailed2: 'Save failed',
  traderAlertsProRequired: 'Trader alerts require Pro',
  upgrade: 'Upgrade',
}
const mockT = (key: string) => mockTranslations[key] ?? key

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockUseAuthSession(),
}))

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: mockT }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
}))

jest.mock('@/app/components/ui/ErrorMessage', () => ({
  __esModule: true,
  default: ({ message, onRetry }: { message: string; onRetry?: () => void }) => (
    <div role="alert">
      <span>{message}</span>
      {onRetry && <button onClick={onRetry}>Retry</button>}
    </div>
  ),
}))

jest.mock('@/app/components/ui/EmptyState', () => ({
  __esModule: true,
  default: ({
    title,
    description,
    action,
  }: {
    title: string
    description?: string
    action?: React.ReactNode
  }) => (
    <section>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </section>
  ),
}))

jest.mock('../../base', () => {
  const React = jest.requireActual<typeof import('react')>('react')
  return {
    Box: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) =>
      React.createElement('div', props, children),
    Text: ({ children, ...props }: React.HTMLAttributes<HTMLSpanElement>) =>
      React.createElement('span', props, children),
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
      React.createElement('button', props, children),
  }
})

jest.mock('../AlertRowComponents', () => ({
  AlertRow: () => null,
}))

jest.mock('../AlertHistory', () => ({
  AlertHistory: ({ history }: { history: unknown[] }) => (
    <div data-testid="history">{history.length}</div>
  ),
}))

import AlertConfig from '../AlertConfig'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  commitViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'

function jwt(userId: string): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${encode({ alg: 'none' })}.${encode({ sub: userId })}.signature`
}

function authFor(userId: string, sessionGeneration: number) {
  return {
    accessToken: jwt(userId),
    authChecked: true,
    email: `${userId}@example.com`,
    isLoggedIn: true,
    loading: false,
    sessionGeneration,
    userId,
    viewerKey: `user:${userId}` as const,
  }
}

function resourceScopeKey(
  userId: string,
  sessionGeneration: number,
  traderId: string,
  source = 'binance'
): string {
  return `user:${userId}\u0000${sessionGeneration}\u0000${traderId}\u0000${source}`
}

function result(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    data: body,
  }
}

function mutationResult(data: unknown) {
  return result({ success: true, data })
}

function existingAlert(enabled = true, id = 'alert-1') {
  return {
    id,
    trader_id: 'trader-1',
    source: 'binance',
    alert_roi_change: true,
    roi_change_threshold: 10,
    alert_drawdown: true,
    drawdown_threshold: 20,
    alert_score_change: false,
    score_change_threshold: 5,
    alert_rank_change: false,
    rank_change_threshold: 5,
    one_time: false,
    enabled,
  }
}

function loadResponses(enabled = true, id = 'alert-1') {
  mockAuthedFetch
    .mockResolvedValueOnce(result({ data: { alerts: [existingAlert(enabled, id)] } }))
    .mockResolvedValueOnce(result({ data: { history: [] } }))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, reject, resolve }
}

async function renderLoadedConfig() {
  render(
    <AlertConfig traderId="trader-1" traderHandle="Trader One" source="binance" userId="user-1" />
  )
  const toggle = await screen.findByRole('button', { name: 'Alerts enabled' })
  await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(2))
  return toggle
}

describe('AlertConfig enable toggle', () => {
  let currentAuth: ReturnType<typeof authFor>

  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
    const scope = synchronizeViewerScope(true, 'user-1')
    currentAuth = authFor('user-1', scope.sessionGeneration)
    mockUseAuthSession.mockImplementation(() => currentAuth)
  })

  it('shows a load failure and recovers through the visible retry action', async () => {
    mockAuthedFetch
      .mockResolvedValueOnce(result({ error: 'Alerts service unavailable' }, 503))
      .mockResolvedValueOnce(result({ data: { alerts: [existingAlert()] } }))
      .mockResolvedValueOnce(result({ data: { history: [] } }))

    render(<AlertConfig traderId="trader-1" traderHandle="Trader One" userId="user-1" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Alerts service unavailable')
    expect(mockShowToast).toHaveBeenCalledWith('Alerts service unavailable', 'error')

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByRole('button', { name: 'Alerts enabled' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not spin forever when the authenticated token is unavailable', async () => {
    currentAuth = { ...currentAuth, accessToken: null } as unknown as ReturnType<typeof authFor>

    render(<AlertConfig traderId="trader-1" traderHandle="Trader One" userId="user-1" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Login required')
    expect(screen.queryByText('Loading')).not.toBeInTheDocument()
    expect(mockAuthedFetch).not.toHaveBeenCalled()
  })

  it('turns a server 403 into the Pro conversion state', async () => {
    mockAuthedFetch.mockResolvedValueOnce(result({ error: 'Pro membership required' }, 403))

    render(<AlertConfig traderId="trader-1" traderHandle="Trader One" userId="user-1" />)

    expect(await screen.findByRole('heading', { name: 'Trader alerts require Pro' })).toBeVisible()
    expect(screen.getByText('Real-time trader alerts')).toBeVisible()
    expect(screen.getByRole('link', { name: 'Upgrade' })).toHaveAttribute('href', '/pricing')
    expect(mockShowToast).not.toHaveBeenCalled()
  })

  it('rolls back a failed server update and never reports success', async () => {
    loadResponses()
    mockAuthedFetch.mockResolvedValueOnce(result({ error: 'Pro membership required' }, 403))
    const toggle = await renderLoadedConfig()

    fireEvent.click(toggle)

    expect(await screen.findByRole('button', { name: 'Alerts enabled' })).toBeEnabled()
    expect(mockShowToast).toHaveBeenCalledWith('Pro membership required', 'error')
    expect(mockShowToast).not.toHaveBeenCalledWith('Alerts disabled', 'success')
  })

  it('rolls back a network failure', async () => {
    loadResponses()
    mockAuthedFetch.mockRejectedValueOnce(new Error('Network unavailable'))
    const toggle = await renderLoadedConfig()

    fireEvent.click(toggle)

    expect(await screen.findByRole('button', { name: 'Alerts enabled' })).toBeEnabled()
    expect(mockShowToast).toHaveBeenCalledWith('Network unavailable', 'error')
    expect(mockShowToast).not.toHaveBeenCalledWith('Alerts disabled', 'success')
  })

  it('deduplicates rapid clicks while the toggle request is in flight', async () => {
    const toggleResponse = deferred<ReturnType<typeof result>>()
    loadResponses()
    mockAuthedFetch.mockReturnValueOnce(toggleResponse.promise)
    const toggle = await renderLoadedConfig()

    fireEvent.click(toggle)
    fireEvent.click(toggle)
    expect(mockAuthedFetch).toHaveBeenCalledTimes(3)

    await act(async () => {
      toggleResponse.resolve(mutationResult({ alert: existingAlert(false) }))
    })

    expect(await screen.findByRole('button', { name: 'Alerts disabled' })).toBeEnabled()
    expect(mockShowToast).toHaveBeenCalledWith('Alerts disabled', 'success')
    expect(mockAuthedFetch).toHaveBeenCalledTimes(3)
  })

  it('keeps the alert and reports the server error when delete returns non-2xx', async () => {
    loadResponses()
    mockAuthedFetch.mockResolvedValueOnce(result({ error: 'Delete blocked' }, 503))
    await renderLoadedConfig()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith('Delete blocked', 'error')
    })
    expect(mockShowToast).not.toHaveBeenCalledWith('Alerts disabled', 'success')
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
    expect(mockAuthedFetch).toHaveBeenLastCalledWith(
      '/api/trader-alerts?id=alert-1',
      'DELETE',
      jwt('user-1'),
      undefined,
      15_000,
      expect.objectContaining({
        expectedSessionGeneration: currentAuth.sessionGeneration,
        expectedUserId: 'user-1',
      })
    )
  })

  it.each([
    {
      action: 'save',
      click: () => screen.getByRole('button', { name: 'Save' }),
      malformedAck: { success: true, data: { alert: { enabled: true } } },
    },
    {
      action: 'delete',
      click: () => screen.getByRole('button', { name: 'Delete' }),
      malformedAck: { success: true, deleted: true },
    },
    {
      action: 'toggle',
      click: () => screen.getByRole('button', { name: 'Alerts enabled' }),
      malformedAck: { success: true, data: { alert: { enabled: false } } },
    },
  ])(
    'keeps the alert and reports an error for a malformed 2xx $action acknowledgement',
    async ({ click, malformedAck }) => {
      loadResponses()
      mockAuthedFetch.mockResolvedValueOnce(result(malformedAck))
      await renderLoadedConfig()

      fireEvent.click(click())

      expect(await screen.findByRole('button', { name: 'Alerts enabled' })).toBeEnabled()
      expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
      expect(mockShowToast).toHaveBeenCalledWith('Save failed', 'error')
      expect(mockShowToast).not.toHaveBeenCalledWith('Alerts disabled', 'success')
      expect(mockShowToast).not.toHaveBeenCalledWith('Alerts enabled', 'success')
    }
  )

  it.each([
    {
      action: 'save without success',
      click: () => screen.getByRole('button', { name: 'Save' }),
      malformedAck: { data: { alert: existingAlert(true) } },
      expectedError: 'Save failed',
    },
    {
      action: 'delete without success',
      click: () => screen.getByRole('button', { name: 'Delete' }),
      malformedAck: { data: { deleted: true } },
      expectedError: 'Save failed',
    },
    {
      action: 'toggle without success',
      click: () => screen.getByRole('button', { name: 'Alerts enabled' }),
      malformedAck: { data: { alert: existingAlert(false) } },
      expectedError: 'Save failed',
    },
    {
      action: 'save with root error',
      click: () => screen.getByRole('button', { name: 'Save' }),
      malformedAck: {
        success: true,
        error: 'Mutation rejected',
        data: { alert: existingAlert(true) },
      },
      expectedError: 'Mutation rejected',
    },
    {
      action: 'delete with root error',
      click: () => screen.getByRole('button', { name: 'Delete' }),
      malformedAck: {
        success: true,
        error: 'Mutation rejected',
        data: { deleted: true },
      },
      expectedError: 'Mutation rejected',
    },
    {
      action: 'toggle with root error',
      click: () => screen.getByRole('button', { name: 'Alerts enabled' }),
      malformedAck: {
        success: true,
        error: 'Mutation rejected',
        data: { alert: existingAlert(false) },
      },
      expectedError: 'Mutation rejected',
    },
  ])(
    'rejects a 2xx $action envelope even when its nested acknowledgement looks valid',
    async ({ click, expectedError, malformedAck }) => {
      loadResponses()
      mockAuthedFetch.mockResolvedValueOnce(result(malformedAck))
      await renderLoadedConfig()

      fireEvent.click(click())

      expect(await screen.findByRole('button', { name: 'Alerts enabled' })).toBeEnabled()
      expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
      expect(mockShowToast).toHaveBeenCalledWith(expectedError, 'error')
      expect(mockShowToast).not.toHaveBeenCalledWith('Alerts disabled', 'success')
      expect(mockShowToast).not.toHaveBeenCalledWith('Alerts enabled', 'success')
    }
  )

  it('deletes only after the wrapped acknowledgement confirms deletion', async () => {
    loadResponses()
    mockAuthedFetch.mockResolvedValueOnce(mutationResult({ deleted: true }))
    await renderLoadedConfig()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
    )
    expect(mockShowToast).toHaveBeenCalledWith('Alerts disabled', 'success')
  })

  it('discards A load data when it resolves after B is rendered', async () => {
    const loadA = deferred<ReturnType<typeof result>>()
    mockAuthedFetch.mockImplementation(
      (
        _url: string,
        method: string,
        _token: string,
        _body: unknown,
        _timeout: number,
        scope: { expectedUserId: string }
      ) => {
        if (method !== 'GET') throw new Error('unexpected mutation')
        return scope.expectedUserId === 'user-1'
          ? loadA.promise
          : Promise.resolve(result({ data: { alerts: [] } }))
      }
    )

    const view = render(
      <AlertConfig traderId="trader-1" traderHandle="Trader One" userId="user-1" />
    )
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))

    const scopeB = synchronizeViewerScope(true, 'user-2')
    currentAuth = authFor('user-2', scopeB.sessionGeneration)
    view.rerender(<AlertConfig traderId="trader-1" traderHandle="Trader One" userId="user-2" />)
    expect(await screen.findByRole('button', { name: 'Save' })).toBeInTheDocument()

    await act(async () => {
      loadA.resolve(result({ data: { alerts: [existingAlert(true, 'alert-a')] } }))
    })

    expect(screen.queryByRole('button', { name: 'Alerts enabled' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
    expect(mockShowToast).not.toHaveBeenCalled()
  })

  it('fails empty and rejects an old load for a new generation of the same user', async () => {
    const oldGeneration = currentAuth.sessionGeneration
    const oldLoad = deferred<ReturnType<typeof result>>()
    mockAuthedFetch.mockImplementation(
      (
        _url: string,
        method: string,
        _token: string,
        _body: unknown,
        _timeout: number,
        scope: { expectedSessionGeneration: number }
      ) => {
        if (method !== 'GET') throw new Error('unexpected mutation')
        return scope.expectedSessionGeneration === oldGeneration
          ? oldLoad.promise
          : Promise.resolve(result({ data: { alerts: [] } }))
      }
    )

    const view = render(
      <AlertConfig traderId="trader-1" traderHandle="Trader One" userId="user-1" />
    )
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))

    const pendingGeneration = beginViewerTransition('user-1')
    const nextScope = commitViewerTransition(pendingGeneration, 'user-1')
    expect(nextScope).not.toBeNull()
    currentAuth = authFor('user-1', nextScope!.sessionGeneration)
    view.rerender(<AlertConfig traderId="trader-1" traderHandle="Trader One" userId="user-1" />)

    expect(await screen.findByRole('button', { name: 'Save' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()

    await act(async () => {
      oldLoad.resolve(result({ data: { alerts: [existingAlert(true, 'old-generation')] } }))
    })

    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
    expect(mockShowToast).not.toHaveBeenCalled()
    expect(mockAuthedFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/trader-alerts?'),
      'GET',
      jwt('user-1'),
      undefined,
      15_000,
      expect.objectContaining({ expectedSessionGeneration: nextScope!.sessionGeneration })
    )
  })

  it('rejects a resource A load after the render scope advances and before cleanup', async () => {
    const loadA = deferred<ReturnType<typeof result>>()
    const resourceScopeRef = {
      current: resourceScopeKey('user-1', currentAuth.sessionGeneration, 'trader-a'),
    }
    mockAuthedFetch.mockReturnValueOnce(loadA.promise)

    const view = render(
      <AlertConfig
        traderId="trader-a"
        traderHandle="Trader A"
        source="binance"
        userId="user-1"
        resourceScopeRef={resourceScopeRef}
      />
    )
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))

    // The parent updates this authority ref during render. Resolve the old
    // transport before rerender/unmount so passive-effect cleanup cannot help.
    resourceScopeRef.current = resourceScopeKey('user-1', currentAuth.sessionGeneration, 'trader-b')
    await act(async () => {
      loadA.resolve(result({ data: { alerts: [existingAlert(true, 'alert-a')] } }))
    })

    expect(screen.getByText('Loading')).toBeInTheDocument()
    expect(mockShowToast).not.toHaveBeenCalled()

    mockAuthedFetch.mockResolvedValueOnce(result({ data: { alerts: [] } }))
    view.rerender(
      <AlertConfig
        traderId="trader-b"
        traderHandle="Trader B"
        source="binance"
        userId="user-1"
        resourceScopeRef={resourceScopeRef}
      />
    )
    expect(await screen.findByRole('button', { name: 'Save' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
  })

  it.each([
    {
      action: 'save',
      click: () => screen.getByRole('button', { name: 'Save' }),
      response: () => mutationResult({ alert: existingAlert(true, 'alert-a') }),
    },
    {
      action: 'delete',
      click: () => screen.getByRole('button', { name: 'Delete' }),
      response: () => mutationResult({ deleted: true }),
    },
    {
      action: 'toggle',
      click: () => screen.getByRole('button', { name: 'Alerts enabled' }),
      response: () => mutationResult({ alert: existingAlert(false, 'alert-a') }),
    },
  ])(
    'rejects resource A $action completion after render authority changes but before cleanup',
    async ({ click, response: mutationResponse }) => {
      const mutationA = deferred<ReturnType<typeof result>>()
      const resourceScopeRef = {
        current: resourceScopeKey('user-1', currentAuth.sessionGeneration, 'trader-a'),
      }
      loadResponses(true, 'alert-a')
      mockAuthedFetch.mockReturnValueOnce(mutationA.promise)

      const view = render(
        <AlertConfig
          traderId="trader-a"
          traderHandle="Trader A"
          source="binance"
          userId="user-1"
          resourceScopeRef={resourceScopeRef}
        />
      )
      await screen.findByRole('button', { name: 'Alerts enabled' })
      fireEvent.click(click())
      await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(3))

      resourceScopeRef.current = resourceScopeKey(
        'user-1',
        currentAuth.sessionGeneration,
        'trader-b'
      )
      await act(async () => mutationA.resolve(mutationResponse()))
      expect(mockShowToast).not.toHaveBeenCalled()

      mockAuthedFetch
        .mockResolvedValueOnce(result({ data: { alerts: [existingAlert(true, 'alert-b')] } }))
        .mockResolvedValueOnce(result({ data: { history: [] } }))
      view.rerender(
        <AlertConfig
          traderId="trader-b"
          traderHandle="Trader B"
          source="binance"
          userId="user-1"
          resourceScopeRef={resourceScopeRef}
        />
      )

      expect(await screen.findByRole('button', { name: 'Alerts enabled' })).toBeEnabled()
      expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
      expect(mockShowToast).not.toHaveBeenCalled()
    }
  )

  it.each([
    {
      action: 'save',
      click: () => screen.getByRole('button', { name: 'Save' }),
      response: () => mutationResult({ alert: existingAlert(true, 'alert-a') }),
      successToast: 'Alerts enabled',
    },
    {
      action: 'delete',
      click: () => screen.getByRole('button', { name: 'Delete' }),
      response: () => mutationResult({ deleted: true }),
      successToast: 'Alerts disabled',
    },
    {
      action: 'toggle',
      click: () => screen.getByRole('button', { name: 'Alerts enabled' }),
      response: () => mutationResult({ alert: existingAlert(false, 'alert-a') }),
      successToast: 'Alerts disabled',
    },
  ])(
    'does not commit or toast an in-flight A $action after switching to B',
    async ({ action, click, response: mutationResponse, successToast }) => {
      const mutationA = deferred<ReturnType<typeof result>>()
      mockAuthedFetch.mockImplementation(
        (
          url: string,
          method: string,
          _token: string,
          _body: unknown,
          _timeout: number,
          scope: { expectedUserId: string }
        ) => {
          if (scope.expectedUserId === 'user-1') {
            if (method !== 'GET') return mutationA.promise
            if (url.startsWith('/api/alerts?')) {
              return Promise.resolve(result({ data: { history: [] } }))
            }
            return Promise.resolve(result({ data: { alerts: [existingAlert(true, 'alert-a')] } }))
          }
          if (method === 'DELETE') {
            return Promise.resolve(mutationResult({ deleted: true }))
          }
          if (url.startsWith('/api/alerts?')) {
            return Promise.resolve(result({ data: { history: [] } }))
          }
          return Promise.resolve(result({ data: { alerts: [existingAlert(true, 'alert-b')] } }))
        }
      )

      const view = render(
        <AlertConfig
          traderId="trader-1"
          traderHandle="Trader One"
          source="binance"
          userId="user-1"
        />
      )
      await screen.findByRole('button', { name: 'Alerts enabled' })
      fireEvent.click(click())
      await waitFor(() =>
        expect(mockAuthedFetch).toHaveBeenCalledWith(
          expect.any(String),
          expect.stringMatching(/POST|DELETE/),
          jwt('user-1'),
          action === 'delete' ? undefined : expect.anything(),
          15_000,
          expect.objectContaining({ expectedUserId: 'user-1' })
        )
      )

      const scopeB = synchronizeViewerScope(true, 'user-2')
      currentAuth = authFor('user-2', scopeB.sessionGeneration)
      view.rerender(
        <AlertConfig
          traderId="trader-1"
          traderHandle="Trader One"
          source="binance"
          userId="user-2"
        />
      )
      expect(await screen.findByRole('button', { name: 'Alerts enabled' })).toBeEnabled()
      expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()

      await act(async () => mutationA.resolve(mutationResponse()))

      expect(screen.getByRole('button', { name: 'Alerts enabled' })).toBeEnabled()
      expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
      expect(mockShowToast).not.toHaveBeenCalledWith(successToast, 'success')
      expect(mockShowToast).not.toHaveBeenCalled()

      if (action === 'save') {
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
        await waitFor(() =>
          expect(mockAuthedFetch).toHaveBeenCalledWith(
            '/api/trader-alerts?id=alert-b',
            'DELETE',
            jwt('user-2'),
            undefined,
            15_000,
            expect.objectContaining({ expectedUserId: 'user-2' })
          )
        )
      }
    }
  )
})
