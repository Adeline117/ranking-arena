import React, { memo } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { RankingBadge } from '../ui/icons'
import { Box, Text } from '../base'
import { getAvatarGradient, getAvatarInitial, getTraderAvatarUrl } from '@/lib/utils/avatar'
import {
  getOptimizedImageUrl,
  getImageLoadingStrategy,
  handleImageError,
  IMAGE_PLACEHOLDER,
} from '@/lib/performance/image-optimization'
import type { Trader } from './RankingTable'
import type { SourceInfo } from './utils'
import { formatROI, formatDisplayName } from './utils'
import { HighlightedName } from './RankingSearch'

// Brighter tertiary color for text on ranking card backgrounds
// where the global tertiary (#898998) does not meet WCAG AA 4.5:1 contrast
const CARD_TEXT_TERTIARY = '#b0b0be'
// Brighter error color for negative ROI/MDD on card backgrounds
// #ff4d4d only achieves 3.36:1 on card bg; #ff8080 achieves ~5.0:1
const CARD_ACCENT_ERROR = '#ff8080'

export interface TraderCardProps {
  trader: Trader
  rank: number
  source?: string
  language: string
  searchQuery?: string
  getMedalGlowClass: (rank: number) => string
  parseSourceInfo: (src: string) => SourceInfo
}

export const TraderCard = memo(function TraderCard({
  trader,
  rank,
  source,
  language,
  searchQuery = '',
  getMedalGlowClass,
  parseSourceInfo,
}: TraderCardProps) {
  const traderHandle = trader.handle || trader.id
  const href = `/trader/${encodeURIComponent(traderHandle)}`
  const displayName = formatDisplayName(traderHandle)
  const sourceInfo = parseSourceInfo(trader.source || source || '')

  return (
    <Link
      href={href}
      style={{ textDecoration: 'none', display: 'block' }}
      aria-label={`#${rank} ${displayName}, ROI ${(trader.roi || 0) >= 0 ? '+' : ''}${(trader.roi || 0).toFixed(2)}%`}
    >
      <Box
        className="ranking-row"
        style={{
          padding: tokens.spacing[4],
          background: tokens.glass.bg.light,
          border: `1px solid var(--glass-border-light)`,
          borderRadius: tokens.radius.lg,
          cursor: 'pointer',
          display: 'flex',
          flexDirection: 'column',
          gap: tokens.spacing[3],
          minHeight: 140,
        }}
      >
        {/* Top row: Rank + Avatar + Name */}
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
          {/* Rank */}
          <Box style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, minWidth: 32 }}>
            {rank <= 3 ? (
              <Box className={getMedalGlowClass(rank)} style={{ transform: 'scale(1.1)' }}>
                <RankingBadge rank={rank as 1 | 2 | 3} size={28} />
              </Box>
            ) : (
              <Text size="sm" weight="bold" color="tertiary" style={{ fontSize: '14px', color: CARD_TEXT_TERTIARY }}>
                #{rank}
              </Text>
            )}
            {trader.is_new ? (
              <span style={{ fontSize: '9px', fontWeight: 700, color: tokens.colors.accent.primary, lineHeight: 1 }}>NEW</span>
            ) : trader.rank_change != null && trader.rank_change !== 0 ? (
              <span style={{ fontSize: '9px', fontWeight: 700, color: trader.rank_change > 0 ? tokens.colors.accent.success : CARD_ACCENT_ERROR, lineHeight: 1 }}>
                {trader.rank_change > 0 ? `+${trader.rank_change}` : trader.rank_change}
              </span>
            ) : null}
          </Box>

          {/* Avatar */}
          <div
            style={{
              width: '44px', height: '44px', minWidth: '44px',
              borderRadius: '50%', background: getAvatarGradient(trader.id),
              border: '2px solid var(--color-border-primary)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              overflow: 'hidden', flexShrink: 0, position: 'relative',
              boxShadow: rank <= 3 ? `0 0 12px ${rank === 1 ? 'rgba(255, 215, 0, 0.4)' : rank === 2 ? 'rgba(192, 192, 192, 0.4)' : 'rgba(205, 127, 50, 0.4)'}` : 'none',
            }}
          >
            <span style={{ color: '#ffffff', fontSize: '16px', fontWeight: 900, lineHeight: 1, textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}>
              {getAvatarInitial(displayName)}
            </span>
            {(() => {
              const proxyAvatarUrl = getTraderAvatarUrl(trader.avatar_url)
              if (!proxyAvatarUrl) return null

              const rowIndex = rank - 1
              const loadingStrategy = getImageLoadingStrategy(rowIndex, 'above')
              const isPriority = rowIndex < 3

              return (
                <Image
                  src={getOptimizedImageUrl(proxyAvatarUrl, {
                    width: 72,
                    quality: 85,
                    format: 'webp',
                  })}
                  alt={displayName}
                  width={36}
                  height={36}
                  priority={isPriority}
                  loading={loadingStrategy.loading}
                  placeholder="blur"
                  blurDataURL={IMAGE_PLACEHOLDER.avatar}
                  style={{ width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', inset: 0, zIndex: 1 }}
                  onError={handleImageError}
                />
              )
            })()}
          </div>

          {/* Name + Source */}
          <Box style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <Text size="md" weight="bold" style={{ color: tokens.colors.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              <HighlightedName text={displayName} query={searchQuery} />
            </Text>
            <Box style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Box className="source-tag" style={{ background: `${sourceInfo.typeColor}15`, border: `1px solid ${sourceInfo.typeColor}30` }}>
                <Text size="xs" weight="bold" style={{ color: sourceInfo.typeColor, fontSize: '10px', lineHeight: 1.2 }}>
                  {sourceInfo.type}
                </Text>
              </Box>
              {trader.also_on && trader.also_on.length > 0 && (
                <Text size="xs" style={{ fontSize: '9px', color: CARD_TEXT_TERTIARY }}>
                  +{trader.also_on.length}
                </Text>
              )}
            </Box>
          </Box>

          {/* Arena Score */}
          {trader.arena_score != null && (
            <Box style={{
              minWidth: 50, height: 28, borderRadius: tokens.radius.md,
              background: trader.arena_score >= 60 ? tokens.gradient.successSubtle : trader.arena_score >= 40 ? tokens.gradient.warningSubtle : tokens.glass.bg.light,
              border: `1px solid ${trader.arena_score >= 60 ? `${tokens.colors.accent.success}50` : trader.arena_score >= 40 ? `${tokens.colors.accent.warning}40` : 'rgba(255, 255, 255, 0.15)'}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Text size="sm" weight="black" style={{ color: trader.arena_score >= 60 ? tokens.colors.accent.success : trader.arena_score >= 40 ? tokens.colors.accent.warning : CARD_TEXT_TERTIARY, fontSize: '13px' }}>
                {trader.arena_score.toFixed(0)}
              </Text>
            </Box>
          )}
        </Box>

        {/* Stats row */}
        <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: tokens.spacing[2] }}>
          {/* ROI */}
          <Box style={{ textAlign: 'center', padding: `${tokens.spacing[2]} 0`, background: tokens.glass.bg.light, borderRadius: tokens.radius.md }}>
            <Text size="xs" color="tertiary" style={{ marginBottom: 2, display: 'block', color: CARD_TEXT_TERTIARY }}>ROI</Text>
            <Text size="md" weight="black" style={{ color: (trader.roi || 0) >= 0 ? tokens.colors.accent.success : CARD_ACCENT_ERROR }}>
              {formatROI(trader.roi || 0)}
            </Text>
          </Box>

          {/* Win Rate */}
          <Box style={{ textAlign: 'center', padding: `${tokens.spacing[2]} 0`, background: tokens.glass.bg.light, borderRadius: tokens.radius.md }}>
            <Text size="xs" color="tertiary" style={{ marginBottom: 2, display: 'block', color: CARD_TEXT_TERTIARY }}>{language === 'zh' ? '胜率' : 'Win%'}</Text>
            <Text size="md" weight="semibold" style={{ color: trader.win_rate != null && trader.win_rate > 50 ? tokens.colors.accent.success : CARD_TEXT_TERTIARY }}>
              {trader.win_rate != null ? `${trader.win_rate.toFixed(0)}%` : '—'}
            </Text>
          </Box>

          {/* Max Drawdown */}
          <Box style={{ textAlign: 'center', padding: `${tokens.spacing[2]} 0`, background: tokens.glass.bg.light, borderRadius: tokens.radius.md }}>
            <Text size="xs" color="tertiary" style={{ marginBottom: 2, display: 'block', color: CARD_TEXT_TERTIARY }}>MDD</Text>
            <Text size="md" weight="semibold" style={{ color: trader.max_drawdown != null ? CARD_ACCENT_ERROR : CARD_TEXT_TERTIARY }}>
              {trader.max_drawdown != null ? `-${Math.abs(trader.max_drawdown).toFixed(0)}%` : '—'}
            </Text>
          </Box>
        </Box>
      </Box>
    </Link>
  )
}, (prev, next) => {
  return (
    prev.trader.id === next.trader.id &&
    prev.trader.roi === next.trader.roi &&
    prev.trader.arena_score === next.trader.arena_score &&
    prev.trader.win_rate === next.trader.win_rate &&
    prev.trader.max_drawdown === next.trader.max_drawdown &&
    prev.trader.rank_change === next.trader.rank_change &&
    prev.trader.is_new === next.trader.is_new &&
    prev.rank === next.rank &&
    prev.language === next.language &&
    prev.searchQuery === next.searchQuery
  )
})
