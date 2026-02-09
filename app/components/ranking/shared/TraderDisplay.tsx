'use client'

import React from 'react'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { RankingBadge } from '../../ui/icons'
import { Box, Text } from '../../base'
import { getAvatarGradient, getAvatarInitial, getTraderAvatarUrl } from '@/lib/utils/avatar'
import { getScoreColorInfo } from '@/lib/utils/score-colors'
import type { Trader } from '../RankingTable'

// Shared color constants for trader display components
// These ensure WCAG AA 4.5:1 contrast on card/row backgrounds
export const TRADER_TEXT_TERTIARY = tokens.colors.text.tertiary
export const TRADER_ACCENT_ERROR = tokens.colors.accent.error

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

// Rank change indicator below the rank badge
function RankChangeIndicator({ rankChange, isNew }: { rankChange?: number | null; isNew?: boolean }) {
  const indicatorStyle = { fontSize: tokens.typography.fontSize.xs, fontWeight: 700, lineHeight: 1 } as const

  if (isNew) {
    return <span style={{ ...indicatorStyle, color: tokens.colors.accent.primary }}>NEW</span>
  }

  if (rankChange != null && rankChange !== 0) {
    // Positive rankChange = moved up in ranking (green arrow up)
    // Negative rankChange = moved down (red arrow down)
    const isUp = rankChange > 0
    const color = isUp ? tokens.colors.accent.success : TRADER_ACCENT_ERROR
    const arrow = isUp ? '\u25B2' : '\u25BC'
    const srText = isUp ? `Rank up ${Math.abs(rankChange)}` : `Rank down ${Math.abs(rankChange)}`
    return (
      <span style={{ ...indicatorStyle, color, display: 'inline-flex', alignItems: 'center', gap: 1 }}>
        <span className="sr-only">{srText}</span>
        <span aria-hidden="true">{arrow}{Math.abs(rankChange)}</span>
      </span>
    )
  }

  return null
}

// Rank badge with optional rank change indicator
export function RankDisplay({ rank, rankChange, isNew, glowClass }: {
  rank: number
  rankChange?: number | null
  isNew?: boolean
  glowClass?: string
}) {
  const isTopThree = rank <= 3

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
      {isTopThree ? (
        <Box className={glowClass} style={{ transform: 'scale(1.1)' }}>
          <RankingBadge rank={rank as 1 | 2 | 3} size={28} />
        </Box>
      ) : (
        <Text size="sm" weight="bold" style={{ fontSize: '14px', color: TRADER_TEXT_TERTIARY }}>
          #{rank}
        </Text>
      )}
      <RankChangeIndicator rankChange={rankChange} isNew={isNew} />
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
    ? `0 0 12px ${rank === 1 ? 'var(--color-gold-glow)' : rank === 2 ? 'var(--color-silver-glow)' : 'var(--color-bronze-glow)'}`
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
        color: tokens.colors.white,
        fontSize: size * 0.4,
        fontWeight: 900,
        lineHeight: 1.2,
        textShadow: 'var(--text-shadow-heavy)'
      }}>
        {getAvatarInitial(displayName)}
      </span>
      {proxyAvatarUrl && (
        <Image
          src={proxyAvatarUrl}
          alt={displayName}
          width={size}
          height={size}
          loading={rank <= 3 ? 'eager' : 'lazy'}
          sizes={`${size}px`}
          priority={rank <= 3}
          style={{ width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', inset: 0, zIndex: 1 }}
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
        />
      )}
    </div>
  )
}

// Determine score confidence level based on available data
function getScoreConfidence(trader: Trader): 'full' | 'partial' | 'minimal' {
  if (trader.score_confidence) return trader.score_confidence
  if (!trader.win_rate && !trader.max_drawdown) return 'minimal'
  if (!trader.win_rate || !trader.max_drawdown) return 'partial'
  return 'full'
}

// Score confidence indicator
export function ScoreConfidenceIndicator({ trader }: { trader: Trader }) {
  const confidence = getScoreConfidence(trader)
  if (confidence === 'full') return null

  const isMinimal = confidence === 'minimal'
  const title = isMinimal ? 'Incomplete data (-20%)' : 'Partial data (-8%)'
  const background = isMinimal
    ? (tokens.colors.accent.error)
    : tokens.colors.accent.warning

  return (
    <span
      title={title}
      style={{
        position: 'absolute', top: -2, right: -2,
        width: 6, height: 6, borderRadius: '50%',
        background,
        border: '1px solid var(--color-border-primary)',
        zIndex: 2,
      }}
    />
  )
}

// Get styling for arena score based on score value (exported for TraderCard)
// Uses shared score-colors utility for consistent 5-tier grading
export function getScoreStyle(score: number): { bgGradient: string; borderColor: string; textColor: string; fillColor: string } {
  const info = getScoreColorInfo(score)
  return {
    bgGradient: info.bgGradient,
    borderColor: info.borderColor,
    textColor: info.color,
    fillColor: info.fillColor,
  }
}

// Arena score badge
export function ArenaScoreBadge({ score, showConfidence, trader }: {
  score: number | undefined
  showConfidence?: boolean
  trader?: Trader
}) {
  if (score == null) return null

  const { bgGradient, borderColor, textColor, fillColor } = getScoreStyle(score)

  const isLegendary = score >= 90
  const isElite = score >= 95

  const glowStyle = isElite
    ? { animation: 'score-legendary-glow-intense 2.5s ease-in-out infinite' }
    : isLegendary
      ? { animation: 'score-legendary-glow 3s ease-in-out infinite' }
      : score >= 80
        ? { boxShadow: `0 0 6px ${tokens.colors.accent.primary}25` }
        : {}

  const legendaryBg = isElite
    ? 'linear-gradient(135deg, rgba(139,92,246,0.22), rgba(168,85,247,0.18), rgba(212,175,55,0.12))'
    : isLegendary
      ? 'linear-gradient(135deg, rgba(139,92,246,0.20), rgba(168,85,247,0.15))'
      : bgGradient

  const legendaryBorder = isLegendary
    ? `1px solid rgba(139,92,246,0.65)`
    : `1px solid ${borderColor}`

  return (
    <Box style={{
      position: 'relative', minWidth: 46, height: 24, borderRadius: tokens.radius.md,
      background: legendaryBg,
      border: legendaryBorder,
      display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
      ...glowStyle,
    }}>
      {/* Shimmer overlay for 90+ */}
      {isLegendary && (
        <Box style={{
          position: 'absolute', inset: 0,
          background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.12) 40%, rgba(255,255,255,0.25) 50%, rgba(255,255,255,0.12) 60%, transparent 100%)',
          backgroundSize: '200% 100%',
          animation: 'score-shimmer 3s ease-in-out infinite',
          borderRadius: 'inherit',
          pointerEvents: 'none',
        }} />
      )}
      <Box style={{
        position: 'absolute', left: 0, top: 0, bottom: 0,
        width: `${score}%`,
        background: fillColor,
        transition: 'width 0.3s ease'
      }} />
      <Text size="sm" weight="black" style={{
        position: 'relative',
        color: textColor,
        fontSize: tokens.typography.fontSize.sm, lineHeight: 1,
        ...(isLegendary ? { textShadow: '0 0 8px rgba(139,92,246,0.4)' } : {}),
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
