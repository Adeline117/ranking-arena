'use client'

import React, { useState, useEffect, useRef, useCallback, memo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

// ============ Types ============

export interface RankingSearchProps {
  value: string
  onChange: (value: string) => void
  resultCount?: number
  language: string
}

// ============ Constants ============

const LS_KEY_SEARCH_HISTORY = 'arena_search_history'
const MAX_HISTORY_ITEMS = 10

// ============ localStorage helpers ============

function getSearchHistory(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const stored = localStorage.getItem(LS_KEY_SEARCH_HISTORY)
    if (stored) {
      const parsed = JSON.parse(stored)
      if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) {
        return parsed.slice(0, MAX_HISTORY_ITEMS)
      }
    }
  } catch {
    /* ignore */
  }
  return []
}

function saveSearchHistory(history: string[]) {
  try {
    localStorage.setItem(LS_KEY_SEARCH_HISTORY, JSON.stringify(history.slice(0, MAX_HISTORY_ITEMS)))
  } catch {
    /* ignore */
  }
}

function addToHistory(query: string): string[] {
  const trimmed = query.trim()
  if (!trimmed) return getSearchHistory()
  const existing = getSearchHistory().filter((h) => h !== trimmed)
  const updated = [trimmed, ...existing].slice(0, MAX_HISTORY_ITEMS)
  saveSearchHistory(updated)
  return updated
}

function removeFromHistory(query: string): string[] {
  const updated = getSearchHistory().filter((h) => h !== query)
  saveSearchHistory(updated)
  return updated
}

function clearAllHistory(): string[] {
  saveSearchHistory([])
  return []
}

// ============ Icons ============

const SearchIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" strokeLinecap="round" />
  </svg>
)

const ClockIcon = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const CloseSmallIcon = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="18" y1="6" x2="6" y2="18" strokeLinecap="round" />
    <line x1="6" y1="6" x2="18" y2="18" strokeLinecap="round" />
  </svg>
)

// ============ Component ============

function RankingSearchInner({ value, onChange, resultCount, language: _language }: RankingSearchProps) {
  const { t } = useLanguage()
  const [history, setHistory] = useState<string[]>([])
  const [showDropdown, setShowDropdown] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Load history on mount
  useEffect(() => {
    setHistory(getSearchHistory())
  }, [])

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
        setActiveIndex(-1)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Scroll active item into view
  useEffect(() => {
    if (activeIndex >= 0 && dropdownRef.current) {
      const items = dropdownRef.current.querySelectorAll('[data-history-item]')
      const activeItem = items[activeIndex] as HTMLElement | undefined
      if (activeItem) {
        activeItem.scrollIntoView({ block: 'nearest' })
      }
    }
  }, [activeIndex])

  const isHistoryVisible = showDropdown && !value.trim() && history.length > 0

  const handleFocus = useCallback(() => {
    setShowDropdown(true)
    setActiveIndex(-1)
  }, [])

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange(e.target.value)
      setShowDropdown(true)
      setActiveIndex(-1)
    },
    [onChange],
  )

  const selectHistory = useCallback(
    (item: string) => {
      onChange(item)
      setShowDropdown(false)
      setActiveIndex(-1)
      // Save to history (moves it to top)
      setHistory(addToHistory(item))
      inputRef.current?.blur()
    },
    [onChange],
  )

  const handleRemoveHistory = useCallback(
    (e: React.MouseEvent, item: string) => {
      e.stopPropagation()
      e.preventDefault()
      setHistory(removeFromHistory(item))
    },
    [],
  )

  const handleClearAll = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      e.preventDefault()
      setHistory(clearAllHistory())
      setShowDropdown(false)
    },
    [],
  )

  const handleClearInput = useCallback(() => {
    onChange('')
    setActiveIndex(-1)
    inputRef.current?.focus()
  }, [onChange])

  // Commit current value to history (on Enter when not navigating)
  const commitSearch = useCallback(() => {
    if (value.trim()) {
      setHistory(addToHistory(value))
    }
    setShowDropdown(false)
    setActiveIndex(-1)
  }, [value])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isHistoryVisible) {
        // No dropdown visible
        if (e.key === 'Escape') {
          if (value) {
            onChange('')
          } else {
            inputRef.current?.blur()
          }
          setShowDropdown(false)
          return
        }
        if (e.key === 'Enter') {
          commitSearch()
          return
        }
        return
      }

      // Dropdown is visible - handle keyboard navigation
      const itemCount = history.length

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setActiveIndex((prev) => (prev < itemCount - 1 ? prev + 1 : 0))
          break
        case 'ArrowUp':
          e.preventDefault()
          setActiveIndex((prev) => (prev > 0 ? prev - 1 : itemCount - 1))
          break
        case 'Enter':
          e.preventDefault()
          if (activeIndex >= 0 && activeIndex < itemCount) {
            selectHistory(history[activeIndex])
          } else {
            commitSearch()
          }
          break
        case 'Escape':
          e.preventDefault()
          setShowDropdown(false)
          setActiveIndex(-1)
          break
      }
    },
    [isHistoryVisible, history, activeIndex, value, onChange, selectHistory, commitSearch],
  )

  const hasValue = !!value
  const showResultCount = hasValue && resultCount != null

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      {/* Search Input Row */}
      <Box
        style={{
          padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
          borderBottom: `1px solid var(--glass-border-light)`,
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[2],
        }}
      >
        <SearchIcon size={14} />
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={handleChange}
          onFocus={handleFocus}
          onKeyDown={handleKeyDown}
          placeholder={t('searchTradersPlaceholder')}
          aria-label={t('searchTradersLabel')}
          aria-expanded={isHistoryVisible}
          aria-haspopup="listbox"
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? `search-history-item-${activeIndex}` : undefined}
          role="combobox"
          aria-controls="search-results-listbox"
          autoComplete="off"
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: tokens.colors.text.primary,
            fontSize: tokens.typography.fontSize.sm,
            padding: `${tokens.spacing[1]} 0`,
          }}
        />
        {showResultCount && (
          <Text size="xs" color="tertiary" style={{ flexShrink: 0 }}>
            {resultCount} {t('resultsCount')}
          </Text>
        )}
        {hasValue && (
          <button
            onClick={handleClearInput}
            aria-label={t('clearSearch')}
            style={{
              background: 'none',
              border: 'none',
              color: tokens.colors.text.tertiary,
              cursor: 'pointer',
              padding: 4,
              lineHeight: 1.2,
              fontSize: '16px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: tokens.radius.sm,
              transition: `color ${tokens.transition.fast}`,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = tokens.colors.text.primary
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = tokens.colors.text.tertiary
            }}
          >
            ×
          </button>
        )}
      </Box>

      {/* History Dropdown */}
      {isHistoryVisible && (
        <div
          ref={dropdownRef}
          role="listbox"
          aria-label={t('searchHistory')}
          aria-live="polite"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            zIndex: tokens.zIndex.max,
            background: tokens.colors.bg.primary,
            border: `1px solid ${tokens.colors.border.primary}`,
            borderTop: 'none',
            borderRadius: `0 0 ${tokens.radius.lg} ${tokens.radius.lg}`,
            boxShadow: tokens.shadow.lg,
            maxHeight: 320,
            overflowY: 'auto',
          }}
        >
          {/* Header - role=presentation so listbox only sees role=option children */}
          <Box
            role="presentation"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
              borderBottom: `1px solid ${tokens.colors.border.primary}`,
            }}
          >
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1] }}>
              <ClockIcon size={11} />
              <Text size="xs" weight="bold" color="tertiary">
                {t('searchHistory')}
              </Text>
            </Box>
            <button
              onClick={handleClearAll}
              style={{
                background: 'none',
                border: 'none',
                color: tokens.colors.accent.error,
                cursor: 'pointer',
                fontSize: tokens.typography.fontSize.xs,
                padding: `2px ${tokens.spacing[2]}`,
                borderRadius: tokens.radius.sm,
                opacity: 0.7,
                transition: `opacity ${tokens.transition.fast}`,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.opacity = '1'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = '0.7'
              }}
            >
              {t('clearAll')}
            </button>
          </Box>

          {/* History Items */}
          {history.map((item, idx) => {
            const isActive = idx === activeIndex
            return (
              <div
                key={item}
                id={`search-history-item-${idx}`}
                data-history-item
                role="option"
                aria-selected={isActive}
                onClick={() => selectHistory(item)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: tokens.spacing[2],
                  padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                  cursor: 'pointer',
                  background: isActive ? `${tokens.colors.accent.primary}15` : 'transparent',
                  borderLeft: isActive ? `2px solid ${tokens.colors.accent.primary}` : '2px solid transparent',
                  transition: `background ${tokens.transition.fast}, border-color ${tokens.transition.fast}`,
                }}
                onMouseEnter={(e) => {
                  setActiveIndex(idx)
                  e.currentTarget.style.background = `${tokens.colors.accent.primary}15`
                }}
                onMouseLeave={(e) => {
                  if (idx !== activeIndex) {
                    e.currentTarget.style.background = 'transparent'
                  }
                }}
              >
                <ClockIcon size={11} />
                <Text
                  size="sm"
                  style={{
                    flex: 1,
                    color: isActive ? tokens.colors.text.primary : tokens.colors.text.secondary,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {item}
                </Text>
                <button
                  onClick={(e) => handleRemoveHistory(e, item)}
                  aria-label={t('removeHistoryItem').replace('{item}', item)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: tokens.colors.text.tertiary,
                    cursor: 'pointer',
                    padding: 4,
                    lineHeight: 1.2,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: 0.5,
                    transition: `opacity ${tokens.transition.fast}, color ${tokens.transition.fast}`,
                    flexShrink: 0,
                    borderRadius: tokens.radius.sm,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.opacity = '1'
                    e.currentTarget.style.color = tokens.colors.accent.error
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.opacity = '0.5'
                    e.currentTarget.style.color = tokens.colors.text.tertiary
                  }}
                >
                  <CloseSmallIcon size={12} />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const RankingSearch = memo(RankingSearchInner)
export default RankingSearch

// ============ Highlight Utility ============

/**
 * Highlights matching text within a display name.
 * Returns a React fragment with matched portions wrapped in <mark>.
 *
 * Usage in TraderRow/TraderCard:
 *   <HighlightedName text={displayName} query={searchQuery} />
 */
export function HighlightedName({ text, query }: { text: string; query: string }) {
  if (!query || !query.trim()) {
    return <>{text}</>
  }

  const q = query.trim()
  const lowerText = text.toLowerCase()
  const lowerQuery = q.toLowerCase()
  const idx = lowerText.indexOf(lowerQuery)

  if (idx === -1) {
    return <>{text}</>
  }

  const before = text.slice(0, idx)
  const match = text.slice(idx, idx + q.length)
  const after = text.slice(idx + q.length)

  return (
    <>
      {before}
      <mark
        style={{
          background: `${tokens.colors.accent.primary}30`,
          color: tokens.colors.accent.primary,
          borderRadius: '2px',
          padding: '0 1px',
          fontWeight: 700,
        }}
      >
        {match}
      </mark>
      {after}
    </>
  )
}
