'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import { Box, Text } from '../base'
import { getTraderAvatarUrl } from '@/lib/utils/avatar'

export interface Mover {
  platform: string
  trader_key: string
  rank: number
  arena_score: number | null
  roiDelta: number
  handle: string | null
  avatar_url: string | null
}

interface LeaderboardChangelogProps {
  risers: Mover[]
  fallers: Mover[]
}

function MoverRow({ mover, type }: { mover: Mover; type: 'riser' | 'faller' }) {
  const isRiser = type === 'riser'
  const changeColor = isRiser ? 'var(--color-accent-success)' : 'var(--color-accent-error)'
  const arrow = isRiser ? '\u2191' : '\u2193'
  const absChange = Math.abs(mover.roiDelta)
  const displayName = mover.handle || mover.trader_key.slice(0, 10)

  return (
    <Box
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
        borderRadius: tokens.radius.md,
        background: tokens.colors.bg.secondary,
        border: `1px solid ${tokens.colors.border.primary}`,
        gap: tokens.spacing[2],
      }}
    >
      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], minWidth: 0 }}>
        {/* Avatar */}
        {mover.avatar_url ? (
          <img
            src={getTraderAvatarUrl(mover.avatar_url) || mover.avatar_url}
            alt={displayName}
            width={24}
            height={24}
            style={{ borderRadius: '50%', flexShrink: 0 }}
          />
        ) : (
          <Box
            style={{
              width: 24,
              height: 24,
              borderRadius: '50%',
              background: tokens.colors.bg.tertiary,
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 10,
              color: tokens.colors.text.tertiary,
            }}
          >
            {displayName[0]?.toUpperCase() || '?'}
          </Box>
        )}
        <Box style={{ minWidth: 0 }}>
          <Text
            size="sm"
            weight="bold"
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: 120,
              display: 'block',
            }}
          >
            {displayName}
          </Text>
          <Text size="xs" color="tertiary">
            #{mover.rank} {mover.platform}
          </Text>
        </Box>
      </Box>
      <Box style={{ flexShrink: 0, textAlign: 'right' }}>
        <span style={{
          color: changeColor,
          fontWeight: 700,
          fontSize: tokens.typography.fontSize.sm,
        }}>
          {arrow}{absChange}
        </span>
        {mover.arena_score != null && (
          <Text size="xs" color="tertiary" style={{ display: 'block' }}>
            {Number(mover.arena_score).toFixed(0)}
          </Text>
        )}
      </Box>
    </Box>
  )
}

export default function LeaderboardChangelog({ risers, fallers }: LeaderboardChangelogProps) {
  const { t } = useLanguage()

  const hasData = risers.length > 0 || fallers.length > 0

  if (!hasData) {
    return (
      <Box style={{
        padding: tokens.spacing[4],
        color: tokens.colors.text.tertiary,
        fontSize: tokens.typography.fontSize.sm,
        textAlign: 'center',
        background: tokens.glass.bg.light,
        borderRadius: tokens.radius.lg,
        border: `1px solid ${tokens.colors.border.primary}`,
      }}>
        {t('noData')}
      </Box>
    )
  }

  return (
    <Box style={{
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: tokens.spacing[4],
    }}>
      {/* Rising column */}
      <Box>
        <Box style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[1],
          marginBottom: tokens.spacing[2],
        }}>
          <span style={{ color: 'var(--color-accent-success)', fontSize: 14 }}>{'\u2191'}</span>
          <Text size="sm" weight="bold" style={{ color: 'var(--color-accent-success)' }}>
            Rising
          </Text>
        </Box>
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
          {risers.map(r => (
            <MoverRow key={`${r.platform}:${r.trader_key}`} mover={r} type="riser" />
          ))}
          {risers.length === 0 && (
            <Text size="xs" color="tertiary">{t('noData')}</Text>
          )}
        </Box>
      </Box>

      {/* Falling column */}
      <Box>
        <Box style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[1],
          marginBottom: tokens.spacing[2],
        }}>
          <span style={{ color: 'var(--color-accent-error)', fontSize: 14 }}>{'\u2193'}</span>
          <Text size="sm" weight="bold" style={{ color: 'var(--color-accent-error)' }}>
            Falling
          </Text>
        </Box>
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
          {fallers.map(f => (
            <MoverRow key={`${f.platform}:${f.trader_key}`} mover={f} type="faller" />
          ))}
          {fallers.length === 0 && (
            <Text size="xs" color="tertiary">{t('noData')}</Text>
          )}
        </Box>
      </Box>
    </Box>
  )
}
