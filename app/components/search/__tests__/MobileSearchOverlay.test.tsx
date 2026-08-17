import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockPush = jest.fn()
const mockAddToHistory = jest.fn()
const mockSetSelectedIndex = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: jest.fn(),
    prefetch: jest.fn(),
    back: jest.fn(),
  }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    language: 'en',
    t: (key: string) =>
      ({
        search: 'Search',
        searchPlaceholder: 'Search traders',
        cancel: 'Cancel',
        clearSearch: 'Clear search',
      })[key] || key,
  }),
}))

jest.mock('@/lib/i18n', () => ({
  t: (key: string) => key,
}))

jest.mock('@/lib/features', () => ({ features: { social: false } }))

jest.mock('@/lib/analytics/track', () => ({ trackEvent: jest.fn() }))

jest.mock('@/lib/services/search-history', () => ({
  addToHistory: (...args: unknown[]) => mockAddToHistory(...args),
}))

jest.mock('@/lib/hooks/useScrollLock', () => ({ useScrollLock: jest.fn() }))

jest.mock('../useSearchData', () => ({
  useSearchData: (_open: boolean, query: string) => {
    const hasSelectedResult = query.trim().length >= 2
    const result = {
      id: 'trader-1',
      type: 'trader',
      title: 'Alice',
      subtitle: 'Binance',
      href: '/trader/alice',
      avatar: null,
    }

    return {
      language: 'en',
      t: (key: string) => key,
      searchHistory: [],
      hotPosts: [],
      trendingSearches: [],
      trendingLoading: false,
      loading: false,
      searchData: hasSelectedResult
        ? {
            total: 1,
            results: { traders: [result], posts: [], users: [], groups: [] },
            suggestions: [],
          }
        : null,
      searching: false,
      isOffline: false,
      selectedIndex: hasSelectedResult ? 0 : -1,
      setSelectedIndex: mockSetSelectedIndex,
      translatedTitles: {},
      flatResults: hasSelectedResult ? [result] : [],
      saveToHistory: mockAddToHistory,
      handleDeleteHistory: jest.fn(),
      handleClearAllHistory: jest.fn(),
    }
  },
}))

import MobileSearchOverlay from '../MobileSearchOverlay'

describe('MobileSearchOverlay', () => {
  let requestAnimationFrameSpy: jest.SpyInstance
  let cancelAnimationFrameSpy: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    requestAnimationFrameSpy = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0)
        return 1
      })
    cancelAnimationFrameSpy = jest.spyOn(window, 'cancelAnimationFrame').mockImplementation()
  })

  afterEach(() => {
    requestAnimationFrameSpy.mockRestore()
    cancelAnimationFrameSpy.mockRestore()
  })

  it('lets SearchDropdown open the selected result when Enter is pressed', async () => {
    const onClose = jest.fn()
    render(<MobileSearchOverlay open onClose={onClose} />)

    const input = screen.getByRole('combobox', { name: 'Search traders' })
    fireEvent.change(input, { target: { value: 'alice' } })

    await waitFor(() => {
      expect(input).toHaveAttribute('aria-controls', 'search-dropdown-listbox')
      expect(input).toHaveAttribute('aria-activedescendant', 'search-option-0')
    })
    expect(input).toHaveAttribute('aria-expanded', 'true')
    expect(input).toHaveAttribute('aria-autocomplete', 'list')

    fireEvent.keyDown(input, { key: 'Enter' })

    expect(mockPush).toHaveBeenCalledWith('/trader/alice')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('traps focus in the full-screen dialog and restores the trigger on close', () => {
    const trigger = document.createElement('button')
    trigger.textContent = 'Open mobile search'
    document.body.appendChild(trigger)
    trigger.focus()

    const onClose = jest.fn()
    const { rerender } = render(<MobileSearchOverlay open onClose={onClose} />)
    const input = screen.getByRole('combobox', { name: 'Search traders' })
    const cancel = screen.getByRole('button', { name: 'Cancel' })

    expect(input).toHaveFocus()

    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })
    expect(cancel).toHaveFocus()

    fireEvent.keyDown(cancel, { key: 'Tab' })
    expect(input).toHaveFocus()

    rerender(<MobileSearchOverlay open={false} onClose={onClose} />)
    expect(trigger).toHaveFocus()
    trigger.remove()
  })
})
