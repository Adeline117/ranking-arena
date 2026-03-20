'use client'

import { useState, useEffect, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { Box, Text } from '@/app/components/base'
import { SearchResult } from './types'

export function SearchSection({ onSelect }: { onSelect: (result: SearchResult) => void }) {
  const { t } = useLanguage()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)

  const search = useCallback(async (q: string) => {
    if (q.length < 2) {
      setResults([])
      return
    }
    setSearching(true)
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=10`)
      if (res.ok) {
        const data = await res.json()
        setResults(data.traders || data.results || [])
      }
    } catch {
      // Search failed silently
    } finally {
      setSearching(false)
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => search(query), 300)
    return () => clearTimeout(timer)
  }, [query, search])

  return (
    <Box style={{
      maxWidth: '600px',
      margin: `0 auto ${tokens.spacing[8]}`,
    }}>
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

      {results.length > 0 && (
        <Box style={{
          marginTop: tokens.spacing[2],
          border: `1px solid ${tokens.colors.border.primary}`,
          borderRadius: tokens.radius.lg,
          overflow: 'hidden',
          backgroundColor: tokens.colors.bg.secondary,
        }}>
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
                borderBottom: i < results.length - 1 ? `1px solid ${tokens.colors.border.primary}` : 'none',
                backgroundColor: 'transparent',
                color: tokens.colors.text.primary,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              {r.avatar_url && (
                <img
                  src={r.avatar_url.startsWith('data:') ? r.avatar_url : '/api/avatar?url=' + encodeURIComponent(r.avatar_url)}
                  alt=""
                  style={{ width: 32, height: 32, borderRadius: '50%' }}
                />
              )}
              <Box style={{ flex: 1 }}>
                <Text style={{ fontWeight: 600 }}>{r.handle}</Text>
                <Text style={{ fontSize: tokens.typography.fontSize.sm, color: tokens.colors.text.tertiary }}>
                  {r.source}
                  {r.arena_score ? ` | Score: ${r.arena_score.toFixed(1)}` : ''}
                </Text>
              </Box>
            </button>
          ))}
        </Box>
      )}
    </Box>
  )
}
