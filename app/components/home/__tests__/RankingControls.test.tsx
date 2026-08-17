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

  it('shows the leaderboard compute timestamp instead of the page-load time', async () => {
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
