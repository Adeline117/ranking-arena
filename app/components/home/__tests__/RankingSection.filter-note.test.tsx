import { render, screen } from '@testing-library/react'
import RankingSection from '../RankingSection'

/**
 * P2-5: advanced filters and presets are /api/traders params applied to the
 * whole cohort, so the old "this page only" disclosure no longer applies and
 * must not come back.
 */
let mockHasCohortFilters = false

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
    hasActiveFilters: mockHasCohortFilters,
    hasCohortFilters: mockHasCohortFilters,
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

describe('RankingSection filter disclosure', () => {
  it('shows no "current page only" note while server-side filters are active', () => {
    mockHasCohortFilters = true
    render(<RankingSection {...baseProps} />)
    expect(screen.queryByRole('note')).toBeNull()
    expect(screen.queryByTestId('filters-current-page-only')).toBeNull()
  })
})
