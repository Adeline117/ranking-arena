'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { clearSearchHistory } from './search-types'

interface SearchEmptyStateProps {
  searchHistory: string[]
  trendingSearches: string[]
  onClearHistory: () => void
}

export default function SearchEmptyState({
  searchHistory,
  trendingSearches,
  onClearHistory,
}: SearchEmptyStateProps) {
  const { t } = useLanguage()

  return (
    <div style={{ textAlign: 'center', padding: '80px 24px' }}>
      <div style={{
        width: 80, height: 80, borderRadius: '50%',
        background: tokens.gradient.primarySubtle,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        margin: '0 auto 24px',
      }}>
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.accent.primary} strokeWidth="1.5">
          <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
        </svg>
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, color: tokens.colors.text.primary, marginBottom: 8 }}>
        {t('search')}
      </div>
      <div style={{ fontSize: 14, color: tokens.colors.text.tertiary, maxWidth: 340, margin: '0 auto 32px' }}>
        {t('searchPrompt')}
      </div>

      {/* Search history */}
      {searchHistory.length > 0 && (
        <div style={{ maxWidth: 480, margin: '0 auto 24px', textAlign: 'left' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{
              fontSize: 11, fontWeight: 600, color: tokens.colors.text.secondary,
              textTransform: 'uppercase', letterSpacing: '0.06em',
            }}>
              {t('searchRecentSearches')}
            </div>
            <button
              onClick={() => { clearSearchHistory(); onClearHistory() }}
              style={{
                fontSize: 11, color: tokens.colors.text.tertiary, background: 'none',
                border: 'none', cursor: 'pointer', padding: '2px 6px',
              }}
            >
              {t('searchClearHistory')}
            </button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {searchHistory.map(term => (
              <Link
                key={term}
                href={`/search?q=${encodeURIComponent(term)}`}
                style={{
                  padding: '8px 18px', borderRadius: 10,
                  background: tokens.colors.bg.secondary,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  color: tokens.colors.text.secondary,
                  fontSize: 13, fontWeight: 500,
                  textDecoration: 'none', transition: 'all 0.15s',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.borderColor = tokens.colors.accent.brand
                  e.currentTarget.style.color = tokens.colors.text.primary
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.borderColor = tokens.colors.border.primary
                  e.currentTarget.style.color = tokens.colors.text.secondary
                }}
              >
                {term}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Hot searches */}
      <div style={{ maxWidth: 480, margin: '0 auto', textAlign: 'left' }}>
        <div style={{
          fontSize: 11, fontWeight: 600, color: tokens.colors.text.secondary,
          textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10,
        }}>
          {t('searchPopularSearches')}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {trendingSearches.map(term => (
            <Link
              key={term}
              href={`/search?q=${encodeURIComponent(term)}`}
              style={{
                padding: '8px 18px', borderRadius: 10,
                background: tokens.colors.bg.secondary,
                border: `1px solid ${tokens.colors.border.primary}`,
                color: tokens.colors.text.secondary,
                fontSize: 13, fontWeight: 500,
                textDecoration: 'none', transition: 'all 0.15s',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.borderColor = tokens.colors.accent.brand
                e.currentTarget.style.color = tokens.colors.text.primary
              }}
              onMouseLeave={e => {
                e.currentTarget.style.borderColor = tokens.colors.border.primary
                e.currentTarget.style.color = tokens.colors.text.secondary
              }}
            >
              {term}
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
