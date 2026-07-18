import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockFetch = jest.fn()
const mockShowToast = jest.fn()
const mockUseAuthSession = jest.fn(() => ({ accessToken: 'access-token' }))
const mockTranslations: Record<string, string> = {
  adminLoadFailed: 'Failed to load alerts',
  alertDisabled: 'Alerts disabled',
  alertEnabled: 'Alerts enabled',
  alertSettings: 'Alert settings',
  delete: 'Delete',
  loading: 'Loading',
  loginRequired: 'Login required',
  pricingProAlerts: 'Real-time trader alerts',
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
  getCsrfHeaders: () => ({ 'X-CSRF-Token': 'csrf-token' }),
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

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response
}

function existingAlert(enabled = true) {
  return {
    id: 'alert-1',
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

function loadResponses() {
  mockFetch
    .mockResolvedValueOnce(response({ data: { alerts: [existingAlert()] } }))
    .mockResolvedValueOnce(response({ data: { history: [] } }))
}

async function renderLoadedConfig() {
  render(
    <AlertConfig traderId="trader-1" traderHandle="Trader One" source="binance" userId="user-1" />
  )
  const toggle = await screen.findByRole('button', { name: 'Alerts enabled' })
  await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
  return toggle
}

describe('AlertConfig enable toggle', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = mockFetch
    mockUseAuthSession.mockReturnValue({ accessToken: 'access-token' })
  })

  it('shows a load failure and recovers through the visible retry action', async () => {
    mockFetch
      .mockResolvedValueOnce(response({ error: 'Alerts service unavailable' }, 503))
      .mockResolvedValueOnce(response({ data: { alerts: [existingAlert()] } }))
      .mockResolvedValueOnce(response({ data: { history: [] } }))

    render(<AlertConfig traderId="trader-1" traderHandle="Trader One" userId="user-1" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Alerts service unavailable')
    expect(mockShowToast).toHaveBeenCalledWith('Alerts service unavailable', 'error')

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByRole('button', { name: 'Alerts enabled' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not spin forever when the authenticated token is unavailable', async () => {
    mockUseAuthSession.mockReturnValue({ accessToken: null })

    render(<AlertConfig traderId="trader-1" traderHandle="Trader One" userId="user-1" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Login required')
    expect(screen.queryByText('Loading')).not.toBeInTheDocument()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('turns a server 403 into the Pro conversion state', async () => {
    mockFetch.mockResolvedValueOnce(response({ error: 'Pro membership required' }, 403))

    render(<AlertConfig traderId="trader-1" traderHandle="Trader One" userId="user-1" />)

    expect(await screen.findByRole('heading', { name: 'Trader alerts require Pro' })).toBeVisible()
    expect(screen.getByText('Real-time trader alerts')).toBeVisible()
    expect(screen.getByRole('link', { name: 'Upgrade' })).toHaveAttribute('href', '/pricing')
    expect(mockShowToast).not.toHaveBeenCalled()
  })

  it('rolls back a failed server update and never reports success', async () => {
    loadResponses()
    mockFetch.mockResolvedValueOnce(response({ error: 'Pro membership required' }, 403))
    const toggle = await renderLoadedConfig()

    fireEvent.click(toggle)

    expect(await screen.findByRole('button', { name: 'Alerts enabled' })).toBeEnabled()
    expect(mockShowToast).toHaveBeenCalledWith('Pro membership required', 'error')
    expect(mockShowToast).not.toHaveBeenCalledWith('Alerts disabled', 'success')
  })

  it('rolls back a network failure', async () => {
    loadResponses()
    mockFetch.mockRejectedValueOnce(new Error('Network unavailable'))
    const toggle = await renderLoadedConfig()

    fireEvent.click(toggle)

    expect(await screen.findByRole('button', { name: 'Alerts enabled' })).toBeEnabled()
    expect(mockShowToast).toHaveBeenCalledWith('Network unavailable', 'error')
    expect(mockShowToast).not.toHaveBeenCalledWith('Alerts disabled', 'success')
  })

  it('deduplicates rapid clicks while the toggle request is in flight', async () => {
    let resolveToggle!: (value: Response) => void
    const toggleResponse = new Promise<Response>((resolve) => {
      resolveToggle = resolve
    })
    loadResponses()
    mockFetch.mockReturnValueOnce(toggleResponse)
    const toggle = await renderLoadedConfig()

    fireEvent.click(toggle)
    fireEvent.click(toggle)
    expect(mockFetch).toHaveBeenCalledTimes(3)

    await act(async () => {
      resolveToggle(response({ data: { alert: existingAlert(false) } }))
    })

    expect(await screen.findByRole('button', { name: 'Alerts disabled' })).toBeEnabled()
    expect(mockShowToast).toHaveBeenCalledWith('Alerts disabled', 'success')
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })

  it('keeps the alert and reports the server error when delete returns non-2xx', async () => {
    loadResponses()
    mockFetch.mockResolvedValueOnce(response({ error: 'Delete blocked' }, 503))
    await renderLoadedConfig()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith('Delete blocked', 'error')
    })
    expect(mockShowToast).not.toHaveBeenCalledWith('Alerts disabled', 'success')
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
    expect(mockFetch).toHaveBeenLastCalledWith(
      '/api/trader-alerts?id=alert-1',
      expect.objectContaining({ method: 'DELETE' })
    )
  })
})
