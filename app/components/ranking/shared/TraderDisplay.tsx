'use client'

import React from 'react'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { RankingBadge } from '../../ui/icons'
import { Box, Text } from '../../base'
import { getAvatarGradient, getAvatarInitial, getTraderAvatarUrl } from '@/lib/utils/avatar'
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
  const indicatorStyle = { fontSize: '9px', fontWeight: 700, lineHeight: 1 } as const

  if (isNew) {
    return <span style={{ ...indicatorStyle, color: tokens.colors.accent.primary }}>NEW</span>
  }

  if (rankChange != null && rankChange !== 0) {
    // Positive rankChange = moved up in ranking (green arrow up)
    // Negative rankChange = moved down (red arrow down)
    const isUp = rankChange > 0
    const color = isUp ? tokens.colors.accent.success : TRADER_ACCENT_ERROR
    const arrow = isUp ? '\u25B2' : '\u25BC'
    return (
      <span style={{ ...indicatorStyle, color, display: 'inline-flex', alignItems: 'center', gap: 1 }}>
        {arrow}{Math.abs(rankChange)}
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
        color: tokens.colors.white,
        fontSize: size * 0.4,
        fontWeight: 900,
        lineHeight: 1,
        textShadow: '0 1px 3px rgba(0,0,0,0.8)'
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
          priority={rank <= 3}
          unoptimized
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
        border: '1px solid rgba(0,0,0,0.3)',
        zIndex: 2,
      }}
    />
  )
}

// Get styling for arena score based on score value (exported for TraderCard)
// Tiers: 0-40 gray, 40-60 blue, 60-80 purple, 80+ gold
export function getScoreStyle(score: number): { bgGradient: string; borderColor: string; textColor: string; fillColor: string } {
  if (score >= 80) {
    return {
      bgGradient: 'linear-gradient(135deg, rgba(255,215,0,0.15), rgba(255,165,0,0.1))',
      borderColor: 'rgba(255,215,0,0.5)',
      textColor: tokens.colors.medal.gold,
      fillColor: 'rgba(255,215,0,0.15)',
    }
  }
  if (score >= 60) {
    return {
      bgGradient: 'linear-gradient(135deg, rgba(139,92,246,0.15), rgba(168,85,247,0.1))',
      borderColor: 'rgba(139,92,246,0.5)',
      textColor: tokens.colors.verified.web3,
      fillColor: 'rgba(139,92,246,0.15)',
    }
  }
  if (score >= 40) {
    return {
      bgGradient: 'linear-gradient(135deg, rgba(59,130,246,0.15), rgba(96,165,250,0.1))',
      borderColor: 'rgba(59,130,246,0.4)',
      textColor: tokens.colors.accent.brand,
      fillColor: 'rgba(59,130,246,0.15)',
    }
  }
  return {
    bgGradient: tokens.glass.bg.light,
    borderColor: 'rgba(255, 255, 255, 0.15)',
    textColor: TRADER_TEXT_TERTIARY,
    fillColor: `${tokens.colors.accent.primary}15`,
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
        background: fillColor,
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
