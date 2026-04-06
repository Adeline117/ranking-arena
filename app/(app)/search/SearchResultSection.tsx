'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { SECTION_LIMIT, getHref } from './search-types'
import type { SearchResult } from './search-types'

interface SearchResultSectionProps {
  title: string
  results: SearchResult[]
  total: number
  tabParam: string
  iconLetter: string
  accentColor: string
  accentBg: string
  query: string
  highlightText: (text: string, q: string) => React.ReactNode
}

export default function SearchResultSection({
  title,
  results,
  total,
  tabParam,
  iconLetter,
  accentColor,
  accentBg,
  query,
  highlightText,
}: SearchResultSectionProps) {
  const { t } = useLanguage()

  if (results.length === 0) return null

  return (
    <section style={{
      background: tokens.colors.bg.secondary,
      border: `1px solid ${tokens.colors.border.primary}`,
      borderRadius: 14,
      overflow: 'hidden',
    }}>
      {/* Section header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 18px',
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 28, height: 28, borderRadius: tokens.radius.md,
            background: accentBg,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 12, fontWeight: 700, color: accentColor,
          }}>
            {iconLetter}
          </div>
          <span style={{
            fontSize: 16, fontWeight: 600, color: tokens.colors.text.primary,
          }}>
            {title}
          </span>
          <span style={{
            fontSize: 12, color: tokens.colors.text.tertiary,
            fontWeight: 500,
          }}>
            {total > SECTION_LIMIT ? `${total}+` : total}
          </span>
        </div>
        {total > SECTION_LIMIT && (
          <Link
            href={`/search?q=${encodeURIComponent(query)}&tab=${tabParam}`}
            style={{
              fontSize: 13, color: tokens.colors.accent.brand,
              textDecoration: 'none', fontWeight: 500,
            }}
          >
            {t('searchViewAll')}
          </Link>
        )}
      </div>

      {/* Results */}
      {results.map((result, idx) => (
        <Link
          key={`${result.type}-${result.id}`}
          href={getHref(result)}
          style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '12px 18px',
            textDecoration: 'none', color: 'inherit',
            borderBottom: idx < results.length - 1 ? `1px solid ${tokens.colors.border.primary}` : 'none',
            transition: 'background 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--overlay-hover)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: 14, fontWeight: 600, color: tokens.colors.text.primary,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {highlightText(result.title, query)}
            </div>
            {result.subtitle && (
              <div style={{
                fontSize: 12, color: tokens.colors.text.tertiary,
                marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {result.subtitle}
              </div>
            )}
          </div>
          {result.meta && (
            <span style={{
              fontSize: 11, padding: '2px 8px', borderRadius: tokens.radius.full,
              background: accentBg, color: accentColor, fontWeight: 600,
              flexShrink: 0, textTransform: 'uppercase',
            }}>
              {result.meta}
            </span>
          )}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.tertiary} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.5 }}>
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </Link>
      ))}
    </section>
  )
}
