import { render, screen } from '@testing-library/react'
import CategoryRankingTabs from '../CategoryRankingTabs'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    language: 'en',
    t: (key: string) =>
      (
        ({
          categoryAll: 'All',
          categoryFutures: 'Futures',
          categorySpot: 'Spot',
          categoryWeb3: 'Onchain',
          rankingCategoriesLabel: 'Ranking categories',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: jest.fn() }),
}))

describe('CategoryRankingTabs count authority', () => {
  it('hides every badge when count authority is unknown, even if a legacy number is present', () => {
    render(
      <CategoryRankingTabs
        currentCategory="all"
        onCategoryChange={jest.fn()}
        isPro
        categoryCounts={{ all: 100, futures: 50, spot: 25, onchain: 25 }}
        categoryCountsAreExact={false}
      />
    )

    for (const label of ['All', 'Futures', 'Spot', 'Onchain']) {
      expect(screen.getByRole('tab', { name: label })).not.toHaveTextContent(/\d/)
    }
  })

  it('shows only finite positive category counts', () => {
    render(
      <CategoryRankingTabs
        currentCategory="all"
        onCategoryChange={jest.fn()}
        isPro
        categoryCounts={{ all: null, futures: Number.NaN, spot: 42, onchain: Infinity }}
        categoryCountsAreExact
      />
    )

    expect(screen.getByRole('tab', { name: 'All' })).not.toHaveTextContent(/\d/)
    expect(screen.getByRole('tab', { name: 'Futures' })).not.toHaveTextContent(/\d/)
    expect(screen.getByRole('tab', { name: /Spot/ })).toHaveTextContent('42')
    expect(screen.getByRole('tab', { name: 'Onchain' })).not.toHaveTextContent(/\d/)
  })
})
