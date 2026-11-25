'use client'

import { formatScoreWhole } from '@/lib/utils/format'
import React, { useState, useRef, useEffect, useMemo, memo } from 'react'
import { createPortal } from 'react-dom'
import Image from 'next/image'
import { tokens, alpha } from '@/lib/design-tokens'
import { RankingBadge } from '../../ui/icons'
import { Box, Text } from '../../base'
import {
  getAvatarGradient,
  getAvatarInitial,
  getTraderAvatarSrc,
  isWalletAddress,
  generateBlockieSvg,
} from '@/lib/utils/avatar'
import { getScoreColorInfo, getScoreColor } from '@/lib/utils/score-colors'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import type { Trader } from '../RankingTable'
import { normalizeFiniteScore } from '../RankingTableTypes'

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
    // 认领徽章(2026-07-09 真点):不比较此字段时,客户端补上 is_verified 的
    // 新数据被 memo 判「相等」拦下,行永不重渲染 → 徽章永不出现。
    prev.trader.is_verified === next.trader.is_verified &&
    prev.rank === next.rank &&
    prev.language === next.language &&
    prev.searchQuery === next.searchQuery
  )
}

// Rank change indicator below the rank badge
function RankChangeIndicator({
  rankChange,
  isNew,
}: {
  rankChange?: number | null
  isNew?: boolean
}) {
  const indicatorStyle = {
    fontSize: tokens.typography.fontSize.xs,
    fontWeight: 700,
    lineHeight: 1,
  } as const

  if (isNew) {
    return <span style={{ ...indicatorStyle, color: tokens.colors.accent.primary }}>NEW</span>
  }

  // A corrupt movement value must not leak into the visible label or its
  // screen-reader summary as "NaN"/"Infinity". The persisted rank remains
  // useful; only the unproven movement signal is omitted.
  const finiteRankChange = rankChange != null && Number.isFinite(rankChange) ? rankChange : null

  if (finiteRankChange != null && finiteRankChange !== 0) {
    // Positive rankChange = moved up in ranking (green arrow up)
    // Negative rankChange = moved down (red arrow down)
    const isUp = finiteRankChange > 0
    const color = isUp ? tokens.colors.accent.success : TRADER_ACCENT_ERROR
    const arrow = isUp ? '\u25B2' : '\u25BC'
    const srText = isUp
      ? `Rank up ${Math.abs(finiteRankChange)}`
      : `Rank down ${Math.abs(finiteRankChange)}`
    return (
      <span
        style={{ ...indicatorStyle, color, display: 'inline-flex', alignItems: 'center', gap: 1 }}
      >
        <span className="sr-only">{srText}</span>
        <span aria-hidden="true">
          {arrow}
          {Math.abs(finiteRankChange)}
        </span>
      </span>
    )
  }

  return null
}

// Rank badge with optional rank change indicator
export function RankDisplay({
  rank,
  rankChange,
  isNew,
  glowClass,
}: {
  rank: number
  rankChange?: number | null
  isNew?: boolean
  glowClass?: string
}) {
  const isTopThree = rank <= 3

  return (
    <Box
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
      }}
    >
      {isTopThree ? (
        <Box
          className={glowClass}
          style={{ transform: 'scale(1.1)', borderRadius: '50%', display: 'inline-flex' }}
        >
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
export function TraderAvatar({
  traderId,
  displayName,
  avatarUrl,
  avatarMirrorUrl,
  rank,
  size = 36,
}: {
  traderId: string
  displayName: string
  avatarUrl?: string | null
  avatarMirrorUrl?: string | null
  rank: number
  size?: number
}) {
  // Prefer a direct-safe mirror/origin; V1 withholds sources that would need
  // the retired acquisition route and renders the existing local fallback.
  const resolvedAvatarUrl = getTraderAvatarSrc({
    avatarMirrorUrl,
    avatarOriginUrl: avatarUrl,
  })
  // For DEX wallet addresses without avatar, generate a blockie
  const blockieSrc =
    !resolvedAvatarUrl && isWalletAddress(traderId) ? generateBlockieSvg(traderId, size * 2) : null
  const medalGlow =
    rank <= 3
      ? `0 0 12px ${rank === 1 ? 'var(--color-gold-glow)' : rank === 2 ? 'var(--color-silver-glow)' : 'var(--color-bronze-glow)'}`
      : 'none'

  return (
    <div
      className="trader-avatar"
      style={{
        width: size,
        height: size,
        minWidth: size,
        minHeight: size,
        // Belt-and-braces: even if a parent flexbox squeezes the wrapper,
        // the avatar keeps its square footprint and never reflows neighbors.
        aspectRatio: '1',
        contain: 'layout',
        borderRadius: '50%',
        background: getAvatarGradient(traderId),
        border: '2px solid var(--color-border-primary)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        flexShrink: 0,
        position: 'relative',
        boxShadow: medalGlow,
      }}
    >
      <span
        style={{
          color: tokens.colors.white,
          fontSize: size * 0.4,
          fontWeight: 900,
          lineHeight: 1.2,
          textShadow: 'var(--text-shadow-heavy)',
        }}
      >
        {getAvatarInitial(displayName)}
      </span>
      {resolvedAvatarUrl ? (
        resolvedAvatarUrl.startsWith('data:') ? (
          // data: URIs (inline SVG identicons/blockies) — use plain <img> to avoid
          // next/image optimization which rejects long data: URIs with 400 errors
          <img
            src={resolvedAvatarUrl}
            alt={displayName}
            width={size}
            height={size}
            loading={rank <= 3 ? 'eager' : 'lazy'}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              position: 'absolute',
              inset: 0,
              zIndex: 1,
            }}
            onError={(e) => {
              ;(e.currentTarget as HTMLImageElement).style.display = 'none'
            }}
          />
        ) : (
          <Image
            src={resolvedAvatarUrl}
            alt={displayName}
            width={size}
            height={size}
            loading={rank <= 3 ? 'eager' : 'lazy'}
            sizes={`${size}px`}
            priority={rank <= 3}
            unoptimized
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              position: 'absolute',
              inset: 0,
              zIndex: 1,
            }}
            onError={(e) => {
              ;(e.currentTarget as HTMLImageElement).style.display = 'none'
            }}
          />
        )
      ) : blockieSrc ? (
        <img
          src={blockieSrc}
          alt={displayName}
          width={size}
          height={size}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            position: 'absolute',
            inset: 0,
            zIndex: 1,
            imageRendering: 'pixelated',
          }}
        />
      ) : null}
    </div>
  )
}

// Determine score confidence level based on available data
function getScoreConfidence(trader: Trader): 'full' | 'partial' | 'minimal' | 'unknown' {
  // Confidence is publication evidence, not a presentation heuristic. A missing
  // source value must stay unknown even when neighboring metrics happen to exist.
  return trader.score_confidence ?? 'unknown'
}

// Score confidence indicator: a small dot on the score saying the exchange did
// not provide every risk metric. Missing data is not an error, so both levels
// use the caution colour; the text says what is missing and what that means for
// the score, without quoting a penalty figure the formula no longer applies.
export function ScoreConfidenceIndicator({ trader }: { trader: Trader }) {
  const { t } = useLanguage()
  const confidence = getScoreConfidence(trader)
  if (confidence === 'full') return null

  const isUnknown = confidence === 'unknown'
  const title = isUnknown
    ? t('scoreConfidenceUnknown')
    : confidence === 'minimal'
      ? t('scoreConfidenceMinimal')
      : t('scoreConfidencePartial')
  const background = isUnknown ? tokens.colors.text.tertiary : tokens.colors.accent.warning

  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      style={{
        position: 'absolute',
        top: -2,
        right: -2,
        width: 8,
        height: 8,
        borderRadius: '50%',
        background,
        border: '1px solid var(--color-border-primary)',
        zIndex: 2,
      }}
    />
  )
}

// Get styling for arena score based on score value (exported for TraderCard)
// Uses shared score-colors utility for consistent 5-tier grading
export function getScoreStyle(score: number): {
  bgGradient: string
  borderColor: string
  textColor: string
  fillColor: string
} {
  const info = getScoreColorInfo(score)
  return {
    bgGradient: info.bgGradient,
    borderColor: info.borderColor,
    textColor: info.color,
    fillColor: info.fillColor,
  }
}

// Arena score badge
export function ArenaScoreBadge({
  score,
  showConfidence,
  trader,
}: {
  score: number | null | undefined
  showConfidence?: boolean
  trader?: Trader
}) {
  const finiteScore = normalizeFiniteScore(score)
  if (finiteScore == null) return null

  const { bgGradient, borderColor, textColor, fillColor } = getScoreStyle(finiteScore)

  const isLegendary = finiteScore >= 90
  const isElite = finiteScore >= 95

  // Static halo only: an opacity-breathing glow + sweeping shimmer on a score
  // made 90+ numbers flicker (opacity 0.9↔1) and never settle.
  const glowStyle = isElite
    ? { boxShadow: '0 0 10px var(--color-accent-primary-60)' }
    : isLegendary
      ? { boxShadow: '0 0 8px var(--color-accent-primary-40)' }
      : finiteScore >= 80
        ? { boxShadow: `0 0 6px ${alpha(tokens.colors.accent.primary, 15)}` }
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
    <Box
      style={{
        position: 'relative',
        minWidth: 48,
        height: 26,
        borderRadius: tokens.radius.md,
        background: legendaryBg,
        border: legendaryBorder,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        ...glowStyle,
      }}
    >
      <Box
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: `${Math.min(100, finiteScore)}%`,
          background: fillColor,
          transition: 'width 0.4s ease',
          borderRadius: 'inherit',
        }}
      />
      <Text
        size="sm"
        weight="black"
        style={{
          position: 'relative',
          color: textColor,
          fontSize: tokens.typography.fontSize.sm,
          lineHeight: 1,
          ...(isLegendary ? { textShadow: '0 0 8px var(--color-accent-primary-40)' } : {}),
        }}
      >
        {Number(finiteScore).toFixed(1)}
      </Text>
      {showConfidence && trader && <ScoreConfidenceIndicator trader={trader} />}
    </Box>
  )
}

/** Score ring diameter — mirrored by .ssr-score-badge in critical CSS. */
export const SCORE_RING_SIZE = 38

/**
 * Arena Score — Circular Hero Badge (Task 1 & 2)
 * Displays score as a color-coded circle with hover tooltip breakdown
 * Colors: green (70+), yellow-orange (40-69), red (<40)
 */
export const ArenaScoreCircle = memo(
  function ArenaScoreCircle({
    score,
    roi,
    pnl,
    showConfidence,
    trader,
  }: {
    score: number | null | undefined
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
    const finiteScore = normalizeFiniteScore(score)
    const finiteRoi = normalizeFiniteScore(roi)
    const finitePnl = normalizeFiniteScore(pnl)

    // Position tooltip after it renders
    useEffect(() => {
      if (!show) {
        setPositioned(false)
        return
      }
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
    const ringColor = getScoreColor(finiteScore ?? 0)

    // Hover halo only — the resting ring is a 1px tier-colored border with no
    // fill (owner decision 2026-11-13: Score is the row's single primary number;
    // a tinted disc competed with it). Must stay before any early return (rules
    // of hooks); memoized per ringColor (5 possible values).
    const hoverShadow = useMemo(
      () => `0 0 0 2px color-mix(in srgb, ${ringColor} 25%, transparent)`,
      [ringColor]
    )

    if (finiteScore == null) return null

    // v4 (2026-07): show HONEST raw inputs (ROI% / PnL $) in the tooltip. The old
    // roi/500×60 and pnl/100k×40 pseudo-scores were arbitrary V3-era client-side
    // approximations that never matched the real formula — retired with v4.
    const roiText = finiteRoi != null ? `${finiteRoi > 0 ? '+' : ''}${finiteRoi.toFixed(1)}%` : null
    const pnlText =
      finitePnl != null
        ? `${finitePnl < 0 ? '-' : ''}$${Math.abs(Math.round(finitePnl)).toLocaleString('en-US')}`
        : null
    const hasBreakdown = roiText !== null || pnlText !== null

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
        <div
          style={{
            fontWeight: 800,
            marginBottom: 4,
            color: ringColor,
            fontSize: 11,
            letterSpacing: '0.6px',
            textTransform: 'uppercase',
          }}
        >
          Arena Score
        </div>
        <div>
          {t('roi')}:{' '}
          <span
            style={{
              fontWeight: 700,
              color: tokens.colors.text.primary,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {roiText ?? '—'}
          </span>
        </div>
        <div>
          {t('pnl')}:{' '}
          <span
            style={{
              fontWeight: 700,
              color: tokens.colors.text.primary,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {pnlText ?? '—'}
          </span>
        </div>
        <div
          style={{
            borderTop: `1px solid ${tokens.colors.border.primary}`,
            marginTop: 4,
            paddingTop: 4,
            fontWeight: 800,
          }}
        >
          {t('scoreTotal')}:{' '}
          <span style={{ color: ringColor, fontVariantNumeric: 'tabular-nums' }}>
            {formatScoreWhole(Number(finiteScore))}
          </span>
          <span style={{ color: tokens.colors.text.tertiary }}> / 100</span>
        </div>
      </div>
    ) : null

    return (
      <div
        ref={ref}
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => {
          setShow(false)
          setPositioned(false)
        }}
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
          className="score-ring"
          style={{
            width: SCORE_RING_SIZE,
            height: SCORE_RING_SIZE,
            borderRadius: '50%',
            border: `1px solid ${ringColor}`,
            background: 'transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            transition: 'box-shadow 0.2s ease',
            boxShadow: show ? hoverShadow : 'none',
          }}
        >
          {showConfidence && trader && <ScoreConfidenceIndicator trader={trader} />}
          <span
            className="score-ring-value"
            style={{
              fontSize: tokens.typography.fontSize.lg,
              fontWeight: tokens.typography.fontWeight.bold,
              lineHeight: 1,
              color: tokens.colors.text.primary,
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: '-0.02em',
            }}
          >
            {formatScoreWhole(Number(finiteScore))}
          </span>
        </div>

        {/* Hover tooltip via portal (escape overflow:hidden parent) */}
        {hasBreakdown && typeof document !== 'undefined' && tooltipContent
          ? createPortal(tooltipContent, document.body)
          : null}
      </div>
    )
  },
  (prev, next) =>
    prev.score === next.score &&
    prev.roi === next.roi &&
    prev.pnl === next.pnl &&
    prev.showConfidence === next.showConfidence &&
    prev.trader?.id === next.trader?.id &&
    prev.trader?.score_confidence === next.trader?.score_confidence
)
