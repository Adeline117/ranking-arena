'use client'

import Link from 'next/link'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { CloseIcon } from '../ui/icons'

interface TrendingItem {
  query: string
  searchCount: number
  rank: number
  category?: 'trader' | 'token' | 'general'
}

interface HotPost {
  id: string
  title: string
  hotScore: number
  rank: number
  view_count?: number
}

interface SearchHistoryProps {
  history: string[]
  onClear: (e: React.MouseEvent) => void
  onDelete: (term: string, e: React.MouseEvent) => void
  onClose: () => void
  t: (key: string) => string
}

/** Search history section */
export function SearchHistory({ history, onClear, onDelete, onClose, t }: SearchHistoryProps) {
  if (history.length === 0) return null

  return (
    <Box>
      <Box style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
      }}>
        <Text size="xs" weight="bold" color="tertiary" style={{ textTransform: 'uppercase' }}>
          {t('searchHistory')}
        </Text>
        <button
          onClick={onClear}
          aria-label={t('clearSearchHistory')}
          style={{
            background: 'transparent', border: 'none',
            color: tokens.colors.text.tertiary, cursor: 'pointer',
            fontSize: tokens.typography.fontSize.xs, padding: 0,
          }}
        >
          {t('clearSearchHistory')}
        </button>
      </Box>
      <Box>
        {history.map((term, idx) => (
          <Box
            key={`${term}-${idx}`}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              borderBottom: `1px solid ${tokens.colors.border.primary}`,
            }}
            onMouseEnter={e => { e.currentTarget.style.background = tokens.colors.bg.tertiary }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
          >
            <Link
              href={`/search?q=${encodeURIComponent(term)}`}
              style={{ textDecoration: 'none', flex: 1 }}
              onClick={onClose}
            >
              <Text size="sm" style={{ color: tokens.colors.text.primary }}>{term}</Text>
            </Link>
            <button
              onClick={e => onDelete(term, e)}
              aria-label={`删除搜索记录: ${term}`}
              style={{
                background: 'transparent', border: 'none',
                color: tokens.colors.text.tertiary, cursor: 'pointer',
                padding: tokens.spacing[1], display: 'flex', alignItems: 'center',
                marginLeft: tokens.spacing[2],
              }}
              onMouseEnter={e => { e.currentTarget.style.color = tokens.colors.text.secondary }}
              onMouseLeave={e => { e.currentTarget.style.color = tokens.colors.text.tertiary }}
            >
              <CloseIcon size={14} />
            </button>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

// ─── Trending Searches ───────────────────────────────────────────────

interface TrendingSearchesProps {
  trending: TrendingItem[]
  language: string
  onClose: () => void
  hasHistory: boolean
  loading?: boolean
}

/** Trending / popular searches section */
export function TrendingSearches({ trending, language: _language, onClose, hasHistory, loading }: TrendingSearchesProps) {
  const { t } = useLanguage()
  if (!loading && trending.length === 0) return null

  return (
    <Box>
      <Box style={{
        padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
        borderBottom: hasHistory ? `1px solid ${tokens.colors.border.primary}` : 'none',
      }}>
        <Text size="xs" weight="bold" color="tertiary" style={{ textTransform: 'uppercase' }}>
          {t('popularSearches')}
        </Text>
      </Box>
      <Box style={{ padding: `${tokens.spacing[2]} ${tokens.spacing[4]}` }}>
        {loading ? (
          <Box style={{ display: 'flex', gap: tokens.spacing[2], flexWrap: 'wrap' }}>
            {[1,2,3,4,5].map(i => (
              <Box key={i} style={{ width: 60 + i * 10, height: 28, borderRadius: tokens.radius.full, background: 'var(--overlay-hover)', animation: 'pulse 1.5s infinite' }} />
            ))}
          </Box>
        ) : (
        <Box style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacing[2] }}>
          {trending.slice(0, 6).map((item) => {
            const q = typeof item === 'string' ? item : item.query
            const category = typeof item === 'string' ? 'general' : item.category
            return (
              <Link
                key={q}
                href={`/search?q=${encodeURIComponent(q)}`}
                style={{ textDecoration: 'none' }}
                onClick={onClose}
              >
                <Box
                  style={{
                    padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                    borderRadius: tokens.radius.md,
                    background: tokens.colors.bg.tertiary,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    cursor: 'pointer', transition: 'all 0.1s',
                    display: 'flex', alignItems: 'center', gap: tokens.spacing[1],
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.borderColor = tokens.colors.accent.primary
                    e.currentTarget.style.background = 'var(--color-accent-primary-12)'
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.borderColor = tokens.colors.border.primary
                    e.currentTarget.style.background = tokens.colors.bg.tertiary
                  }}
                >
                  <Text size="xs" style={{ color: tokens.colors.text.secondary, fontWeight: 600 }}>
                    {q}
                  </Text>
                  {category === 'token' && (
                    <Box style={{
                      width: 4, height: 4, borderRadius: '50%',
                      background: 'var(--color-accent-primary)', opacity: 0.6,
                    }} />
                  )}
                </Box>
              </Link>
            )
          })}
        </Box>
        )}
      </Box>
    </Box>
  )
}

// ─── Hot Posts ───────────────────────────────────────────────────────

interface HotPostsProps {
  posts: HotPost[]
  loading: boolean
  language: string
  translatedTitles: Record<string, string>
  onClose: () => void
  hasHistory: boolean
  t: (key: string) => string
}

/** Hot posts section */
export function HotPosts({ posts, loading, language, translatedTitles, onClose, hasHistory, t }: HotPostsProps) {
  return (
    <Box>
      <Box style={{
        padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
        borderBottom: hasHistory ? `1px solid ${tokens.colors.border.primary}` : 'none',
      }}>
        <Text size="xs" weight="bold" color="tertiary" style={{ textTransform: 'uppercase' }}>
          {t('hotPosts')}
        </Text>
      </Box>
      <Box>
        {loading ? (
          <Box style={{ padding: `${tokens.spacing[2]} 0` }}>
            {[1, 2, 3, 4, 5].map((i) => (
              <Box key={i} style={{
                display: 'flex', alignItems: 'center', gap: tokens.spacing[3],
                padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                borderBottom: `1px solid ${tokens.colors.border.primary}`,
              }}>
                <Box style={{
                  width: 24, height: 16, background: tokens.colors.bg.tertiary,
                  borderRadius: tokens.radius.sm, animation: 'pulse 1.5s ease-in-out infinite',
                }} />
                <Box style={{ flex: 1 }}>
                  <Box style={{
                    width: '70%', height: 14, background: tokens.colors.bg.tertiary,
                    borderRadius: tokens.radius.sm, animation: 'pulse 1.5s ease-in-out infinite',
                  }} />
                </Box>
              </Box>
            ))}
          </Box>
        ) : posts.length === 0 ? (
          <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
            <Text size="sm" color="tertiary">{t('noHotPosts')}</Text>
          </Box>
        ) : (
          posts.map((post) => (
            <Link
              key={post.id}
              href={`/post/${post.id}`}
              style={{ textDecoration: 'none' }}
              onClick={onClose}
            >
              <Box
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: tokens.spacing[3],
                  padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                  borderBottom: `1px solid ${tokens.colors.border.primary}`,
                  cursor: 'pointer',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = tokens.colors.bg.tertiary }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
              >
                <Text
                  size="sm"
                  weight="black"
                  style={{
                    color: post.rank <= 3 ? tokens.colors.accent.warning : tokens.colors.text.tertiary,
                    minWidth: 24, textAlign: 'right',
                  }}
                >
                  {post.rank}
                </Text>
                <Box style={{ flex: 1 }}>
                  <Text size="sm" style={{ color: tokens.colors.text.primary, lineHeight: 1.5 }}>
                    {translatedTitles[`${language}:${post.id}`] || post.title}
                  </Text>
                </Box>
              </Box>
            </Link>
          ))
        )}
      </Box>
    </Box>
  )
}
