import { fireEvent, render, screen } from '@testing-library/react'
import RankingControls from '../RankingControls'

const push = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      (
        ({
          rankingControlsDataAsOf: 'Data as of',
          dataStaleWarning: 'Data may be delayed',
          rankingControlsPrev: 'Previous',
          rankingControlsNext: 'Next',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

jest.mock('@/lib/premium/hooks', () => ({
  BETA_PRO_FEATURES_FREE: false,
}))

describe('RankingControls data timestamp', () => {
  beforeEach(() => {
    push.mockClear()
  })

  it('shows the source watermark instead of the page-load time', async () => {
    const lastUpdated = '2026-07-17T08:42:00.000Z'
    render(
      <RankingControls
        activeRange="90D"
        page={0}
        totalCount={50}
        totalCountIsExact
        hasMore={false}
        perPage={50}
        lastUpdated={lastUpdated}
      />
    )

    const timestamp = await screen.findByText(/^Data as of /)
    expect(timestamp).toHaveAttribute('datetime', lastUpdated)
    expect(timestamp.textContent).toContain(
      new Date(lastUpdated).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
      })
    )
  })

  it('keeps the date of an old watermark and flags it as possibly delayed', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-11-11T12:00:00.000Z') })
    try {
      const lastUpdated = '2026-08-16T09:30:00.000Z'
      render(
        <RankingControls
          activeRange="90D"
          page={0}
          totalCount={50}
          totalCountIsExact
          hasMore={false}
          perPage={50}
          lastUpdated={lastUpdated}
        />
      )
      const timestamp = screen.getByText(/^Data as of /)
      // A bare clock time would read as "today"; the date must stay visible.
      expect(timestamp.textContent).toMatch(/Aug 1[56]/)
      expect(screen.getByTestId('ranking-data-stale')).toHaveTextContent('Data may be delayed')
    } finally {
      jest.useRealTimers()
    }
  })

  it('does not flag a watermark within 48 hours', () => {
    jest.useFakeTimers({ now: Date.parse('2026-11-11T12:00:00.000Z') })
    try {
      render(
        <RankingControls
          activeRange="90D"
          page={0}
          totalCount={50}
          totalCountIsExact
          hasMore={false}
          perPage={50}
          lastUpdated="2026-11-11T11:00:00.000Z"
        />
      )
      expect(screen.getByText(/^Data as of /)).toBeInTheDocument()
      expect(screen.queryByTestId('ranking-data-stale')).not.toBeInTheDocument()
    } finally {
      jest.useRealTimers()
    }
  })

  it('shows nothing for the epoch unknown sentinel', () => {
    render(
      <RankingControls
        activeRange="90D"
        page={0}
        totalCount={50}
        totalCountIsExact
        hasMore={false}
        perPage={50}
        lastUpdated="1970-01-01T00:00:00.000Z"
      />
    )
    expect(screen.queryByText(/^Data as of /)).not.toBeInTheDocument()
  })

  it('does not invent a freshness timestamp when the data source has none', () => {
    render(
      <RankingControls
        activeRange="90D"
        page={0}
        totalCount={0}
        totalCountIsExact
        hasMore={false}
        perPage={50}
        lastUpdated={null}
      />
    )

    expect(screen.queryByText(/^Data as of /)).not.toBeInTheDocument()
  })

  it('uses only limit+1 pagination when the total is unknown and omits Top-N promotion copy', () => {
    render(
      <RankingControls
        activeRange="90D"
        page={1}
        totalCount={999}
        totalCountIsExact={false}
        hasMore
        perPage={50}
        lastUpdated={null}
      />
    )

    expect(screen.getByRole('button', { name: 'Previous page' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Next page' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'First page' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Last page' })).not.toBeInTheDocument()
    expect(screen.queryByText(/2\s*\//)).not.toBeInTheDocument()
    expect(screen.queryByText('rankingControlsShowingTop')).not.toBeInTheDocument()
    expect(screen.queryByText('rankingControlsShowingTopPromo')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    // The component takes a zero-based reader page but public URLs stay
    // human one-based: reader page 1 navigates to URL page 3.
    expect(push).toHaveBeenCalledWith('/?page=3', { scroll: false })
  })

  it('writes the second public page from the first reader page and preserves range', () => {
    window.history.replaceState(null, '', '/?range=30D')
    render(
      <RankingControls
        activeRange="30D"
        page={0}
        totalCount={null}
        totalCountIsExact={false}
        hasMore
        perPage={50}
        lastUpdated={null}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(push).toHaveBeenCalledWith('/?range=30D&page=2', { scroll: false })
  })
})
