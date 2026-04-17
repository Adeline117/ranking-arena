'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { getLocaleFromLanguage } from '@/lib/utils/format'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { logger } from '@/lib/logger'

type SearchMatch = {
  message_id: string
  snippet: string
  created_at: string
  sender_id: string
}

type ChatSearchOverlayProps = {
  isOpen: boolean
  onClose: () => void
  conversationId: string
  accessToken: string
  onNavigateToMessage: (messageId: string) => void
}

export default function ChatSearchOverlay({
  isOpen,
  onClose,
  conversationId,
  accessToken,
  onNavigateToMessage,
}: ChatSearchOverlayProps) {
  const { t, language } = useLanguage()
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<SearchMatch[]>([])
  const [loading, setLoading] = useState(false)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasSearched, setHasSearched] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus()
    }
  }, [isOpen])

  // Reset state when closed
  useEffect(() => {
    if (!isOpen) {
      setQuery('')
      setMatches([])
      setCurrentIndex(0)
      setNextCursor(null)
      setHasSearched(false)
    }
  }, [isOpen])

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  const doSearch = useCallback(async (searchQuery: string, cursor?: string) => {
    if (!searchQuery.trim()) {
      setMatches([])
      setHasSearched(false)
      return
    }

    setLoading(true)
    try {
      let url = `/api/chat/${conversationId}/search?q=${encodeURIComponent(searchQuery.trim())}&limit=20`
      if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`

      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      })

      if (res.ok) {
        const data = await res.json()
        if (cursor) {
          setMatches(prev => [...prev, ...data.matches])
        } else {
          setMatches(data.matches)
          setCurrentIndex(0)
        }
        setNextCursor(data.next_cursor)
      }
    } catch (error) {
      logger.error('Search failed:', error)
    } finally {
      setLoading(false)
      setHasSearched(true)
    }
  }, [conversationId, accessToken])

  const handleInputChange = (value: string) => {
    setQuery(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      doSearch(value)
    }, 300)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      doSearch(query)
    } else if (e.key === 'Escape') {
      onClose()
    }
  }

  const goToNext = () => {
    if (matches.length === 0) return
    const newIndex = Math.min(currentIndex + 1, matches.length - 1)
    setCurrentIndex(newIndex)
    onNavigateToMessage(matches[newIndex].message_id)

    // Load more if approaching end
    if (newIndex >= matches.length - 3 && nextCursor) {
      doSearch(query, nextCursor)
    }
  }

  const goToPrev = () => {
    if (matches.length === 0) return
    const newIndex = Math.max(currentIndex - 1, 0)
    setCurrentIndex(newIndex)
    onNavigateToMessage(matches[newIndex].message_id)
  }

  const handleMatchClick = (index: number) => {
    setCurrentIndex(index)
    onNavigateToMessage(matches[index].message_id)
  }

  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    const now = new Date()
    const isToday = date.toDateString() === now.toDateString()
    if (isToday) {
      const locale = getLocaleFromLanguage(language)
      return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    }
    const locale = getLocaleFromLanguage(language)
    return date.toLocaleDateString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  // Highlight matched text in snippet
  const highlightSnippet = (snippet: string) => {
    if (!query.trim()) return snippet
    const regex = new RegExp(`(${query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
    const parts = snippet.split(regex)
    return parts.map((part, i) =>
      regex.test(part) ? (
        <span key={i} style={{ background: 'var(--color-highlight-bg)', borderRadius: 2, padding: '0 1px' }}>
          {part}
        </span>
      ) : (
        <span key={i}>{part}</span>
      )
    )
  }

  const isAtEnd = currentIndex >= matches.length - 1 && !nextCursor

  if (!isOpen) return null

  return (
    <Box
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: tokens.colors.bg.primary,
        zIndex: tokens.zIndex.overlay,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Search Header */}
      <Box
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[2],
          padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
          background: tokens.colors.bg.secondary,
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
        }}
      >
        <button
          onClick={onClose}
            aria-label="Close search"
          style={{
            width: 36,
            height: 36,
            borderRadius: tokens.radius.full,
            border: 'none',
            background: 'transparent',
            color: tokens.colors.text.secondary,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>

        <Box
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: tokens.colors.bg.primary,
            borderRadius: tokens.radius['2xl'],
            padding: '6px 14px',
            border: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.tertiary} strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('searchChatRecords')}
            aria-label={t('searchChatRecords')}
            style={{
              flex: 1,
              border: 'none',
              background: 'transparent',
              color: tokens.colors.text.primary,
              fontSize: 14,
              outline: 'none',
              padding: '4px 0',
            }}
          />
          {query && (
            <button
              onClick={() => { setQuery(''); setMatches([]); setHasSearched(false) }}
              style={{
                border: 'none',
                background: 'transparent',
                color: tokens.colors.text.tertiary,
                cursor: 'pointer',
                padding: 2,
                display: 'flex',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </Box>

        {/* Navigation buttons */}
        {matches.length > 0 && (
          <Box style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
            <Text size="xs" color="tertiary" style={{ marginRight: 4, whiteSpace: 'nowrap' }}>
              {currentIndex + 1}/{matches.length}
            </Text>
            <button
              aria-label={t('previousResult') || 'Previous result'}
              onClick={goToPrev}
              disabled={currentIndex === 0}
              style={{
                width: 28,
                height: 28,
                borderRadius: tokens.radius.sm,
                border: 'none',
                background: 'transparent',
                color: currentIndex === 0 ? tokens.colors.text.tertiary : tokens.colors.text.primary,
                cursor: currentIndex === 0 ? 'default' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                opacity: currentIndex === 0 ? 0.4 : 1,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M18 15l-6-6-6 6" />
              </svg>
            </button>
            <button
              aria-label={t('nextResult') || 'Next result'}
              onClick={goToNext}
              disabled={isAtEnd}
              style={{
                width: 28,
                height: 28,
                borderRadius: tokens.radius.sm,
                border: 'none',
                background: 'transparent',
                color: isAtEnd ? tokens.colors.text.tertiary : tokens.colors.text.primary,
                cursor: isAtEnd ? 'default' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                opacity: isAtEnd ? 0.4 : 1,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
          </Box>
        )}
      </Box>

      {/* Results List */}
      <Box style={{ flex: 1, overflow: 'auto', padding: tokens.spacing[2] }}>
        {loading && matches.length === 0 && (
          <Box style={{ padding: tokens.spacing[6], textAlign: 'center' }}>
            <Text size="sm" color="tertiary">{t('searching')}</Text>
          </Box>
        )}

        {!loading && hasSearched && matches.length === 0 && (
          <Box style={{ padding: tokens.spacing[6], textAlign: 'center' }}>
            <Text size="sm" color="tertiary">{t('noMessagesFound')}</Text>
          </Box>
        )}

        {!hasSearched && !loading && (
          <Box style={{ padding: tokens.spacing[6], textAlign: 'center' }}>
            <Text size="sm" color="tertiary">{t('enterKeywordToSearch')}</Text>
          </Box>
        )}

        {matches.map((match, index) => (
          <button
            key={`${match.message_id}-${index}`}
            onClick={() => handleMatchClick(index)}
            style={{
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              padding: `${tokens.spacing[3]} ${tokens.spacing[3]}`,
              border: 'none',
              background: index === currentIndex ? 'var(--color-accent-primary-10)' : 'transparent',
              borderRadius: tokens.radius.md,
              cursor: 'pointer',
              textAlign: 'left',
              transition: 'background 0.15s',
              borderLeft: index === currentIndex ? `3px solid ${tokens.colors.accent.brandHover}` : '3px solid transparent',
            }}
            onMouseEnter={(e) => {
              if (index !== currentIndex) e.currentTarget.style.background = tokens.colors.bg.secondary
            }}
            onMouseLeave={(e) => {
              if (index !== currentIndex) e.currentTarget.style.background = 'transparent'
            }}
          >
            <Text size="sm" style={{ lineHeight: 1.5, color: tokens.colors.text.primary, wordBreak: 'break-word' }}>
              {highlightSnippet(match.snippet)}
            </Text>
            <Text size="xs" color="tertiary">
              {formatDate(match.created_at)}
            </Text>
          </button>
        ))}

        {loading && matches.length > 0 && (
          <Box style={{ padding: tokens.spacing[3], textAlign: 'center' }}>
            <Text size="xs" color="tertiary">{t('loadingMore')}</Text>
          </Box>
        )}
      </Box>
    </Box>
  )
}
