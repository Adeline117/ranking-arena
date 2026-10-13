import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockAuthedFetch = jest.fn()
const mockOpenLoginModal = jest.fn()
const mockAlertConfig = jest.fn(() => null)

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

function signedOutAuth(sessionGeneration: number) {
  return {
    accessToken: null,
    authChecked: true,
    email: null,
    isLoggedIn: false,
    loading: false,
    sessionGeneration,
    userId: null,
    viewerKey: 'anon' as const,
  }
}

let mockAuthState: ReturnType<typeof authFor> | ReturnType<typeof signedOutAuth>

jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: () => (props: Record<string, unknown>) => {
    mockAlertConfig(props)
    return null
  },
}))

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuthState,
}))

jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
}))

// This suite exercises the legacy active-status and configuration flow. V1
// containment is covered separately with the real publication boundary false.
jest.mock('@/lib/alerts/trader-alert-publication', () => ({
  TRADER_ALERTS_PUBLISHED: true,
}))

jest.mock('@/lib/hooks/useLoginModal', () => ({
  useLoginModal: {
    getState: () => ({ openLoginModal: mockOpenLoginModal }),
  },
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      (
        ({
          alertsActive: 'Alerts active',
          setAlert: 'Set alert',
          viewAllAlerts: 'View all alerts',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

jest.mock('@/app/components/ui/ModalOverlay', () => ({
  __esModule: true,
  default: ({
    open,
    children,
    label,
    onClose,
  }: {
    open: boolean
    children: React.ReactNode
    label: string
    onClose: () => void
  }) =>
    open ? (
      <div role="dialog" aria-label={label}>
        {children}
        <button onClick={onClose}>Close alert dialog</button>
      </div>
    ) : null,
}))

import AlertBellButton from '../AlertBellButton'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  commitViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'

function ok(data: unknown) {
  return { ok: true, status: 200, data }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('AlertBellButton durable navigation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
    const scope = synchronizeViewerScope(true, 'user-1')
    mockAuthState = authFor('user-1', scope.sessionGeneration)
    mockAuthedFetch.mockResolvedValue(ok({ data: { alerts: [{ id: 'alert-1' }] } }))
  })

  it('keeps per-trader configuration in the modal and links to persisted alerts', async () => {
    render(<AlertBellButton traderId="trader-1" traderHandle="Trader One" source="binance" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Alerts active' }))

    expect(screen.getByRole('dialog', { name: 'Set alert' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View all alerts' })).toHaveAttribute(
      'href',
      '/saved?tab=alerts'
    )
    expect(mockAlertConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        traderId: 'trader-1',
        traderHandle: 'Trader One',
        source: 'binance',
        userId: 'user-1',
      })
    )
    fireEvent.click(screen.getByRole('link', { name: 'View all alerts' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))
  })

  it('leaves signed-out users on the trader route by opening the login modal', () => {
    const scope = synchronizeViewerScope(true, null)
    mockAuthState = signedOutAuth(scope.sessionGeneration)

    render(<AlertBellButton traderId="trader-1" traderHandle="Trader One" source="binance" />)

    fireEvent.click(screen.getByRole('button', { name: 'Set alert' }))

    expect(mockOpenLoginModal).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(mockAuthedFetch).not.toHaveBeenCalled()
  })

  it('still opens configuration when the active-status check fails', async () => {
    mockAuthedFetch.mockRejectedValueOnce(new Error('temporary status failure'))

    render(<AlertBellButton traderId="trader-1" traderHandle="Trader One" source="binance" />)

    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Set alert' }))

    expect(screen.getByRole('dialog', { name: 'Set alert' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View all alerts' })).toHaveAttribute(
      'href',
      '/saved?tab=alerts'
    )
  })

  it('fails empty and closes A configuration on the first B render', async () => {
    const userB = deferred<ReturnType<typeof ok>>()
    mockAuthedFetch.mockImplementation(
      (
        _url: string,
        _method: string,
        _token: string,
        _body: unknown,
        _timeout: number,
        scope: { expectedUserId: string }
      ) =>
        scope.expectedUserId === 'user-1'
          ? Promise.resolve(ok({ data: { alerts: [{ id: 'alert-a' }] } }))
          : userB.promise
    )

    const view = render(
      <AlertBellButton traderId="trader-1" traderHandle="Trader One" source="binance" />
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Alerts active' }))
    expect(screen.getByRole('dialog', { name: 'Set alert' })).toBeInTheDocument()

    const scopeB = synchronizeViewerScope(true, 'user-2')
    mockAuthState = authFor('user-2', scopeB.sessionGeneration)
    view.rerender(
      <AlertBellButton traderId="trader-1" traderHandle="Trader One" source="binance" />
    )

    expect(screen.getByRole('button', { name: 'Set alert' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await act(async () => userB.resolve(ok({ data: { alerts: [] } })))
    expect(screen.getByRole('button', { name: 'Set alert' })).toBeEnabled()
  })

  it('fails empty and closes configuration for a new generation of the same user', async () => {
    const nextGenerationStatus = deferred<ReturnType<typeof ok>>()
    const view = render(
      <AlertBellButton traderId="trader-1" traderHandle="Trader One" source="binance" />
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Alerts active' }))
    expect(screen.getByRole('dialog', { name: 'Set alert' })).toBeInTheDocument()

    mockAuthedFetch.mockReturnValueOnce(nextGenerationStatus.promise)
    const pendingGeneration = beginViewerTransition('user-1')
    const nextScope = commitViewerTransition(pendingGeneration, 'user-1')
    expect(nextScope).not.toBeNull()
    mockAuthState = authFor('user-1', nextScope!.sessionGeneration)
    view.rerender(
      <AlertBellButton traderId="trader-1" traderHandle="Trader One" source="binance" />
    )

    expect(screen.getByRole('button', { name: 'Set alert' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await act(async () => nextGenerationStatus.resolve(ok({ data: { alerts: [] } })))
    expect(screen.getByRole('button', { name: 'Set alert' })).toBeEnabled()
    expect(mockAuthedFetch).toHaveBeenLastCalledWith(
      expect.stringContaining('/api/trader-alerts?'),
      'GET',
      jwt('user-1'),
      undefined,
      15_000,
      expect.objectContaining({ expectedSessionGeneration: nextScope!.sessionGeneration })
    )
  })

  it('discards a delayed A status response after B becomes current', async () => {
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
        scope.expectedUserId === 'user-1'
          ? userA.promise
          : Promise.resolve(ok({ data: { alerts: [] } }))
    )

    const view = render(
      <AlertBellButton traderId="trader-1" traderHandle="Trader One" source="binance" />
    )
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))

    const scopeB = synchronizeViewerScope(true, 'user-2')
    mockAuthState = authFor('user-2', scopeB.sessionGeneration)
    view.rerender(
      <AlertBellButton traderId="trader-1" traderHandle="Trader One" source="binance" />
    )
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(2))

    await act(async () => userA.resolve(ok({ data: { alerts: [{ id: 'alert-a' }] } })))
    expect(screen.getByRole('button', { name: 'Set alert' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
  })

  it('rejects old-resource status before passive cleanup once render authority advances', async () => {
    const refreshA = deferred<ReturnType<typeof ok>>()
    render(<AlertBellButton traderId="trader-a" traderHandle="Trader A" source="binance" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Alerts active' }))
    const configProps = mockAlertConfig.mock.calls.at(-1)?.[0] as {
      resourceScopeRef: { current: string }
    }
    expect(configProps.resourceScopeRef.current).toBe(
      `user:user-1\u0000${mockAuthState.sessionGeneration}\u0000trader-a\u0000binance`
    )

    mockAuthedFetch.mockReturnValueOnce(refreshA.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Close alert dialog' }))
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('button', { name: 'Set alert' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )

    // This is the same ref AlertBellButton updates synchronously during a
    // trader/source render, before the old effect's passive cleanup runs.
    configProps.resourceScopeRef.current = `user:user-1\u0000${mockAuthState.sessionGeneration}\u0000trader-b\u0000binance`
    await act(async () => refreshA.resolve(ok({ data: { alerts: [{ id: 'stale-alert-a' }] } })))

    expect(screen.getByRole('button', { name: 'Set alert' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
  })
})
