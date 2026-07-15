'use client'

import Link from 'next/link'
import Image from 'next/image'
import { t, type TranslationKey } from '@/lib/i18n'
import { tokens, alpha } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { avatarSrc } from '@/lib/utils/avatar-proxy'
import type { UnifiedSearchResult } from '@/app/api/search/route'

// Category config for search results grouping
// Label comes from t(category) — the keys traders/posts/users/groups exist in
// all 4 locales. (Was a zh/en-only labelZh/labelEn map that showed English to
// ja/ko users.)
export const CATEGORY_CONFIG = {
  traders: { icon: 'T', color: 'var(--color-verified-web3)' },
  posts: { icon: 'P', color: 'var(--color-score-profitability)' },
  users: { icon: 'U', color: 'var(--color-score-average)' },
  groups: { icon: 'G', color: 'var(--color-score-average)' },
} as const

export type CategoryKey = keyof typeof CATEGORY_CONFIG

/** Highlight matched keyword in text */
export function highlightMatch(text: string, q: string): React.ReactNode {
  if (!text || !q.trim()) return text
  const lower = text.toLowerCase()
  const lq = q.toLowerCase().trim()
  const parts: React.ReactNode[] = []
  let last = 0
  let idx = lower.indexOf(lq)
  while (idx !== -1) {
    if (idx > last) parts.push(text.slice(last, idx))
    parts.push(
      <mark
        key={`hl-${idx}`}
        style={{
          backgroundColor: 'var(--color-accent-primary-25, var(--color-accent-primary-20))',
          color: 'inherit',
          borderRadius: 2,
          padding: '0 1px',
          fontWeight: 700,
        }}
      >
        {text.slice(idx, idx + lq.length)}
      </mark>
    )
    last = idx + lq.length
    idx = lower.indexOf(lq, last)
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts.length > 0 ? parts : text
}

interface SearchResultGroupProps {
  category: CategoryKey
  items: UnifiedSearchResult[]
  query: string
  selectedIndex: number
  offset: number
  onResultClick: (resultId?: string, resultType?: string) => void
  onResultMouseEnter: (href: string) => void
}

export function SearchResultGroup({
  category,
  items,
  query,
  selectedIndex,
  offset,
  onResultClick,
  onResultMouseEnter,
}: SearchResultGroupProps) {
  if (items.length === 0) return null
  const config = CATEGORY_CONFIG[category]
  const label = t(category as TranslationKey)

  return (
    <Box key={category}>
      <Box
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[2],
          padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
        }}
      >
        <Box
          style={{
            width: 20,
            height: 20,
            borderRadius: tokens.radius.sm,
            background: `${alpha(config.color, 13)}`,
            color: config.color,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 11,
            fontWeight: 800,
            flexShrink: 0,
          }}
        >
          {config.icon}
        </Box>
        <Text
          size="xs"
          weight="bold"
          color="tertiary"
          style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}
        >
          {label}
        </Text>
        <Text size="xs" color="tertiary">
          ({items.length})
        </Text>
      </Box>

      {items.map((result, index) => {
        const globalIndex = offset + index
        const isSelected = globalIndex === selectedIndex
        return (
          <Link
            key={`${result.type}-${result.id}`}
            href={result.href}
            style={{ textDecoration: 'none' }}
            onClick={() => onResultClick(result.id, result.type)}
            onMouseEnter={() => onResultMouseEnter(result.href)}
            role="option"
            aria-selected={isSelected}
            id={`search-option-${globalIndex}`}
          >
            <Box
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[3],
                padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                borderBottom: `1px solid ${tokens.colors.border.primary}`,
                cursor: 'pointer',
                background: isSelected ? tokens.colors.bg.tertiary : 'transparent',
                transition: 'background 0.1s',
              }}
              onMouseEnter={(e) => {
                // U3-3: hover shows a visual highlight but must NOT drive the
                // arrow-key selection state — otherwise Enter would navigate to a
                // merely-hovered row instead of going to /search. Keyboard selection
                // (aria-selected / Enter target) is owned solely by ArrowUp/Down.
                e.currentTarget.style.background = tokens.colors.bg.tertiary
              }}
              onMouseLeave={(e) => {
                if (globalIndex !== selectedIndex) e.currentTarget.style.background = 'transparent'
              }}
            >
              {result.avatar ? (
                <Image
                  src={avatarSrc(result.avatar)}
                  alt={result.title || 'Avatar'}
                  width={28}
                  height={28}
                  unoptimized
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: tokens.radius.full,
                    objectFit: 'cover',
                    flexShrink: 0,
                  }}
                  {...(globalIndex < 5 ? { priority: true } : { loading: 'lazy' as const })}
                  onError={(e) => {
                    ;(e.target as HTMLImageElement).style.display = 'none'
                    ;(e.target as HTMLImageElement).nextElementSibling?.removeAttribute('hidden')
                  }}
                />
              ) : null}
              {/* Fallback icon — shown when avatar is missing or fails to load */}
              <Box
                hidden={!!result.avatar}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: tokens.radius.full,
                  background: `${alpha(config.color, 8)}`,
                  color: config.color,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 12,
                  fontWeight: 700,
                  flexShrink: 0,
                }}
              >
                {config.icon}
              </Box>
              <Box style={{ flex: 1, minWidth: 0 }}>
                <Box style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Text
                    size="sm"
                    style={{
                      color: tokens.colors.text.primary,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {highlightMatch(result.title, query)}
                  </Text>
                  {Boolean(result.meta?.is_bot) && (
                    <span
                      style={{
                        padding: '0px 4px',
                        borderRadius: 4,
                        fontSize: 10,
                        fontWeight: 600,
                        color: 'var(--color-brand-text)',
                        background: 'var(--color-brand-muted)',
                        border: '1px solid color-mix(in srgb, var(--color-brand) 25%, transparent)',
                        lineHeight: 1.4,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 2,
                        flexShrink: 0,
                      }}
                    >
                      <span style={{ fontSize: 8 }}>{'⚡'}</span>Bot
                    </span>
                  )}
                </Box>
                {result.subtitle && (
                  <Text
                    size="xs"
                    color="tertiary"
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {highlightMatch(result.subtitle, query)}
                  </Text>
                )}
              </Box>
              {isSelected && (
                <Text size="xs" color="tertiary" style={{ flexShrink: 0, opacity: 0.5 }}>
                  Enter
                </Text>
              )}
            </Box>
          </Link>
        )
      })}
    </Box>
  )
}
