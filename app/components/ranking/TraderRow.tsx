'use client'

import { localizedLabel } from '@/lib/utils/format'
import React, { memo, useCallback, useRef, useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useCountUp } from '@/lib/hooks/useCountUp'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import { getPlatformNote } from '@/lib/constants/platform-metrics'
import { t as i18nT } from '@/lib/i18n'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import type { Trader } from './RankingTable'
import type { SourceInfo } from './utils'
import { formatPnL, formatROI, formatDisplayName } from './utils'
import { HighlightedName } from './RankingSearch'
import {
  TRADER_TEXT_TERTIARY,
  TRADER_ACCENT_ERROR,
  RankDisplay,
  TraderAvatar,
  ArenaScoreCircle,
  areTraderPropsEqual,
} from './shared/TraderDisplay'
import { getScoreColor } from '@/lib/utils/score-colors'
import { CopyButton } from './HeroSection'
import { useComparisonStore } from '@/lib/stores'
import { classifyStyle, getStyleInfo, type TradingStyle } from '@/lib/utils/trading-style'
import { t as i18nTFn } from '@/lib/i18n'

const SWIPE_THRESHOLD = 50
const ACTION_WIDTH = 140

// Module-level style constants — avoid allocating new objects on every render (defeats React.memo)
const HERO_STYLE_RANK_1: React.CSSProperties = {
  background: 'linear-gradient(135deg, rgba(255,215,0,0.13) 0%, rgba(255,215,0,0.04) 40%, transparent 80%)',
  boxShadow: 'inset 3px 0 0 var(--color-rank-gold), 0 2px 20px rgba(255,215,0,0.08)',
  borderRadius: 10,
  margin: '3px 4px',
}
const HERO_STYLE_RANK_2: React.CSSProperties = {
  background: 'linear-gradient(135deg, rgba(192,192,192,0.10) 0%, rgba(192,192,192,0.03) 40%, transparent 80%)',
  boxShadow: 'inset 3px 0 0 var(--color-rank-silver), 0 2px 16px rgba(192,192,192,0.06)',
  borderRadius: 10,
  margin: '3px 4px',
}
const HERO_STYLE_RANK_3: React.CSSProperties = {
  background: 'linear-gradient(135deg, rgba(205,127,50,0.10) 0%, rgba(205,127,50,0.03) 40%, transparent 80%)',
  boxShadow: 'inset 3px 0 0 var(--color-rank-bronze), 0 2px 16px rgba(205,127,50,0.06)',
  borderRadius: 10,
  margin: '3px 4px',
}

const ScoreBreakdownLazy = dynamic(
  () => import('./ScoreBreakdown'),
  { ssr: false, loading: () => <div style={{ padding: 16, textAlign: 'center', opacity: 0.5 }}>...</div> }
)

const ScoreBreakdownTooltip = dynamic(
  () => import('./ScoreBreakdownTooltip').then(m => ({ default: m.ScoreBreakdownTooltip })),
  {
    loading: () => <span style={{ width: 14, height: 14, display: 'inline-block' }} />,
    ssr: false,
  }
)

// Reusable N/A indicator for missing data with platform-specific tooltip
function NaIndicator({ source, metricType }: { source?: string; metricType: 'winRate' | 'drawdown' }) {
  // Get platform-specific note or use default
  const platformNote = source ? getPlatformNote(source) : undefined
  const defaultNote = metricType === 'winRate' 
    ? i18nT('winRateNotAvailable') 
    : i18nT('drawdownNotAvailable')
  
  return (
    <span
      title={platformNote || defaultNote}
      style={{ 
        fontSize: tokens.typography.fontSize.xs, 
        color: TRADER_TEXT_TERTIARY, 
        opacity: 0.4, 
        letterSpacing: 1,
        cursor: 'help',
      }}
    >
      &mdash;
    </span>
  )
}

// ROI display — animated count-up only for top 3 hero rows to avoid 100x concurrent rAF loops
function AnimatedROI({ roi, roiColor, animate }: { roi: number; roiColor: string; animate?: boolean }) {
  const animatedValue = useCountUp(animate ? roi : roi, animate ? 500 : 0)
  const displayValue = animate ? animatedValue : roi
  return (
    <Text
      size="md"
      weight="black"
      className="roi-value"
      style={{ color: roiColor, lineHeight: 1.2, fontSize: '16px', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', fontVariantNumeric: 'tabular-nums', fontFeatureSettings: '"tnum" 1' }}
      title={`${roi >= 0 ? '+' : ''}${Number(roi).toFixed(2)}%`}
    >
      {formatROI(displayValue)}
    </Text>
  )
}

export interface TraderRowProps {
  trader: Trader
  rank: number
  source?: string
  language: string
  searchQuery?: string
  getMedalGlowClass: (rank: number) => string
  parseSourceInfo: (src: string) => SourceInfo
  getPnLTooltipFn: (source: string, lang: string) => string
  isExpanded?: boolean
  onToggleExpand?: (id: string) => void
}

export const TraderRow = memo(function TraderRow({
  trader,
  rank,
  source,
  language,
  searchQuery = '',
  getMedalGlowClass,
  parseSourceInfo,
  getPnLTooltipFn,
  isExpanded,
  onToggleExpand,
}: TraderRowProps) {
  const { t } = useLanguage()
  const traderHandle = trader.handle || trader.id
  const href = `/trader/${encodeURIComponent(trader.id)}${trader.source ? `?platform=${encodeURIComponent(trader.source)}` : ""}`
  // Show original platform ID as primary display name
  // Prefer handle (original exchange nickname) over id
  const displayName = trader.display_name || formatDisplayName(trader.handle || trader.id, trader.source || source)
  const isAddress = traderHandle.startsWith('0x') && traderHandle.length > 20
  const sourceInfo = parseSourceInfo(trader.source || source || '')

  // Compare checkbox state — use individual selectors to avoid new object on every getSnapshot call
  // (returning an object from a Zustand selector causes useSyncExternalStore infinite loop)
  const isSelected = useComparisonStore(useCallback(s => s.isSelected(trader.id), [trader.id]))
  const _canAddMore = useComparisonStore(useCallback(s => s.selectedTraders.length < 5, []))

  // Memoize trading style classification to avoid recomputing on every render
  const tradingStyleInfo = useMemo(() => {
    if (trader.trading_style && trader.trading_style !== 'unknown') {
      return getStyleInfo(trader.trading_style as TradingStyle)
    }
    const computed = classifyStyle({
      avg_holding_hours: trader.avg_holding_hours,
      trades_count: trader.trades_count,
      win_rate: trader.win_rate,
    })
    return computed !== 'unknown' ? getStyleInfo(computed) : null
  }, [trader.trading_style, trader.avg_holding_hours, trader.trades_count, trader.win_rate])

  // Prefetch trader detail on hover with 300ms debounce to prevent
  // firing 20-50 requests during rapid scroll over rows
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current) }, [])
  const handleMouseEnter = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = setTimeout(async () => {
      const detailUrl = `/api/traders/${encodeURIComponent(traderHandle)}`
      const [{ mutate: swrMutate }, { fetcher: swrFetcher }] = await Promise.all([
        import('swr'),
        import('@/lib/hooks/useSWR'),
      ])
      swrMutate(detailUrl, swrFetcher<{ success: boolean; data: unknown }>(detailUrl).then(r => r && typeof r === 'object' && 'data' in r ? r.data : r), { revalidate: false })
    }, 100)
  }, [traderHandle])
  const handleMouseLeave = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
  }, [])

  const handleCompareToggle = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (isSelected) {
      useComparisonStore.getState().removeTrader(trader.id)
    } else {
      useComparisonStore.getState().addTrader({
        id: trader.id,
        handle: traderHandle,
        source: trader.source || source || '',
        avatarUrl: trader.avatar_url || undefined,
      })
    }
  }

  // Flash animation when ROI or rank changes
  const prevRoiRef = useRef(trader.roi)
  const prevRankRef = useRef(rank)
  const [flashClass, setFlashClass] = useState('')
  useEffect(() => {
    const prevRoi = prevRoiRef.current
    const prevRank = prevRankRef.current
    prevRoiRef.current = trader.roi
    prevRankRef.current = rank
    // Compare ROI changes
    if (prevRoi != null && trader.roi != null && prevRoi !== trader.roi) {
      setFlashClass(trader.roi > prevRoi ? 'flash-green' : 'flash-red')
      const timer = setTimeout(() => setFlashClass(''), 1000)
      return () => clearTimeout(timer)
    }
    // Compare rank changes
    if (prevRank !== rank && prevRank !== 0) {
      setFlashClass(rank < prevRank ? 'flash-green' : 'flash-red')
      const timer = setTimeout(() => setFlashClass(''), 1000)
      return () => clearTimeout(timer)
    }
  }, [trader.roi, rank])

  // Rank class for CSS art direction (top 3 heroes)
  const rankClass = rank <= 3 ? ` rank-${rank}` : ''

  // Top 3 inline styles — use module-level constants to avoid object allocation per render
  const heroStyle = rank === 1 ? HERO_STYLE_RANK_1
    : rank === 2 ? HERO_STYLE_RANK_2
    : rank === 3 ? HERO_STYLE_RANK_3
    : undefined

  // Swipe state (mobile only)
  const swipeRef = useRef<{ startX: number; startY: number; swiping: boolean }>({ startX: 0, startY: 0, swiping: false })
  const contentRef = useRef<HTMLDivElement>(null)
  const [swipeOpen, setSwipeOpen] = useState(false)

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]
    swipeRef.current = { startX: touch.clientX, startY: touch.clientY, swiping: false }
  }, [])

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]
    const dx = touch.clientX - swipeRef.current.startX
    const dy = touch.clientY - swipeRef.current.startY
    if (!swipeRef.current.swiping && Math.abs(dy) > Math.abs(dx)) return
    if (Math.abs(dx) > 10) swipeRef.current.swiping = true
    if (!swipeRef.current.swiping) return
    e.preventDefault()
    const el = contentRef.current
    if (!el) return
    const offset = swipeOpen ? -ACTION_WIDTH + dx : dx
    const clamped = Math.max(-ACTION_WIDTH, Math.min(0, offset))
    el.style.transform = `translateX(${clamped}px)`
    el.style.transition = 'none'
  }, [swipeOpen])

  const handleTouchEnd = useCallback(() => {
    if (!swipeRef.current.swiping) return
    const el = contentRef.current
    if (!el) return
    el.style.transition = ''
    const matrix = getComputedStyle(el).transform
    const tx = matrix !== 'none' ? parseFloat(matrix.split(',')[4]) : 0
    if (tx < -SWIPE_THRESHOLD) {
      el.style.transform = `translateX(-${ACTION_WIDTH}px)`
      setSwipeOpen(true)
    } else {
      el.style.transform = 'translateX(0)'
      setSwipeOpen(false)
    }
  }, [])

  const closeSwipe = useCallback(() => {
    const el = contentRef.current
    if (el) {
      el.style.transition = ''
      el.style.transform = 'translateX(0)'
    }
    setSwipeOpen(false)
  }, [])

  const handleShare = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    closeSwipe()
    if (typeof navigator !== 'undefined' && navigator.share) {
      void navigator.share({ title: displayName, url: `${window.location.origin}${href}` }).catch(() => {}) // eslint-disable-line no-restricted-syntax -- fire-and-forget
    } else if (typeof navigator !== 'undefined') {
      navigator.clipboard.writeText(`${window.location.origin}${href}`).catch(() => {
        console.warn('[TraderRow] clipboard.writeText failed')
      })
    }
  }, [displayName, href, closeSwipe])

  return (
    <>
    <div
      className="swipe-row-wrapper"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <div className="swipe-row-actions">
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); closeSwipe(); handleCompareToggle(e) }}
          style={{ background: tokens.colors.accent.primary }}
          title={i18nTFn('compare')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>
          <span>{i18nTFn('compare')}</span>
        </button>
        <button
          onClick={handleShare}
          style={{ background: tokens.colors.accent.brand }}
          title={i18nTFn('share')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
          <span>{i18nTFn('share')}</span>
        </button>
      </div>

      <div ref={contentRef} className="swipe-row-content">
    <Link
      href={href}
      prefetch={false}
      className="ranking-row-link"
      style={{ textDecoration: 'none', display: 'block', '--row-index': rank } as React.CSSProperties}
      aria-label={`#${rank} ${displayName}, ROI ${Number(trader.roi ?? 0) >= 0 ? '+' : ''}${Number(trader.roi ?? 0).toFixed(2)}%`}
      tabIndex={0}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <Box
        className={`ranking-row ranking-table-grid ranking-table-grid-custom touch-target${rankClass}${flashClass ? ` ${flashClass}` : ''}`}
        style={{
          display: 'grid',
          alignItems: 'center',
          gap: tokens.spacing[3],
          padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
          borderBottom: rank <= 3 ? undefined : '1px solid var(--glass-border-light)',
          cursor: 'pointer',
          position: 'relative',
          minHeight: rank <= 3 ? 64 : 54,
          ...heroStyle,
        }}
      >
        {/* Rank */}
        <RankDisplay
          rank={rank}
          rankChange={trader.rank_change}
          isNew={trader.is_new}
          glowClass={getMedalGlowClass(rank)}
        />

        {/* Trader Info */}
        <Box style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'nowrap', minWidth: 0 }}>
          <TraderAvatar
            traderId={trader.id}
            displayName={displayName}
            avatarUrl={trader.avatar_url}
            rank={rank}
            size={rank <= 3 ? 42 : 36}
          />
          <Box style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: 1 }}>
            <Box style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Text size="sm" weight="bold" style={{ color: tokens.colors.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: rank <= 3 ? '15px' : '14px', letterSpacing: rank <= 3 ? '-0.01em' : undefined }}>
                <HighlightedName text={displayName} query={searchQuery} />
              </Text>
              {isAddress && <CopyButton text={traderHandle} />}
              {/* Mobile Score Badge */}
              {trader.arena_score != null && (
                <span className="mobile-score-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
                  <span style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: getScoreColor(trader.arena_score),
                  }} />
                  <span style={{ fontSize: tokens.typography.fontSize.xs, fontWeight: 700, color: TRADER_TEXT_TERTIARY }}>{Number(trader.arena_score).toFixed(0)}</span>
                </span>
              )}
            </Box>
            <Box style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <Box className="source-tag" style={{ background: `${sourceInfo.typeColor}15`, border: `1px solid ${sourceInfo.typeColor}30` }}>
                <Text size="xs" weight="bold" style={{ color: sourceInfo.typeColor, fontSize: tokens.typography.fontSize.xs, lineHeight: 1.2 }}>
                  {sourceInfo.type}
                </Text>
              </Box>
              {/* Verified Badge */}
              {trader.is_verified && (
                <span
                  title={i18nT('verifiedTooltip')}
                  style={{
                    padding: '1px 6px',
                    borderRadius: tokens.radius.md,
                    fontSize: 12,
                    fontWeight: 600,
                    color: '#22d3ee',
                    background: 'rgba(34, 211, 238, 0.12)',
                    border: '1px solid rgba(34, 211, 238, 0.25)',
                    lineHeight: 1.4,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 3,
                  }}>
                  <svg width="10" height="10" viewBox="0 0 20 20" fill="currentColor"><path d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"/></svg>
                  {i18nT('verifiedBadge')}
                </span>
              )}
              {/* Bot Badge */}
              {(trader.is_bot || trader.trader_type === 'bot') && (
                <span style={{
                  padding: '1px 6px',
                  borderRadius: tokens.radius.md,
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#a78bfa',
                  background: 'rgba(167, 139, 250, 0.12)',
                  border: '1px solid rgba(167, 139, 250, 0.25)',
                  lineHeight: 1.4,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 3,
                }}>
                  <span style={{ fontSize: 10 }}>{'⚡'}</span>
                  {i18nT('botLabel')}
                </span>
              )}
              {/* Trading Style Chip */}
              {tradingStyleInfo && (
                <span style={{
                  padding: '1px 6px',
                  borderRadius: tokens.radius.md,
                  fontSize: 12,
                  fontWeight: 600,
                  color: tradingStyleInfo.color,
                  background: tradingStyleInfo.bgColor,
                  border: `1px solid ${tradingStyleInfo.borderColor}`,
                  lineHeight: 1.4,
                }}>
                  {localizedLabel(tradingStyleInfo.label, tradingStyleInfo.labelEn, language)}
                </span>
              )}
              {trader.also_on && trader.also_on.length > 0 && (
                <Text size="xs" style={{ fontSize: tokens.typography.fontSize.xs, color: TRADER_TEXT_TERTIARY, lineHeight: 1.2 }}>
                  also on: {[...new Set(trader.also_on.map(s => EXCHANGE_NAMES[s] || s.split('_')[0]))].join(', ')}
                </Text>
              )}
            </Box>
          </Box>
        </Box>

        {/* Arena Score — circular hero badge with hover breakdown tooltip */}
        <Box className="col-score" style={{ textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
          <ArenaScoreCircle
            score={trader.arena_score}
            roi={trader.roi}
            pnl={trader.pnl}
            showConfidence
            trader={trader}
          />
          <ScoreBreakdownTooltip trader={trader} language={language} />
        </Box>

        {/* ROI */}
        {(() => {
          const roi = trader.roi ?? 0
          const roiColor = roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error
          return (
            <Box className="roi-cell" style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
              <AnimatedROI roi={roi} roiColor={roiColor} animate={rank <= 3} />
            </Box>
          )
        })()}

        {/* PnL */}
        {(() => {
          const pnl = trader.pnl
          const hasPnl = pnl != null
          const pnlColor = hasPnl
            ? (pnl >= 0 ? tokens.colors.accent.success : TRADER_ACCENT_ERROR)
            : TRADER_TEXT_TERTIARY
          const pnlText = hasPnl ? formatPnL(pnl) : '—'
          return (
            <Box className="col-pnl" style={{ textAlign: 'right', display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
              <Text
                size="sm"
                weight="semibold"
                className="pnl-value"
                style={{ color: pnlColor, lineHeight: 1.2, fontSize: tokens.typography.fontSize.sm, opacity: hasPnl ? 0.85 : 0.5, cursor: hasPnl ? 'help' : 'default', fontVariantNumeric: 'tabular-nums' }}
                title={hasPnl ? getPnLTooltipFn(trader.source || source || '', language) : undefined}
              >
                {pnlText}
              </Text>
            </Box>
          )
        })()}

        {/* Win% */}
        <Box className="col-winrate" style={{ textAlign: 'right', alignItems: 'center', justifyContent: 'flex-end' }}>
          {trader.win_rate != null ? (
            <Text size="sm" weight="semibold" style={{ color: trader.win_rate > 50 ? tokens.colors.accent.success : TRADER_TEXT_TERTIARY, lineHeight: 1.2, fontSize: tokens.typography.fontSize.sm, fontVariantNumeric: 'tabular-nums', opacity: trader.metrics_estimated ? 0.5 : 1 }} title={trader.metrics_estimated ? t('estimatedFromRoi') : undefined}>
              {trader.metrics_estimated ? '~' : ''}{Number(trader.win_rate).toFixed(1)}%
            </Text>
          ) : (
            <NaIndicator source={trader.source || source} metricType="winRate" />
          )}
        </Box>

        {/* MDD */}
        <Box className="col-mdd" style={{ textAlign: 'right', alignItems: 'center', justifyContent: 'flex-end' }}>
          {trader.max_drawdown != null ? (
            <Text size="sm" weight="semibold" style={{ color: TRADER_ACCENT_ERROR, lineHeight: 1.2, fontSize: tokens.typography.fontSize.sm, fontVariantNumeric: 'tabular-nums', opacity: trader.metrics_estimated ? 0.5 : 1 }} title={trader.metrics_estimated ? t('estimatedFromRoi') : undefined}>
              {trader.metrics_estimated ? '~' : ''}{Math.abs(Number(trader.max_drawdown)) < 0.05 ? '< 0.1' : `-${Math.abs(Number(trader.max_drawdown)).toFixed(1)}`}%
            </Text>
          ) : (
            <NaIndicator source={trader.source || source} metricType="drawdown" />
          )}
        </Box>

        {/* Sharpe Ratio (P1-3) */}
        <Box className="col-sharpe" style={{ textAlign: 'right', alignItems: 'center', justifyContent: 'flex-end' }}>
          {trader.sharpe_ratio != null ? (
            <Text size="sm" weight="semibold" style={{ color: trader.sharpe_ratio >= 1 ? tokens.colors.accent.success : TRADER_TEXT_TERTIARY, lineHeight: 1.2, fontSize: tokens.typography.fontSize.sm, fontVariantNumeric: 'tabular-nums' }}>
              {Number(trader.sharpe_ratio).toFixed(2)}
            </Text>
          ) : (
            <span style={{ fontSize: tokens.typography.fontSize.xs, color: TRADER_TEXT_TERTIARY, opacity: 0.4 }}>&mdash;</span>
          )}
        </Box>

        {/* Followers (P1-2) */}
        <Box className="col-followers" style={{ textAlign: 'right', alignItems: 'center', justifyContent: 'flex-end' }}>
          {trader.followers > 0 ? (
            <Text size="sm" weight="semibold" style={{ color: TRADER_TEXT_TERTIARY, lineHeight: 1.2, fontSize: tokens.typography.fontSize.sm, fontVariantNumeric: 'tabular-nums' }}>
              {Number(trader.followers) >= 1000 ? `${(Number(trader.followers) / 1000).toFixed(1)}K` : trader.followers}
            </Text>
          ) : (
            <span style={{ fontSize: tokens.typography.fontSize.xs, color: TRADER_TEXT_TERTIARY, opacity: 0.4 }}>&mdash;</span>
          )}
        </Box>

        {/* Trades Count (P1-4) */}
        <Box className="col-trades" style={{ textAlign: 'right', alignItems: 'center', justifyContent: 'flex-end' }}>
          {trader.trades_count != null && trader.trades_count > 0 ? (
            <Text size="sm" weight="semibold" style={{ color: TRADER_TEXT_TERTIARY, lineHeight: 1.2, fontSize: tokens.typography.fontSize.sm, fontVariantNumeric: 'tabular-nums' }}>
              {Number(trader.trades_count) >= 1000 ? `${(Number(trader.trades_count) / 1000).toFixed(1)}K` : trader.trades_count}
            </Text>
          ) : (
            <span style={{ fontSize: tokens.typography.fontSize.xs, color: TRADER_TEXT_TERTIARY, opacity: 0.4 }}>&mdash;</span>
          )}
        </Box>
      </Box>

      {/* Expand button overlay */}
      {onToggleExpand && (trader.profitability_score != null || trader.risk_control_score != null || trader.execution_score != null) && (
        <Box
          onClick={(e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); onToggleExpand(trader.id) }}
          style={{
            position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)',
            width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', opacity: 0.6, transition: 'opacity 0.15s',
            borderRadius: tokens.radius.sm,
          }}
          className="expand-btn"
          title={t('expandScoreDetails')}
        >
          <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
            style={{ transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>
            <path d="M6 9l6 6 6-6" />
          </svg>
        </Box>
      )}
    </Link>

    {/* Expanded Score Breakdown */}
    {isExpanded && (
      <ScoreBreakdownLazy
        profitability_score={trader.profitability_score}
        risk_control_score={trader.risk_control_score}
        execution_score={trader.execution_score}
        score_completeness={trader.score_completeness}
        max_drawdown={trader.max_drawdown}
        win_rate={trader.win_rate}
        roi={trader.roi}
        arena_score={trader.arena_score}
      />
    )}
      </div>{/* end swipe-row-content */}
    </div>{/* end swipe-row-wrapper */}
    </>
  )
}, (prev, next) => areTraderPropsEqual(prev, next) && prev.source === next.source && prev.isExpanded === next.isExpanded)
