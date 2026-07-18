import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { FreshnessReport } from '@/lib/rankings/freshness-report'

const mockLoadFreshnessReport = jest.fn().mockResolvedValue(true)
const mockLoadApplications = jest.fn().mockResolvedValue(undefined)
const mockLoadEditApplications = jest.fn().mockResolvedValue(undefined)
const mockUseFreshness = jest.fn()
const mockScraperStatusTab = jest.fn()

const translations: Record<string, string> = {
  adminDashboard: 'Admin Dashboard',
  adminScraperAlertA11y: '{count} sources or checks need attention',
  alertConfig: 'Alert Config',
  auditLog: 'Audit Log',
  contentReports: 'Content Reports',
  dashboard: 'Dashboard',
  groupApplications: 'Group Applications',
  groupEdits: 'Group Edits',
  moderationQueue: 'Moderation Queue',
  scraperStatus: 'Scraper Status',
  traderClaims: 'Trader Claims',
  userManagement: 'User Management',
}

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => translations[key] ?? key }),
}))

jest.mock('@/app/components/base', () => {
  const React = jest.requireActual<typeof import('react')>('react')
  return {
    Box: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) =>
      React.createElement('div', props, children),
    Text: ({
      as,
      children,
      color: _color,
      size: _size,
      weight: _weight,
      ...props
    }: React.HTMLAttributes<HTMLElement> & {
      as?: keyof HTMLElementTagNameMap
      color?: string
      size?: string
      weight?: string
    }) => React.createElement(as || 'span', props, children),
    Button: ({
      children,
      size: _size,
      variant: _variant,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
      size?: string
      variant?: string
    }) => React.createElement('button', props, children),
  }
})

jest.mock('../hooks/useAdminAuth', () => ({
  useAdminAuth: () => ({
    accessToken: 'admin-token',
    isAdmin: true,
    authChecking: false,
  }),
}))

jest.mock('../hooks/useFreshness', () => ({
  useFreshness: (...args: unknown[]) => mockUseFreshness(...args),
}))

jest.mock('../hooks/useApplications', () => ({
  useApplications: () => ({
    applications: [],
    editApplications: [],
    loadApplications: mockLoadApplications,
    loadEditApplications: mockLoadEditApplications,
  }),
}))

jest.mock('../components/AdminTabs', () => ({
  __esModule: true,
  default: ({
    tabs,
    active,
    onChange,
    label,
  }: {
    tabs: Array<{ id: string; label: ReactNode; ariaLabel: string }>
    active: string
    onChange: (id: string) => void
    label: string
  }) => (
    <nav aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          aria-label={tab.ariaLabel}
          aria-selected={active === tab.id}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  ),
  tabButtonId: (prefix: string, id: string) => `${prefix}-${id}-tab`,
  tabPanelId: (prefix: string, id: string) => `${prefix}-${id}-panel`,
}))

jest.mock('../components/ScraperStatusTab', () => ({
  __esModule: true,
  default: (props: unknown) => {
    mockScraperStatusTab(props)
    return <div data-testid="scraper-status-tab" />
  },
}))

jest.mock('../components/DashboardTab', () => ({
  __esModule: true,
  default: () => <div />,
}))
jest.mock('../components/UserManagementTab', () => ({
  __esModule: true,
  default: () => <div />,
}))
jest.mock('../components/ReportsTab', () => ({
  __esModule: true,
  default: () => <div />,
}))
jest.mock('../components/GroupApplicationsTab', () => ({
  __esModule: true,
  default: () => <div />,
}))
jest.mock('../components/GroupEditTab', () => ({
  __esModule: true,
  default: () => <div />,
}))
jest.mock('../components/AlertConfigTab', () => ({
  __esModule: true,
  default: () => <div />,
}))
jest.mock('../components/TraderClaimsTab', () => ({
  __esModule: true,
  default: () => <div />,
}))
jest.mock('../components/AuditLogTab', () => ({
  __esModule: true,
  default: () => <div />,
}))
jest.mock('../components/ModerationQueueTab', () => ({
  __esModule: true,
  default: () => <div />,
}))

import AdminPage from '../page'

function report(summary: FreshnessReport['summary'], ok: boolean): FreshnessReport {
  return {
    ok,
    checked_at: '2026-07-18T18:00:00.000Z',
    summary,
    thresholds: { stale_hours: 8, critical_hours: 24 },
    platforms:
      summary.total === 0
        ? []
        : [
            {
              platform: 'gmx',
              displayName: 'GMX',
              lastUpdate: ok ? '2026-07-18T17:00:00.000Z' : null,
              ageMs: ok ? 3_600_000 : null,
              ageHours: ok ? 1 : null,
              status: ok ? 'fresh' : 'unknown',
              recordCount: ok ? 100 : 0,
            },
          ],
  }
}

describe('AdminPage freshness integration', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('announces unknown authority and passes the one shared hook state into the tab', async () => {
    const freshnessReport = report({ total: 1, fresh: 0, stale: 0, critical: 0, unknown: 1 }, false)
    mockUseFreshness.mockReturnValue({
      freshnessReport,
      loading: false,
      error: null,
      loadFreshnessReport: mockLoadFreshnessReport,
    })

    render(<AdminPage />)

    const scraperTab = screen.getByRole('button', {
      name: 'Scraper Status. 1 sources or checks need attention',
    })
    expect(scraperTab).toBeInTheDocument()
    expect(mockUseFreshness).toHaveBeenCalledWith('admin-token')
    await waitFor(() => expect(mockLoadFreshnessReport).toHaveBeenCalledTimes(1))

    fireEvent.click(scraperTab)
    expect(screen.getByTestId('scraper-status-tab')).toBeInTheDocument()
    expect(mockScraperStatusTab).toHaveBeenLastCalledWith(
      expect.objectContaining({
        freshnessReport,
        loading: false,
        error: null,
        onRefresh: mockLoadFreshnessReport,
      })
    )
  })

  it('counts a failed refresh as attention even when the retained report is healthy', () => {
    mockUseFreshness.mockReturnValue({
      freshnessReport: report({ total: 1, fresh: 1, stale: 0, critical: 0, unknown: 0 }, true),
      loading: false,
      error: { kind: 'server', status: 500 },
      loadFreshnessReport: mockLoadFreshnessReport,
    })

    render(<AdminPage />)

    expect(
      screen.getByRole('button', {
        name: 'Scraper Status. 1 sources or checks need attention',
      })
    ).toBeInTheDocument()
  })
})
