'use client'

import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { RankingBadge } from '../../ui/icons'
import { Box, Text } from '../../base'
import { getAvatarGradient, getAvatarInitial, getTraderAvatarUrl } from '@/lib/utils/avatar'
import type { Trader } from '../RankingTable'

// Shared color constants for trader display components
// These ensure WCAG AA 4.5:1 contrast on card/row backgrounds
export const TRADER_TEXT_TERTIARY = '#b0b0be'
export const TRADER_ACCENT_ERROR = '#ff8080'

// Shared memo comparison for trader components
export function areTraderPropsEqual(
  prev: { trader: Trader; rank: number; language: string; searchQuery?: string },
  next: { trader: Trader; rank: number; language: string; searchQuery?: string }
): boolean {
  return (
    prev.trader.id === next.trader.id &&
    prev.trader.roi === next.trader.roi &&
    prev.trader.arena_score === next.trader.arena_score &&
    prev.trader.pnl === next.trader.pnl &&
    prev.trader.win_rate === next.trader.win_rate &&
    prev.trader.max_drawdown === next.trader.max_drawdown &&
    prev.trader.score_confidence === next.trader.score_confidence &&
    prev.trader.rank_change === next.trader.rank_change &&
    prev.trader.is_new === next.trader.is_new &&
    prev.rank === next.rank &&
    prev.language === next.language &&
    prev.searchQuery === next.searchQuery
  )
}

// Rank badge with optional rank change indicator
export function RankDisplay({ rank, rankChange, isNew, glowClass }: {
  rank: number
  rankChange?: number | null
  isNew?: boolean
  glowClass?: string
}) {
  return (
    <Box style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
      {rank <= 3 ? (
        <Box className={glowClass} style={{ transform: 'scale(1.1)' }}>
          <RankingBadge rank={rank as 1 | 2 | 3} size={28} />
        </Box>
      ) : (
        <Text size="sm" weight="bold" style={{ fontSize: '14px', color: TRADER_TEXT_TERTIARY }}>
          #{rank}
        </Text>
      )}
      {isNew ? (
        <span style={{ fontSize: '9px', fontWeight: 700, color: tokens.colors.accent.primary, lineHeight: 1 }}>NEW</span>
      ) : rankChange != null && rankChange !== 0 ? (
        <span style={{ fontSize: '9px', fontWeight: 700, color: rankChange > 0 ? tokens.colors.accent.success : TRADER_ACCENT_ERROR, lineHeight: 1 }}>
          {rankChange > 0 ? `+${rankChange}` : rankChange}
        </span>
      ) : null}
    </Box>
  )
}

// Avatar component with fallback
export function TraderAvatar({ traderId, displayName, avatarUrl, rank, size = 36 }: {
  traderId: string
  displayName: string
  avatarUrl?: string | null
  rank: number
  size?: number
}) {
  const proxyAvatarUrl = getTraderAvatarUrl(avatarUrl)
  const medalGlow = rank <= 3
    ? `0 0 12px ${rank === 1 ? 'rgba(255, 215, 0, 0.4)' : rank === 2 ? 'rgba(192, 192, 192, 0.4)' : 'rgba(205, 127, 50, 0.4)'}`
    : 'none'

  return (
    <div
      className="trader-avatar"
      style={{
        width: size, height: size, minWidth: size, minHeight: size,
        borderRadius: '50%', background: getAvatarGradient(traderId),
        border: '2px solid var(--color-border-primary)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        overflow: 'hidden', flexShrink: 0, position: 'relative',
        boxShadow: medalGlow,
      }}
    >
      <span style={{
        color: '#ffffff',
        fontSize: size * 0.4,
        fontWeight: 900,
        lineHeight: 1,
        textShadow: '0 1px 3px rgba(0,0,0,0.8)'
      }}>
        {getAvatarInitial(displayName)}
      </span>
      {proxyAvatarUrl && (
        <img
          src={proxyAvatarUrl}
          alt={displayName}
          width={size}
          height={size}
          loading={rank <= 3 ? 'eager' : 'lazy'}
          decoding="async"
          style={{ width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', inset: 0, zIndex: 1 }}
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
        />
      )}
    </div>
  )
}

// Score confidence indicator
export function ScoreConfidenceIndicator({ trader }: { trader: Trader }) {
  const conf = trader.score_confidence ?? (
    (!trader.win_rate) && (!trader.max_drawdown) ? 'minimal' :
    (!trader.win_rate) || (!trader.max_drawdown) ? 'partial' : 'full'
  )
  if (conf === 'full') return null

  return (
    <span
      title={conf === 'minimal' ? 'Incomplete data (-20%)' : 'Partial data (-8%)'}
      style={{
        position: 'absolute', top: -2, right: -2,
        width: 6, height: 6, borderRadius: '50%',
        background: conf === 'minimal' ? tokens.colors.accent.error ?? '#ff6b6b' : tokens.colors.accent.warning,
        border: '1px solid rgba(0,0,0,0.3)',
        zIndex: 2,
      }}
    />
  )
}

// Arena score badge
export function ArenaScoreBadge({ score, showConfidence, trader }: {
  score: number | undefined
  showConfidence?: boolean
  trader?: Trader
}) {
  if (score == null) return null

  const bgGradient = score >= 60 ? tokens.gradient.successSubtle : score >= 40 ? tokens.gradient.warningSubtle : tokens.glass.bg.light
  const borderColor = score >= 60 ? `${tokens.colors.accent.success}50` : score >= 40 ? `${tokens.colors.accent.warning}40` : 'rgba(255, 255, 255, 0.15)'
  const textColor = score >= 60 ? tokens.colors.accent.success : score >= 40 ? tokens.colors.accent.warning : TRADER_TEXT_TERTIARY

  return (
    <Box style={{
      position: 'relative', minWidth: 46, height: 24, borderRadius: tokens.radius.md,
      background: bgGradient,
      border: `1px solid ${borderColor}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
    }}>
      <Box style={{
        position: 'absolute', left: 0, top: 0, bottom: 0,
        width: `${score}%`,
        background: score >= 60 ? `${tokens.colors.accent.success}20` : score >= 40 ? `${tokens.colors.accent.warning}20` : `${tokens.colors.accent.primary}15`,
        transition: 'width 0.3s ease'
      }} />
      <Text size="sm" weight="black" style={{
        position: 'relative',
        color: textColor,
        fontSize: '12px', lineHeight: 1
      }}>
        {score.toFixed(1)}
      </Text>
      {showConfidence && trader && <ScoreConfidenceIndicator trader={trader} />}
    </Box>
  )
}

// Metric stat display (for card view)
export function MetricStat({ label, value, color }: {
  label: string
  value: React.ReactNode
  color?: string
}) {
  return (
    <Box style={{
      textAlign: 'center',
      padding: `${tokens.spacing[2]} 0`,
      background: tokens.glass.bg.light,
      borderRadius: tokens.radius.md
    }}>
      <Text size="xs" style={{ marginBottom: 2, display: 'block', color: TRADER_TEXT_TERTIARY }}>
        {label}
      </Text>
      <Text size="md" weight="semibold" style={{ color: color || TRADER_TEXT_TERTIARY }}>
        {value}
      </Text>
    </Box>
  )
}
