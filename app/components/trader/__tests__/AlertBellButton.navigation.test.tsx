import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockFetch = jest.fn()
const mockOpenLoginModal = jest.fn()
const mockTrackEvent = jest.fn()
const mockAlertConfig = jest.fn(() => null)
let mockAuthState = {
  isLoggedIn: true,
  userId: 'user-1' as string | null,
  accessToken: 'access-token' as string | null,
}

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
  }: {
    open: boolean
    children: React.ReactNode
    label: string
  }) =>
    open ? (
      <div role="dialog" aria-label={label}>
        {children}
      </div>
    ) : null,
}))

jest.mock('@/lib/analytics/track', () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}))

import AlertBellButton from '../AlertBellButton'

describe('AlertBellButton durable navigation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = mockFetch
    mockAuthState = {
      isLoggedIn: true,
      userId: 'user-1',
      accessToken: 'access-token',
    }
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { alerts: [{ id: 'alert-1' }] } }),
    })
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
    expect(mockTrackEvent).toHaveBeenCalledWith('create_trader_alert', {
      traderId: 'trader-1',
      source: 'binance',
      step: 'open',
    })

    fireEvent.click(screen.getByRole('link', { name: 'View all alerts' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))
  })

  it('leaves signed-out users on the trader route by opening the login modal', () => {
    mockAuthState = {
      isLoggedIn: false,
      userId: null,
      accessToken: null,
    }

    render(<AlertBellButton traderId="trader-1" traderHandle="Trader One" source="binance" />)

    fireEvent.click(screen.getByRole('button', { name: 'Set alert' }))

    expect(mockOpenLoginModal).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('still opens configuration when the active-status check fails', async () => {
    mockFetch.mockRejectedValueOnce(new Error('temporary status failure'))

    render(<AlertBellButton traderId="trader-1" traderHandle="Trader One" source="binance" />)

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Set alert' }))

    expect(screen.getByRole('dialog', { name: 'Set alert' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View all alerts' })).toHaveAttribute(
      'href',
      '/saved?tab=alerts'
    )
  })
})
