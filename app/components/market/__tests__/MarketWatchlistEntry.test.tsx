import { render, screen } from '@testing-library/react'
import MarketWatchlistEntry from '../MarketWatchlistEntry'

const mockTranslations: Record<string, string> = {
  watchlistTitle: 'Watchlist',
  watchlistSubtitle: 'Your saved traders',
  viewAll: 'View All',
  watchlistComingSoon: 'Watchlist coming soon',
}
const mockTranslate = (key: string) => mockTranslations[key] ?? key

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: mockTranslate }),
}))

describe('MarketWatchlistEntry', () => {
  it('links to the existing saved-traders feature instead of claiming it is coming soon', () => {
    render(<MarketWatchlistEntry />)

    expect(screen.getByRole('link', { name: 'View All' })).toHaveAttribute(
      'href',
      '/saved?tab=traders'
    )
    expect(screen.getByText('Your saved traders')).toBeInTheDocument()
    expect(screen.queryByText('Watchlist coming soon')).not.toBeInTheDocument()
  })
})
