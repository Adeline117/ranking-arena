'use client'

import { useState, useEffect, useCallback, useId, useRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { Box, Text } from '@/app/components/base'
import ErrorMessage from '@/app/components/ui/ErrorMessage'
import { SearchResult } from './types'
import { avatarSrc } from '@/lib/utils/avatar-proxy'

type SearchState =
  | { status: 'idle' }
  | { status: 'loading'; query: string }
  | { status: 'error'; query: string; message: string }
  | { status: 'success'; query: string; results: SearchResult[] }

type ActiveRequest = {
  controller: AbortController
  generation: number
  query: string
}

export function SearchSection({ onSelect }: { onSelect: (result: SearchResult) => void }) {
  const { t } = useLanguage()
  const searchFailedMessage = t('searchFailed')
  const [query, setQuery] = useState('')
  const [searchState, setSearchState] = useState<SearchState>({ status: 'idle' })
  const inputId = useId()
  const feedbackId = `${inputId}-feedback`
  const errorId = `${inputId}-error`
  const resultsId = `${inputId}-results`
  const generationRef = useRef(0)
  const currentQueryRef = useRef('')
  const activeRequestRef = useRef<ActiveRequest | null>(null)

  const isCurrentRequest = useCallback((request: ActiveRequest) => {
    const activeRequest = activeRequestRef.current
    return (
      generationRef.current === request.generation &&
      currentQueryRef.current === request.query &&
      activeRequest?.controller === request.controller
    )
  }, [])

  const search = useCallback(
    async (q: string) => {
      const normalizedQuery = q.trim()
      if (normalizedQuery.length < 2 || currentQueryRef.current !== normalizedQuery) {
        return
      }

      activeRequestRef.current?.controller.abort()
      const request: ActiveRequest = {
        controller: new AbortController(),
        generation: generationRef.current + 1,
        query: normalizedQuery,
      }
      generationRef.current = request.generation
      activeRequestRef.current = request
      setSearchState({ status: 'loading', query: normalizedQuery })

      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(normalizedQuery)}&limit=10`, {
          signal: request.controller.signal,
        })
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

        if (!isCurrentRequest(request)) return

        const results = items.map((item) => {
          const identity = item.id || ''
          const separatorIndex = identity.indexOf(':')
          const identitySource = separatorIndex >= 0 ? identity.slice(0, separatorIndex) : identity
          const traderKey = separatorIndex >= 0 ? identity.slice(separatorIndex + 1) : ''

          return {
            handle: item.title?.replace(/^@/, '') || traderKey,
            source: item.meta?.platform || identitySource,
            source_trader_id: traderKey,
            avatar_url: item.avatar || undefined,
            arena_score: item.meta?.arena_score,
            roi: item.meta?.roi,
          }
        })
        setSearchState({ status: 'success', query: normalizedQuery, results })
      } catch {
        if (!isCurrentRequest(request)) return
        setSearchState({ status: 'error', query: normalizedQuery, message: searchFailedMessage })
      } finally {
        if (isCurrentRequest(request)) {
          activeRequestRef.current = null
        }
      }
    },
    [isCurrentRequest, searchFailedMessage]
  )

  useEffect(() => {
    const normalizedQuery = query.trim()
    if (normalizedQuery.length < 2) return

    const timer = setTimeout(() => search(normalizedQuery), 300)
    return () => clearTimeout(timer)
  }, [query, search])

  useEffect(
    () => () => {
      generationRef.current += 1
      currentQueryRef.current = ''
      activeRequestRef.current?.controller.abort()
      activeRequestRef.current = null
    },
    []
  )

  const handleQueryChange = useCallback((value: string) => {
    const normalizedQuery = value.trim()
    currentQueryRef.current = normalizedQuery
    generationRef.current += 1
    activeRequestRef.current?.controller.abort()
    activeRequestRef.current = null
    setQuery(value)
    setSearchState({ status: 'idle' })
  }, [])

  const results = searchState.status === 'success' ? searchState.results : []
  const hasResults = results.length > 0
  const isEmpty = searchState.status === 'success' && !hasResults
  const statusMessage =
    searchState.status === 'loading'
      ? t('searching')
      : searchState.status === 'success'
        ? hasResults
          ? `${results.length} ${t('resultsCount')}`
          : t('noResultsForQuery').replace('{query}', searchState.query)
        : ''

  return (
    <Box
      style={{
        maxWidth: '600px',
        margin: `0 auto ${tokens.spacing[8]}`,
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        {t('searchTradersLabel')}
      </label>
      <input
        id={inputId}
        type="text"
        value={query}
        onChange={(e) => handleQueryChange(e.target.value)}
        placeholder={t('claimPageSearchPlaceholder')}
        aria-describedby={
          searchState.status === 'error'
            ? errorId
            : searchState.status !== 'idle'
              ? feedbackId
              : undefined
        }
        aria-controls={searchState.status !== 'idle' ? resultsId : undefined}
        aria-busy={searchState.status === 'loading'}
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

      <span id={feedbackId} className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {statusMessage}
      </span>

      {searchState.status !== 'idle' && (
        <Box id={resultsId}>
          {searchState.status === 'loading' && (
            <Text
              aria-hidden="true"
              style={{ padding: tokens.spacing[3], color: tokens.colors.text.tertiary }}
            >
              {t('searching')}
            </Text>
          )}

          {searchState.status === 'error' && (
            <Box id={errorId} style={{ marginTop: tokens.spacing[3] }}>
              <ErrorMessage
                title={t('searchFailedTitle')}
                message={searchState.message}
                onRetry={() => void search(query)}
              />
            </Box>
          )}

          {isEmpty && (
            <Text
              aria-hidden="true"
              style={{
                marginTop: tokens.spacing[2],
                padding: tokens.spacing[4],
                color: tokens.colors.text.tertiary,
                textAlign: 'center',
              }}
            >
              {t('noResultsForQuery').replace('{query}', searchState.query)}
            </Text>
          )}

          {hasResults && (
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
      )}
    </Box>
  )
}
