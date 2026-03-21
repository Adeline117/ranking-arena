'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { CloseIcon } from '../ui/icons'
import SearchDropdown from './SearchDropdown'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface MobileSearchOverlayProps {
  open: boolean
  onClose: () => void
}

/**
 * Full-screen mobile search overlay
 * Triggered from mobile nav search icon
 * Optimized for touch with larger tap targets
 */
export default function MobileSearchOverlay({ open, onClose }: MobileSearchOverlayProps) {
  const { t, language } = useLanguage()
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [searchHistory, setSearchHistory] = useState<string[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  // Load search history
  useEffect(() => {
    try {
      const stored = localStorage.getItem('arena-search-history')
      if (stored) setSearchHistory(JSON.parse(stored))
    } catch { /* ignore */ }
  }, [])

  const saveToHistory = useCallback((q: string) => {
    const trimmed = q.trim()
    if (!trimmed) return
    setSearchHistory(prev => {
      const updated = [trimmed, ...prev.filter(h => h !== trimmed)].slice(0, 10)
      try { localStorage.setItem('arena-search-history', JSON.stringify(updated)) } catch { /* ignore */ }
      return updated
    })
  }, [])

  const clearHistory = useCallback(() => {
    setSearchHistory([])
    try { localStorage.removeItem('arena-search-history') } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus()
    }
    if (!open) {
      setQuery('')
    }
  }, [open])

  // Close on Escape key
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  // Prevent body scrolling when overlay is open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [open])

  if (!open) return null

  return (
    <Box
      role="dialog"
      aria-modal="true"
      aria-label={t('search') || 'Search'}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: tokens.colors.bg.primary,
        zIndex: tokens.zIndex.modal,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header with search input */}
      <Box
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[3],
          padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
        }}
      >
        <Box style={{ flex: 1, position: 'relative' }}>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && query.trim()) {
                e.preventDefault()
                saveToHistory(query.trim())
                router.push(`/search?q=${encodeURIComponent(query.trim())}`)
                onClose()
              }
            }}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
            style={{
              width: '100%',
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              background: tokens.colors.bg.tertiary,
              border: `1px solid ${tokens.colors.border.primary}`,
              borderRadius: tokens.radius.md,
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.base,
              outline: 'none',
            }}
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              style={{
                position: 'absolute',
                right: 12,
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'transparent',
                border: 'none',
                color: tokens.colors.text.tertiary,
                cursor: 'pointer',
                padding: tokens.spacing[1],
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <CloseIcon size={16} />
            </button>
          )}
        </Box>
        <button
          onClick={onClose}
          style={{
            background: 'transparent',
            border: 'none',
            color: tokens.colors.text.secondary,
            cursor: 'pointer',
            padding: tokens.spacing[2],
            fontSize: tokens.typography.fontSize.sm,
            minWidth: 44,
            minHeight: 44,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text size="sm">{t('cancel')}</Text>
        </button>
      </Box>

      {/* Search results area - full height scroll */}
      <Box
        className="mobile-search-results"
        style={{
          flex: 1,
          overflowY: 'auto',
          WebkitOverflowScrolling: 'touch',
          position: 'relative',
        }}
      >
        {/* Search history when no query */}
        {!query && searchHistory.length > 0 && (
          <Box style={{ padding: tokens.spacing[4] }}>
            <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: tokens.spacing[3] }}>
              <Text size="sm" weight="bold" style={{ color: tokens.colors.text.secondary }}>
                {t('recentSearches')}
              </Text>
              <button
                onClick={clearHistory}
                style={{ background: 'none', border: 'none', color: tokens.colors.text.tertiary, fontSize: tokens.typography.fontSize.xs, cursor: 'pointer', padding: tokens.spacing[1] }}
              >
                {t('clearButton')}
              </button>
            </Box>
            <Box style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacing[2] }}>
              {searchHistory.map((term, i) => (
                <button
                  key={i}
                  onClick={() => {
                    saveToHistory(term)
                    router.push(`/search?q=${encodeURIComponent(term)}`)
                    onClose()
                  }}
                  style={{
                    padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                    background: tokens.colors.bg.tertiary,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    borderRadius: tokens.radius.full,
                    color: tokens.colors.text.secondary,
                    fontSize: tokens.typography.fontSize.sm,
                    cursor: 'pointer',
                    minHeight: 36,
                  }}
                >
                  {term}
                </button>
              ))}
            </Box>
          </Box>
        )}

        {/* Override dropdown absolute positioning for mobile overlay context */}
        <style>{`.mobile-search-results > div { position: relative !important; top: auto !important; max-height: none !important; border: none !important; box-shadow: none !important; border-radius: 0 !important; }`}</style>
        <SearchDropdown
          open={true}
          query={query}
          onClose={() => {
            if (query.trim()) saveToHistory(query.trim())
            onClose()
          }}
        />
      </Box>
    </Box>
  )
}
