import { fireEvent, render, screen } from '@testing-library/react'
import RankingControls from '../RankingControls'
import { criticalCss } from '@/lib/performance/critical-css'

const push = jest.fn()
let mockTransitionPending = false
const mockStartTransition = jest.fn((callback: () => void) => callback())

jest.mock('react', () => ({
  ...jest.requireActual<typeof import('react')>('react'),
  useTransition: () => [mockTransitionPending, mockStartTransition],
}))

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
    mockStartTransition.mockClear()
    mockTransitionPending = false
  })

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

  it('keeps range and available page navigation operable while an older navigation is pending', () => {
    mockTransitionPending = true

    const { container } = render(
      <RankingControls
        activeRange="90D"
        page={1}
        totalCount={150}
        perPage={50}
        lastUpdated={null}
      />
    )

    expect(container.firstElementChild).toHaveAttribute('aria-busy', 'true')
    const thirtyDays = screen.getByRole('button', { name: 'Show 30D rankings' })
    const sevenDays = screen.getByRole('button', { name: 'Show 7D rankings' })
    const previous = screen.getByRole('button', { name: 'Previous page' })
    const next = screen.getByRole('button', { name: 'Next page' })
    for (const control of [thirtyDays, sevenDays, previous, next]) {
      expect(control).toBeEnabled()
    }

    fireEvent.click(thirtyDays)
    fireEvent.click(sevenDays)
    expect(push).toHaveBeenNthCalledWith(1, '/?range=30D', { scroll: false })
    expect(push).toHaveBeenNthCalledWith(2, '/?range=7D', { scroll: false })
  })

  it('ships 44px first-paint targets for range and pagination controls', () => {
    expect(criticalCss).toMatch(/\.ssr-range-btn\{[^}]*min-width:44px;min-height:44px[^}]*\}/)
    expect(criticalCss).toMatch(/\.ssr-page-btn\{[^}]*min-width:44px;min-height:44px[^}]*\}/)
  })
})
