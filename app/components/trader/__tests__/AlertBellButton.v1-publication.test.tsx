import { fireEvent, render, screen } from '@testing-library/react'

const mockAuthedFetch = jest.fn()
const mockAlertConfig = jest.fn()

function jwt(userId: string): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${encode({ alg: 'none' })}.${encode({ sub: userId })}.signature`
}

let mockAuthState: {
  accessToken: string
  authChecked: boolean
  email: string
  loading: boolean
  sessionGeneration: number
  userId: string
  viewerKey: `user:${string}`
}

jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: () => (props: Record<string, unknown>) => {
    mockAlertConfig(props)
    return <p>Unavailable alert configuration</p>
  },
}))

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string
  }) => (
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

jest.mock('@/lib/hooks/useLoginModal', () => ({
  useLoginModal: { getState: () => ({ openLoginModal: jest.fn() }) },
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      (
        ({
          traderAlertsUnavailableTitle: 'Trader alerts are unavailable',
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

import AlertBellButton from '../AlertBellButton'
import { TRADER_ALERTS_PUBLISHED } from '@/lib/alerts/trader-alert-publication'
import { __resetViewerScopeForTests, synchronizeViewerScope } from '@/lib/auth/viewer-scope'

describe('AlertBellButton V1 publication boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
    const scope = synchronizeViewerScope(true, 'user-1')
    mockAuthState = {
      accessToken: jwt('user-1'),
      authChecked: true,
      email: 'user-1@example.com',
      loading: false,
      sessionGeneration: scope.sessionGeneration,
      userId: 'user-1',
      viewerKey: 'user:user-1',
    }
  })

  it('does not request active status or imply a configurable active alert by default', () => {
    expect(TRADER_ALERTS_PUBLISHED).toBe(false)

    render(<AlertBellButton traderId="trader-1" traderHandle="Trader One" source="binance" />)

    const bell = screen.getByRole('button', { name: 'Trader alerts are unavailable' })
    expect(bell).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('button', { name: 'Set alert' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Alerts active' })).not.toBeInTheDocument()
    expect(mockAuthedFetch).not.toHaveBeenCalled()
    expect(mockAlertConfig).not.toHaveBeenCalled()

    fireEvent.click(bell)

    expect(screen.getByRole('dialog', { name: 'Trader alerts are unavailable' })).toBeVisible()
    expect(screen.getByText('Unavailable alert configuration')).toBeVisible()
    expect(screen.getByRole('link', { name: 'View all alerts' })).toHaveAttribute(
      'href',
      '/saved?tab=alerts'
    )
    expect(mockAuthedFetch).not.toHaveBeenCalled()
  })
})
