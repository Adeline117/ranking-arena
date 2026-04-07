'use client'

import React, { useState, useRef, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { RankingBadge } from '../../ui/icons'
import { Box, Text } from '../../base'
import { getAvatarGradient, getAvatarInitial, getTraderAvatarUrl, isWalletAddress, generateBlockieSvg } from '@/lib/utils/avatar'
import { getScoreColorInfo, getScoreColor } from '@/lib/utils/score-colors'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
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
        <Box className={glowClass} style={{ transform: 'scale(1.1)', borderRadius: '50%', display: 'inline-flex' }}>
          <RankingBadge rank={rank as 1 | 2 | 3} size={28} />
        </Box>
      ) : (
        <Text size="sm" weight="bold" style={{ fontSize: '14px', color: TRADER_TEXT_TERTIARY }}>
          {rank}
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
  // For DEX wallet addresses without avatar, generate a blockie
  const blockieSrc = !proxyAvatarUrl && isWalletAddress(traderId) ? generateBlockieSvg(traderId, size * 2) : null
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
      {proxyAvatarUrl ? (
        <Image
          src={proxyAvatarUrl}
          alt={displayName}
          width={size}
          height={size}
          loading={rank <= 3 ? 'eager' : 'lazy'}
          sizes={`${size}px`}
          priority={rank <= 3}
          unoptimized={!proxyAvatarUrl.startsWith('/api/avatar')}
          style={{ width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', inset: 0, zIndex: 1 }}
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
        />
      ) : blockieSrc ? (
        <img
          src={blockieSrc}
          alt={displayName}
          width={size}
          height={size}
          style={{ width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', inset: 0, zIndex: 1, imageRendering: 'pixelated' }}
        />
      ) : null}
    </div>
  )
}

// Determine score confidence level based on available data
function getScoreConfidence(trader: Trader): 'full' | 'partial' | 'minimal' {
  if (trader.score_confidence) return trader.score_confidence
  // Use != null instead of falsy check — win_rate=0 and max_drawdown=0 are valid data
  if (trader.win_rate == null && trader.max_drawdown == null) return 'minimal'
  if (trader.win_rate == null || trader.max_drawdown == null) return 'partial'
  return 'full'
}

// Score confidence indicator
export function ScoreConfidenceIndicator({ trader }: { trader: Trader }) {
  const confidence = getScoreConfidence(trader)
  if (confidence === 'full') return null

  const isMinimal = confidence === 'minimal'
  const title = isMinimal
    ? 'Limited data: win rate & drawdown unavailable (score -20%)'
    : 'Partial data: some metrics unavailable (score -8%)'
  const background = isMinimal
    ? (tokens.colors.accent.error)
    : tokens.colors.accent.warning

  return (
    <span
      title={title}
      style={{
        position: 'absolute', top: -2, right: -2,
        width: 8, height: 8, borderRadius: '50%',
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
    ? 'linear-gradient(135deg, var(--color-accent-primary-20), var(--color-accent-primary-20), var(--color-pro-gold-bg))'
    : isLegendary
      ? 'linear-gradient(135deg, var(--color-accent-primary-20), var(--color-accent-primary-15))'
      : bgGradient

  const legendaryBorder = isLegendary
    ? `1px solid var(--color-accent-primary-60)`
    : `1px solid ${borderColor}`

  return (
    <Box style={{
      position: 'relative', minWidth: 48, height: 26, borderRadius: tokens.radius.md,
      background: legendaryBg,
      border: legendaryBorder,
      display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
      ...glowStyle,
    }}>
      {/* Shimmer overlay for 90+ */}
      {isLegendary && (
        <Box style={{
          position: 'absolute', inset: 0,
          background: 'linear-gradient(90deg, transparent 0%, var(--glass-bg-medium) 40%, var(--glass-border-heavy) 50%, var(--glass-bg-medium) 60%, transparent 100%)',
          backgroundSize: '200% 100%',
          animation: 'score-shimmer 3s ease-in-out infinite',
          borderRadius: 'inherit',
          pointerEvents: 'none',
        }} />
      )}
      <Box style={{
        position: 'absolute', left: 0, top: 0, bottom: 0,
        width: `${Math.min(100, score)}%`,
        background: fillColor,
        transition: 'width 0.4s ease',
        borderRadius: 'inherit',
      }} />
      <Text size="sm" weight="black" style={{
        position: 'relative',
        color: textColor,
        fontSize: tokens.typography.fontSize.sm, lineHeight: 1,
        ...(isLegendary ? { textShadow: '0 0 8px var(--color-accent-primary-40)' } : {}),
      }}>
        {Number(score).toFixed(1)}
      </Text>
      {showConfidence && trader && <ScoreConfidenceIndicator trader={trader} />}
    </Box>
  )
}

// Metric stat display (for card view)
export function MetricStat({ label, value, color, nullTooltip }: {
  label: string
  value: React.ReactNode
  color?: string
  nullTooltip?: string
}) {
  const isNull = value == null || value === '—'
  return (
    <Box
      style={{
        textAlign: 'center',
        padding: `${tokens.spacing[2]} 0`,
        background: tokens.glass.bg.light,
        borderRadius: tokens.radius.md,
        cursor: isNull && nullTooltip ? 'help' : undefined,
      }}
      title={isNull && nullTooltip ? nullTooltip : undefined}
    >
      <Text size="xs" style={{ marginBottom: 2, display: 'block', color: TRADER_TEXT_TERTIARY }}>
        {label}
      </Text>
      <Text size="md" weight="semibold" style={{ color: isNull ? TRADER_TEXT_TERTIARY : (color || TRADER_TEXT_TERTIARY), fontVariantNumeric: 'tabular-nums', opacity: isNull ? 0.4 : 1 }}>
        {isNull ? '—' : value}
      </Text>
    </Box>
  )
}

/**
 * Arena Score — Circular Hero Badge (Task 1 & 2)
 * Displays score as a color-coded circle with hover tooltip breakdown
 * Colors: green (70+), yellow-orange (40-69), red (<40)
 */
export function ArenaScoreCircle({
  score,
  roi,
  pnl,
  showConfidence,
  trader,
}: {
  score: number | undefined
  roi?: number | null
  pnl?: number | null
  showConfidence?: boolean
  trader?: Trader
}) {
  const [show, setShow] = useState(false)
  const [positioned, setPositioned] = useState(false)
  const [tooltipPos, setTooltipPos] = useState({ top: 0, left: 0 })
  const ref = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const { t } = useLanguage()

  // Position tooltip after it renders
  useEffect(() => {
    if (!show) { setPositioned(false); return }
    if (!ref.current || !tooltipRef.current) return
    const triggerRect = ref.current.getBoundingClientRect()
    const tooltipRect = tooltipRef.current.getBoundingClientRect()

    // Prefer right of badge, fall back to left if near viewport edge
    let left = triggerRect.right + 10
    if (left + tooltipRect.width > window.innerWidth - 8) {
      left = triggerRect.left - tooltipRect.width - 10
    }
    left = Math.max(8, left)

    // Center vertically on badge
    let top = triggerRect.top + triggerRect.height / 2 - tooltipRect.height / 2
    top = Math.max(8, Math.min(top, window.innerHeight - tooltipRect.height - 8))

    setTooltipPos({ top, left })
    setPositioned(true)
  }, [show])

  // 5-tier color system (matches score-colors.ts standard):
  // 90+: legendary (purple), 70-89: great (green), 50-69: average (amber),
  // 30-49: below (orange), 0-29: low (gray-red)
  const ringColor = getScoreColor(score ?? 0)

  // Pre-compute color-mix() expressions — must be before any early return (rules of hooks).
  // Without this, 50 rows × 2 color-mix string templates per row = 100 allocations per render.
  // Memoized per ringColor (only 5 possible values), so nearly always returns cached object.
  const colorMix = useMemo(() => ({
    bg: `color-mix(in srgb, ${ringColor} 10%, transparent)`,
    shadow: `0 0 6px color-mix(in srgb, ${ringColor} 12%, transparent)`,
    shadowHover: `0 0 0 2px color-mix(in srgb, ${ringColor} 25%, transparent), 0 4px 14px color-mix(in srgb, ${ringColor} 20%, transparent)`,
  }), [ringColor])

  if (score == null) return null

  // Score breakdown calculated from raw roi% and pnl USD
  const roiScore = roi != null
    ? Math.min(60, Math.max(0, Math.round((roi / 500) * 60)))
    : null
  const pnlScore = pnl != null
    ? Math.min(40, Math.max(0, Math.round((pnl / 100000) * 40)))
    : null
  const hasBreakdown = roiScore !== null || pnlScore !== null

  const tooltipContent = show ? (
    <div
      ref={tooltipRef}
      style={{
        position: 'fixed',
        top: tooltipPos.top,
        left: tooltipPos.left,
        visibility: positioned ? 'visible' : 'hidden',
        padding: '8px 12px',
        background: tokens.colors.bg.primary,
        border: `1px solid ${tokens.colors.border.primary}`,
        borderRadius: tokens.radius.md,
        boxShadow: tokens.shadow.lg,
        zIndex: tokens.zIndex.tooltip,
        whiteSpace: 'nowrap',
        fontSize: tokens.typography.fontSize.xs,
        lineHeight: 1.9,
        color: tokens.colors.text.secondary,
        pointerEvents: 'none',
        minWidth: 148,
      }}
    >
      <div style={{ fontWeight: 800, marginBottom: 4, color: ringColor, fontSize: 11, letterSpacing: '0.6px', textTransform: 'uppercase' }}>
        Arena Score
      </div>
      <div>
        {t('scoreRoiScore')}:{' '}
        <span style={{ fontWeight: 700, color: tokens.colors.text.primary, fontVariantNumeric: 'tabular-nums' }}>{roiScore ?? '—'}</span>
        <span style={{ color: tokens.colors.text.tertiary }}>{' '}/ 60</span>
      </div>
      <div>
        {t('scorePnlScore')}:{' '}
        <span style={{ fontWeight: 700, color: tokens.colors.text.primary, fontVariantNumeric: 'tabular-nums' }}>{pnlScore ?? '—'}</span>
        <span style={{ color: tokens.colors.text.tertiary }}>{' '}/ 40</span>
      </div>
      <div style={{
        borderTop: `1px solid ${tokens.colors.border.primary}`,
        marginTop: 4,
        paddingTop: 4,
        fontWeight: 800,
      }}>
        {t('scoreTotal')}:{' '}
        <span style={{ color: ringColor, fontVariantNumeric: 'tabular-nums' }}>{Number(score).toFixed(0)}</span>
        <span style={{ color: tokens.colors.text.tertiary }}>{' '}/ 100</span>
      </div>
    </div>
  ) : null

  return (
    <div
      ref={ref}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => { setShow(false); setPositioned(false) }}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        cursor: hasBreakdown ? 'help' : 'default',
      }}
    >
      {/* Circular badge */}
      <div
        style={{
          width: 38,
          height: 38,
          borderRadius: '50%',
          border: `2.5px solid ${ringColor}`,
          background: colorMix.bg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          transition: 'box-shadow 0.2s ease, transform 0.2s ease',
          boxShadow: show ? colorMix.shadowHover : colorMix.shadow,
          transform: show ? 'scale(1.08)' : 'scale(1)',
        }}
      >
        {showConfidence && trader && <ScoreConfidenceIndicator trader={trader} />}
        <span style={{
          fontSize: 13,
          fontWeight: 900,
          lineHeight: 1,
          color: ringColor,
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: '-0.5px',
        }}>
          {Number(score).toFixed(0)}
        </span>
      </div>

      {/* Hover tooltip via portal (escape overflow:hidden parent) */}
      {hasBreakdown && typeof document !== 'undefined' && tooltipContent
        ? createPortal(tooltipContent, document.body)
        : null}
    </div>
  )
}
