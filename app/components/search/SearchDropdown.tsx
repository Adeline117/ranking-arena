'use client'

import { useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { SearchHistory, TrendingSearches, HotPosts } from './SearchSuggestions'
import { features } from '@/lib/features'
import { EXCHANGE_CONFIG } from '@/lib/constants/exchanges'
import { SearchResultGroup, type CategoryKey } from './SearchResultGroup'
import { SearchEmptyState, SearchSkeleton } from './SearchEmptyState'
import { useSearchData } from './useSearchData'

interface SearchDropdownProps {
  open: boolean
  query: string
  onClose: () => void
  /**
   * Reports the DOM id of the currently highlighted option (or null when none)
   * so the owning combobox input can wire `aria-activedescendant`. Each rendered
   * option carries `id="search-option-${globalIndex}"` (see SearchResultGroup).
   */
  onActiveOptionChange?: (optionId: string | null) => void
}

/**
 * Search dropdown
 * - Unified search: traders, posts, library, users
 * - Grouped by category
 * - Keyboard navigation (arrow keys, Enter, Escape)
 * - Search history
 * - Hot posts
 */
export default function SearchDropdown({
  open,
  query,
  onClose,
  onActiveOptionChange,
}: SearchDropdownProps) {
  const router = useRouter()
  const containerRef = useRef<HTMLDivElement>(null)

  const {
    language,
    t,
    searchHistory,
    hotPosts,
    trendingSearches,
    trendingLoading,
    loading,
    searchData,
    searching,
    isOffline,
    selectedIndex,
    setSelectedIndex,
    translatedTitles,
    flatResults,
    saveToHistory,
    handleDeleteHistory,
    handleClearAllHistory,
  } = useSearchData(open, query)

  // Keyboard navigation
  useEffect(() => {
    if (!open) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (flatResults.length === 0) return

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((prev: number) => {
          const next = prev < flatResults.length - 1 ? prev + 1 : 0
          scrollItemIntoView(next)
          return next
        })
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((prev: number) => {
          const next = prev > 0 ? prev - 1 : flatResults.length - 1
          scrollItemIntoView(next)
          return next
        })
      } else if (e.key === 'Enter' && selectedIndex >= 0) {
        e.preventDefault()
        const selected = flatResults[selectedIndex]
        if (selected) {
          saveToHistory(query)
          router.push(selected.href)
          onClose()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, flatResults, selectedIndex, query, onClose, router, saveToHistory, setSelectedIndex])

  // Surface the highlighted option's id so the combobox input can set
  // aria-activedescendant (screen-reader announcement of arrow-key movement).
  useEffect(() => {
    if (!onActiveOptionChange) return
    const id =
      open && selectedIndex >= 0 && flatResults.length > 0 ? `search-option-${selectedIndex}` : null
    onActiveOptionChange(id)
  }, [open, selectedIndex, flatResults.length, onActiveOptionChange])

  // Clear active descendant when the dropdown unmounts.
  useEffect(() => {
    return () => onActiveOptionChange?.(null)
  }, [onActiveOptionChange])

  // Prefetch on hover with debounce
  const prefetchTimerRef = useRef<NodeJS.Timeout | null>(null)
  const prefetchedRef = useRef<Set<string>>(new Set())

  const handleResultMouseEnter = useCallback(
    (href: string) => {
      if (prefetchedRef.current.has(href)) return
      if (prefetchTimerRef.current) clearTimeout(prefetchTimerRef.current)
      prefetchTimerRef.current = setTimeout(() => {
        router.prefetch(href)
        prefetchedRef.current.add(href)
      }, 100)
    },
    [router]
  )

  const scrollItemIntoView = (index: number) => {
    if (!containerRef.current) return
    const items = containerRef.current.querySelectorAll<HTMLElement>('a[href]')
    const item = items[index]
    if (item) item.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }

  const handleResultClick = (resultId?: string, resultType?: string) => {
    if (query.trim()) saveToHistory(query)
    if (resultId && query.trim()) {
      fetch(
        `/api/search?type=click&q=${encodeURIComponent(query.trim())}&id=${encodeURIComponent(resultId)}&rtype=${resultType || ''}`
      ).catch(() => {}) // eslint-disable-line no-restricted-syntax -- fire-and-forget: click tracking is non-critical
    }
    onClose()
  }

  if (!open) return null

  // Calculate offset per category for keyboard highlight
  const getCategoryOffset = (category: CategoryKey): number => {
    if (!searchData) return 0
    const order: CategoryKey[] = features.social
      ? ['traders', 'posts', 'users', 'groups']
      : ['traders']
    let offset = 0
    for (const key of order) {
      if (key === category) break
      offset += (searchData.results[key] || []).length
    }
    return offset
  }

  return (
    <div
      ref={containerRef}
      id="search-dropdown-listbox"
      role="listbox"
      aria-label="Search results"
      className="dropdown-enter"
      style={{
        position: 'absolute',
        top: 'calc(100% + 8px)',
        left: 0,
        right: 0,
        background: tokens.colors.bg.secondary,
        border: `1px solid ${tokens.colors.border.primary}`,
        borderRadius: tokens.radius.md,
        maxHeight: 600,
        overflowY: 'auto',
        zIndex: tokens.zIndex.dropdown,
        boxShadow: tokens.shadow.md,
      }}
    >
      {/* Offline hint when user tries to search without connectivity */}
      {isOffline && query.trim().length >= 2 && (
        <Box
          style={{
            padding: `${tokens.spacing[4]} ${tokens.spacing[4]}`,
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[2],
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke={tokens.colors.text.tertiary}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="1" y1="1" x2="23" y2="23" />
            <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
            <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
            <path d="M10.71 5.05A16 16 0 0 1 22.56 9" />
            <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
            <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
            <line x1="12" y1="20" x2="12.01" y2="20" />
          </svg>
          <Text size="sm" color="tertiary">
            {t('offlineSearchHint')}
          </Text>
        </Box>
      )}

      {/* Search results (query >= 2 chars) */}
      {query.trim().length >= 2 && !isOffline && (
        <Box>
          {searching ? (
            <SearchSkeleton />
          ) : searchData && searchData.total === 0 ? (
            <SearchEmptyState suggestions={searchData.suggestions} onClose={onClose} t={t} />
          ) : !searchData && !searching ? (
            <SearchEmptyState onClose={onClose} t={t} />
          ) : searchData ? (
            <>
              {searchData.matchedExchange && (
                <Box
                  style={{
                    padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                    borderBottom: `1px solid ${tokens.colors.border.primary}`,
                    display: 'flex',
                    alignItems: 'center',
                    gap: tokens.spacing[2],
                  }}
                >
                  <Text size="xs" color="tertiary">
                    {t('searchShowingTopTraders')}{' '}
                    <span style={{ fontWeight: 700, color: tokens.colors.text.secondary }}>
                      {EXCHANGE_CONFIG[searchData.matchedExchange as keyof typeof EXCHANGE_CONFIG]
                        ?.name || searchData.matchedExchange}
                    </span>
                  </Text>
                </Box>
              )}
              <SearchResultGroup
                category="traders"
                items={searchData.results.traders}
                query={query}
                selectedIndex={selectedIndex}
                offset={getCategoryOffset('traders')}
                onResultClick={handleResultClick}
                onResultMouseEnter={handleResultMouseEnter}
              />
              {features.social && (
                <SearchResultGroup
                  category="posts"
                  items={searchData.results.posts}
                  query={query}
                  selectedIndex={selectedIndex}
                  offset={getCategoryOffset('posts')}
                  onResultClick={handleResultClick}
                  onResultMouseEnter={handleResultMouseEnter}
                />
              )}

              {features.social && (
                <SearchResultGroup
                  category="users"
                  items={searchData.results.users}
                  query={query}
                  selectedIndex={selectedIndex}
                  offset={getCategoryOffset('users')}
                  onResultClick={handleResultClick}
                  onResultMouseEnter={handleResultMouseEnter}
                />
              )}
              {features.social && (
                <SearchResultGroup
                  category="groups"
                  items={searchData.results.groups || []}
                  query={query}
                  selectedIndex={selectedIndex}
                  offset={getCategoryOffset('groups')}
                  onResultClick={handleResultClick}
                  onResultMouseEnter={handleResultMouseEnter}
                />
              )}
              {searchData.suggestions && searchData.suggestions.length > 0 && (
                <Box
                  style={{
                    padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                    borderBottom: `1px solid ${tokens.colors.border.primary}`,
                    display: 'flex',
                    alignItems: 'center',
                    gap: tokens.spacing[2],
                    flexWrap: 'wrap',
                  }}
                >
                  <Text size="xs" color="tertiary">
                    {t('searchDidYouMean')}
                  </Text>
                  {searchData.suggestions.map((suggestion) => (
                    <Link
                      key={suggestion}
                      href={`/search?q=${encodeURIComponent(suggestion)}`}
                      style={{ textDecoration: 'none' }}
                      onClick={onClose}
                    >
                      <Text
                        size="xs"
                        style={{ color: tokens.colors.accent.primary, fontWeight: 600 }}
                      >
                        {suggestion}
                      </Text>
                    </Link>
                  ))}
                </Box>
              )}
              <Link
                href={`/search?q=${encodeURIComponent(query)}`}
                style={{ textDecoration: 'none' }}
                onClick={() => handleResultClick()}
              >
                <Box
                  style={{
                    padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                    textAlign: 'center',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = tokens.colors.bg.tertiary
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent'
                  }}
                >
                  <Text size="xs" color="tertiary">
                    {t('viewAllSearchResults')} →
                  </Text>
                </Box>
              </Link>
            </>
          ) : null}
        </Box>
      )}

      {/* Suggestions (no active query) */}
      {query.trim().length < 2 && (
        <>
          <SearchHistory
            history={searchHistory}
            onClear={handleClearAllHistory}
            onDelete={handleDeleteHistory}
            onClose={onClose}
            t={t}
          />
          <TrendingSearches
            trending={trendingSearches}
            language={language}
            onClose={onClose}
            hasHistory={searchHistory.length > 0}
            loading={trendingLoading}
          />
          {features.social && (
            <HotPosts
              posts={hotPosts}
              loading={loading}
              language={language}
              translatedTitles={translatedTitles}
              onClose={onClose}
              hasHistory={searchHistory.length > 0}
              t={t}
            />
          )}
        </>
      )}
    </div>
  )
}
