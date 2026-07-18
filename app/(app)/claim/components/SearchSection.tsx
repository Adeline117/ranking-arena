'use client'

import { useState, useEffect, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { Box, Text } from '@/app/components/base'
import ErrorMessage from '@/app/components/ui/ErrorMessage'
import { SearchResult } from './types'
import { avatarSrc } from '@/lib/utils/avatar-proxy'

export function SearchSection({ onSelect }: { onSelect: (result: SearchResult) => void }) {
  const { t } = useLanguage()
  const searchFailedMessage = t('searchFailed')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  const search = useCallback(
    async (q: string) => {
      if (q.length < 2) {
        setResults([])
        setSearchError(null)
        return
      }
      setSearching(true)
      setSearchError(null)
      setResults([])
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=10`)
        if (!res.ok) throw new Error(`Search request failed (${res.status})`)

        const raw = await res.json()
        // /api/search returns { success, data: { results: { traders: UnifiedSearchResult[] } } }.
        // Map UnifiedSearchResult ({ id: 'platform:key', title: '@handle', avatar, meta })
        // onto the SearchResult shape the claim flow consumes.
        const items: Array<{
          id?: string
          title?: string
          avatar?: string | null
          meta?: { platform?: string; arena_score?: number; roi?: number }
        }> = raw.data?.results?.traders || []
        setResults(
          items.map((item) => ({
            handle: item.title?.replace(/^@/, '') || item.id?.split(':')[1] || '',
            source: item.meta?.platform || item.id?.split(':')[0] || '',
            source_trader_id: item.id?.split(':')[1] || '',
            avatar_url: item.avatar || undefined,
            arena_score: item.meta?.arena_score,
            roi: item.meta?.roi,
          }))
        )
      } catch {
        setSearchError(searchFailedMessage)
      } finally {
        setSearching(false)
      }
    },
    [searchFailedMessage]
  )

  useEffect(() => {
    const timer = setTimeout(() => search(query), 300)
    return () => clearTimeout(timer)
  }, [query, search])

  return (
    <Box
      style={{
        maxWidth: '600px',
        margin: `0 auto ${tokens.spacing[8]}`,
      }}
    >
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('claimPageSearchPlaceholder')}
        style={{
          width: '100%',
          padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
          fontSize: tokens.typography.fontSize.lg,
          borderRadius: tokens.radius.lg,
          border: `2px solid ${tokens.colors.border.primary}`,
          backgroundColor: tokens.colors.bg.secondary,
          color: tokens.colors.text.primary,
          outline: 'none',
        }}
      />

      {searching && (
        <Text style={{ padding: tokens.spacing[3], color: tokens.colors.text.tertiary }}>
          {t('searching')}
        </Text>
      )}

      {searchError && !searching && (
        <Box style={{ marginTop: tokens.spacing[3] }}>
          <ErrorMessage
            title={t('searchFailedTitle')}
            message={searchError}
            onRetry={() => void search(query)}
          />
        </Box>
      )}

      {results.length > 0 && (
        <Box
          style={{
            marginTop: tokens.spacing[2],
            border: `1px solid ${tokens.colors.border.primary}`,
            borderRadius: tokens.radius.lg,
            overflow: 'hidden',
            backgroundColor: tokens.colors.bg.secondary,
          }}
        >
          {results.map((r, i) => (
            <button
              key={`${r.source}-${r.source_trader_id}-${i}`}
              onClick={() => onSelect(r)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[3],
                padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                border: 'none',
                borderBottom:
                  i < results.length - 1 ? `1px solid ${tokens.colors.border.primary}` : 'none',
                backgroundColor: 'transparent',
                color: tokens.colors.text.primary,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              {r.avatar_url && (
                <img
                  src={avatarSrc(r.avatar_url)}
                  alt={r.handle || 'Trader'}
                  style={{ width: 32, height: 32, borderRadius: '50%' }}
                />
              )}
              <Box style={{ flex: 1 }}>
                <Text style={{ fontWeight: tokens.typography.fontWeight.semibold }}>
                  {r.handle}
                </Text>
                <Text
                  style={{
                    fontSize: tokens.typography.fontSize.sm,
                    color: tokens.colors.text.tertiary,
                  }}
                >
                  {r.source}
                  {r.arena_score ? ` | ${t('scoreLabel')}: ${r.arena_score.toFixed(1)}` : ''}
                </Text>
              </Box>
            </button>
          ))}
        </Box>
      )}
    </Box>
  )
}
