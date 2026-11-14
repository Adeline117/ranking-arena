import { render, screen } from '@testing-library/react'
import RankingSection from '../RankingSection'

/**
 * P2-5: /api/traders has no filter params (zod whitelist: timeRange/exchange/
 * category/sortBy/order/cursor/limit/page), so advanced filters and presets
 * stay client-side over the loaded page. The UI must say so.
 */
let mockHasClientPageFilters = false

jest.mock('../useRankingFilters', () => ({
  useRankingFilters: () => ({
    language: 'en',
    t: (key: string) => key,
    isPro: true,
    premiumLoading: false,
    category: 'all',
    setCategory: jest.fn(),
    showAdvancedFilter: false,
    showMobileFilter: false,
    setShowMobileFilter: jest.fn(),
    filterConfig: {},
    savedFilters: [],
    hasActiveFilters: mockHasClientPageFilters,
    hasClientPageFilters: mockHasClientPageFilters,
    selectedExchange: null,
    clearExchange: jest.fn(),
    sortColumn: 'score',
    sortDir: 'desc',
    currentPage: 1,
    searchQuery: '',
    source: 'all',
    advancedFiltered: [],
    filteredTraders: [],
    searchMatchesElsewhere: [],
    handleFilterChange: jest.fn(),
    handleSortChange: jest.fn(),
    handlePageChange: jest.fn(),
    handleSearchChange: jest.fn(),
    handleSaveFilter: jest.fn(),
    handleLoadFilter: jest.fn(),
    handleDeleteFilter: jest.fn(),
    handleProRequired: jest.fn(),
    handleCopyLink: jest.fn(),
    handleResetFilters: jest.fn(),
    handleFilterToggle: jest.fn(),
    formatLastUpdated: () => null,
  }),
}))
jest.mock('../../ranking/RankingTable', () => ({ RankingTable: () => null }))
jest.mock('../TimeRangeSelector', () => () => null)
jest.mock('../../ranking/CategoryRankingTabs', () => () => null)
jest.mock('../ExchangeScopeNotice', () => () => null)
jest.mock('../SearchElsewhereMatches', () => () => null)
jest.mock('next/dynamic', () => () => () => null)

const baseProps = {
  traders: [],
  loading: false,
  isLoggedIn: false,
  activeTimeRange: '90D' as const,
  onTimeRangeChange: jest.fn(),
}

describe('RankingSection current-page filter disclosure', () => {
  it('states that filters only cover the loaded page when one is active', () => {
    mockHasClientPageFilters = true
    render(<RankingSection {...baseProps} />)
    expect(screen.getByRole('note')).toHaveTextContent('rankingFiltersCurrentPageOnly')
  })

  it('shows no disclosure without an active client-side filter', () => {
    mockHasClientPageFilters = false
    render(<RankingSection {...baseProps} />)
    expect(screen.queryByRole('note')).toBeNull()
  })
})
