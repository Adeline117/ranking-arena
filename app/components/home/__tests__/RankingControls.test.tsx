import { render, screen } from '@testing-library/react'
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
  it('shows the leaderboard compute timestamp instead of the page-load time', async () => {
    const lastUpdated = '2026-07-17T08:42:00.000Z'
    render(
      <RankingControls
        activeRange="90D"
        page={0}
        totalCount={50}
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
      <RankingControls activeRange="90D" page={0} totalCount={0} perPage={50} lastUpdated={null} />
    )

    expect(screen.queryByText(/^Data as of /)).not.toBeInTheDocument()
  })
})
