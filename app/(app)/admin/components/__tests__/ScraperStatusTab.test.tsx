import { fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReactNode } from 'react'
import type { FreshnessReport } from '@/lib/rankings/freshness-report'
import ScraperStatusTab from '../ScraperStatusTab'

const translations: Record<string, string> = {
  adminAgeHours: 'Age: {hours} hours',
  adminCheckedAt: 'Checked at: {time}',
  adminCriticalCount: 'Critical (≥{threshold}h default): {count}',
  adminCriticalDesc: 'Critical description',
  adminFreshCount: 'Fresh: {count}',
  adminFreshDesc: 'Fresh description',
  adminFreshnessInvalidResponse: 'Invalid freshness response',
  adminFreshnessLoadError: 'Could not refresh freshness',
  adminFreshnessPermissionError: 'Admin session verification failed',
  adminLastUpdate: 'Oldest upstream watermark: {time}',
  adminNoDataLabel: 'No data',
  adminNoVerifiedFreshness: 'No verified freshness report is available.',
  adminRecordCount: 'Visible rows across windows: {count}',
  adminRefreshStatus: 'Refresh Status',
  adminRefreshing: 'Refreshing...',
  adminScraperMonitor: 'Scraper Status Monitor',
  adminStaleCount: 'Stale (≥{threshold}h default): {count}',
  adminStaleDesc: 'Stale description',
  adminStatusCritical: 'Critical',
  adminStatusExplanation: 'Status Explanation',
  adminStatusFresh: 'Fresh',
  adminStatusStale: 'Stale',
  adminStatusUnknown: 'Unknown',
  adminThresholdOverrides: 'Source-specific overrides apply.',
  adminTotalPlatforms: 'Total: {count} platforms',
  adminUnknownCount: 'Unknown authority: {count}',
  adminUnknownDesc: 'Authority failed closed',
  loading: 'Loading',
  noData: 'No data',
  retry: 'Retry',
}

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

jest.mock('@/app/components/ui/Card', () => ({
  __esModule: true,
  default: ({ title, children }: { title: string; children: ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}))

function report(): FreshnessReport {
  return {
    ok: false,
    checked_at: '2026-07-18T18:00:00.000Z',
    summary: { total: 2, fresh: 1, stale: 0, critical: 0, unknown: 1 },
    thresholds: { stale_hours: 8, critical_hours: 24 },
    platforms: [
      {
        platform: 'binance_futures',
        displayName: 'Binance Futures',
        lastUpdate: '2026-07-18T17:00:00.000Z',
        ageMs: 3_600_000,
        ageHours: 1,
        status: 'fresh',
        recordCount: 300,
      },
      {
        platform: 'gmx',
        displayName: 'GMX',
        lastUpdate: null,
        ageMs: null,
        ageHours: null,
        status: 'unknown',
        recordCount: 0,
      },
    ],
  }
}

describe('ScraperStatusTab', () => {
  it('renders unknown authority as a red fail-closed status before fresh sources', () => {
    render(
      <ScraperStatusTab
        freshnessReport={report()}
        loading={false}
        error={null}
        onRefresh={jest.fn().mockResolvedValue(true)}
      />
    )

    expect(screen.getByText('Unknown authority: 1')).toBeInTheDocument()
    expect(screen.getByText('Stale (≥8h default): 0')).toBeInTheDocument()
    expect(screen.getByText('Critical (≥24h default): 0')).toBeInTheDocument()
    expect(screen.getByText('Oldest upstream watermark: No data')).toBeInTheDocument()
    expect(screen.getByText('Visible rows across windows: 300')).toBeInTheDocument()
    expect(screen.getAllByText('Unknown')).not.toHaveLength(0)

    const unknownPlatform = screen.getByText('GMX')
    const freshPlatform = screen.getByText('Binance Futures')
    expect(
      unknownPlatform.compareDocumentPosition(freshPlatform) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('keeps the last verified report visible when refresh fails and offers retry', () => {
    const onRefresh = jest.fn().mockResolvedValue(false)
    const { rerender } = render(
      <ScraperStatusTab
        freshnessReport={report()}
        loading={false}
        error={{ kind: 'server', status: 500 }}
        onRefresh={onRefresh}
      />
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Could not refresh freshness')
    expect(screen.getByText('GMX')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRefresh).toHaveBeenCalledTimes(1)

    rerender(
      <ScraperStatusTab
        freshnessReport={report()}
        loading
        error={{ kind: 'server', status: 500 }}
        onRefresh={onRefresh}
      />
    )
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Refreshing...' })).toBeDisabled()
  })

  it('never converts an initial auth failure into a zero-platform dashboard', () => {
    render(
      <ScraperStatusTab
        freshnessReport={null}
        loading={false}
        error={{ kind: 'unauthorized', status: 401 }}
        onRefresh={jest.fn().mockResolvedValue(false)}
      />
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Admin session verification failed')
    expect(screen.getByText('No verified freshness report is available.')).toBeInTheDocument()
    expect(screen.queryByText('Total: 0 platforms')).not.toBeInTheDocument()
  })

  it('keeps a single page-owned freshness request source', () => {
    const page = readFileSync(join(process.cwd(), 'app/(app)/admin/page.tsx'), 'utf8')
    const tab = readFileSync(
      join(process.cwd(), 'app/(app)/admin/components/ScraperStatusTab.tsx'),
      'utf8'
    )

    expect(page.match(/useFreshness\(/g)).toHaveLength(1)
    expect(page).toContain('useFreshness(accessToken)')
    expect(tab).not.toMatch(/\buseFreshness\s*\(/)
    expect(tab).not.toMatch(/\buseEffect\s*\(/)
  })
})
