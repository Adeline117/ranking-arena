'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { Box, Text } from '@/app/components/base'
import { LinkedTrader } from './types'

export function LinkedAccountsSidebar({
  linkedTraders,
  onRefresh,
}: {
  linkedTraders: LinkedTrader[]
  onRefresh: () => void
}) {
  const { t } = useLanguage()

  if (linkedTraders.length === 0) return null

  return (
    <Box style={{
      padding: tokens.spacing[4],
      backgroundColor: tokens.colors.bg.secondary,
      borderRadius: tokens.radius.lg,
      border: `1px solid ${tokens.colors.border.primary}`,
      marginBottom: tokens.spacing[5],
      maxWidth: '600px',
      margin: `0 auto ${tokens.spacing[5]}`,
    }}>
      <Text style={{
        fontWeight: 700,
        fontSize: tokens.typography.fontSize.md,
        marginBottom: tokens.spacing[3],
        color: tokens.colors.text.primary,
      }}>
        {t('linkedAccounts') || 'Linked Accounts'} ({linkedTraders.length})
      </Text>
      {linkedTraders.map((lt) => (
        <Box key={lt.id} style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[3],
          padding: `${tokens.spacing[2]} 0`,
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
        }}>
          {lt.stats?.avatar_url && (
            <img
              src={lt.stats.avatar_url.startsWith('data:') ? lt.stats.avatar_url : '/api/avatar?url=' + encodeURIComponent(lt.stats.avatar_url)}
              alt=""
              style={{ width: 28, height: 28, borderRadius: '50%' }}
            />
          )}
          <Box style={{ flex: 1 }}>
            <Text style={{ fontWeight: 600, fontSize: tokens.typography.fontSize.sm }}>
              {lt.stats?.handle || lt.trader_id}
              {lt.is_primary && (
                <span style={{
                  marginLeft: tokens.spacing[2],
                  fontSize: tokens.typography.fontSize.xs,
                  color: tokens.colors.accent.primary,
                  fontWeight: 500,
                }}>
                  Primary
                </span>
              )}
            </Text>
            <Text style={{ fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary }}>
              {lt.source}
              {lt.label ? ` - ${lt.label}` : ''}
              {lt.stats?.arena_score ? ` | Score: ${lt.stats.arena_score.toFixed(1)}` : ''}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  )
}
