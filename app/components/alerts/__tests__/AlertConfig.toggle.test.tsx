import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockFetch = jest.fn()
const mockShowToast = jest.fn()

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => ({ accessToken: 'access-token' }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      ({
        alertDisabled: 'Alerts disabled',
        alertEnabled: 'Alerts enabled',
        alertSettings: 'Alert settings',
        loading: 'Loading',
        saveFailed2: 'Save failed',
      })[key] ?? key,
  }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/lib/api/client', () => ({
  getCsrfHeaders: () => ({ 'X-CSRF-Token': 'csrf-token' }),
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
})
