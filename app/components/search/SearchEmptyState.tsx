'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'

interface SearchEmptyStateProps {
  suggestions?: string[]
  onClose: () => void
  t: (key: string) => string
}

export function SearchEmptyState({ suggestions, onClose, t }: SearchEmptyStateProps) {
  return (
    <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
      <Text size="sm" color="tertiary">{t('noRelatedResults')}</Text>
      {suggestions && suggestions.length > 0 && (
        <Box style={{ marginTop: tokens.spacing[3] }}>
          <Text size="xs" color="tertiary">{t('searchDidYouMean')}</Text>
          <Box style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacing[2], justifyContent: 'center', marginTop: tokens.spacing[2] }}>
            {suggestions.map((suggestion) => (
              <Link key={suggestion} href={`/search?q=${encodeURIComponent(suggestion)}`} style={{ textDecoration: 'none' }} onClick={onClose}>
                <Box style={{
                  padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`, borderRadius: tokens.radius.md,
                  background: 'var(--color-accent-primary-12)', border: '1px solid var(--color-accent-primary-25)',
                  cursor: 'pointer', transition: 'all 0.1s',
                }}>
                  <Text size="xs" style={{ color: tokens.colors.accent.primary, fontWeight: 600 }}>{suggestion}</Text>
                </Box>
              </Link>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  )
}

export function SearchSkeleton() {
  return (
    <Box style={{ padding: `${tokens.spacing[2]} 0` }}>
      {[1, 2, 3, 4].map((i) => (
        <Box key={i} style={{
          display: 'flex', alignItems: 'center', gap: tokens.spacing[3],
          padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
        }}>
          <Box style={{
            width: 28, height: 28, borderRadius: tokens.radius.full,
            background: tokens.colors.bg.tertiary, flexShrink: 0,
            animation: 'pulse 1.5s ease-in-out infinite',
          }} />
          <Box style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <Box style={{
              width: `${50 + i * 12}%`, height: 12,
              background: tokens.colors.bg.tertiary, borderRadius: tokens.radius.sm,
              animation: 'pulse 1.5s ease-in-out infinite',
            }} />
            <Box style={{
              width: `${30 + i * 8}%`, height: 10,
              background: tokens.colors.bg.tertiary, borderRadius: tokens.radius.sm,
              animation: 'pulse 1.5s ease-in-out infinite', opacity: 0.6,
            }} />
          </Box>
        </Box>
      ))}
    </Box>
  )
}
