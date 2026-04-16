'use client'

import React, { memo, useCallback, useRef, useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import type { Trader } from './RankingTable'
import type { SourceInfo } from './utils'
import { formatDisplayName } from './utils'
import {
  RankDisplay,
  ArenaScoreCircle,
  areTraderPropsEqual,
} from './shared/TraderDisplay'
import { useComparisonStore } from '@/lib/stores/comparisonStore'
import { classifyStyle, getStyleInfo, type TradingStyle } from '@/lib/utils/trading-style'

// Sub-components
import { TraderInfoCell } from './TraderInfoCell'
import { TraderMetricCells } from './TraderMetricCells'
import { TraderRowSwipeActions } from './TraderRowSwipeActions'

// Styles
import {
  HERO_STYLE_RANK_1,
  HERO_STYLE_RANK_2,
  HERO_STYLE_RANK_3,
  LAZY_LOADING_STYLE,
  LAZY_ICON_STYLE,
  ROW_BASE_STYLE,
  SCORE_CELL_STYLE,
  EXPAND_BTN_STYLE,
  CHEVRON_EXPANDED_STYLE,
  CHEVRON_COLLAPSED_STYLE,
  LINK_BASE_STYLE,
} from './TraderRowStyles'

// ── Lazy-loaded panels ─────────────────────────────────────────────────────

const ScoreBreakdownLazy = dynamic(
  () => import('./ScoreBreakdown'),
  { ssr: false, loading: () => <div style={LAZY_LOADING_STYLE}>...</div> }
)

const ScoreBreakdownTooltip = dynamic(
  () => import('./ScoreBreakdownTooltip').then(m => ({ default: m.ScoreBreakdownTooltip })),
  {
    loading: () => <span style={LAZY_ICON_STYLE} />,
    ssr: false,
  }
)

// ── Props ──────────────────────────────────────────────────────────────────

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

// ── Component ──────────────────────────────────────────────────────────────

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
  const displayName = trader.display_name || formatDisplayName(trader.handle || trader.id, trader.source || source)
  const isAddress = traderHandle.startsWith('0x') && traderHandle.length > 20
  const sourceInfo = parseSourceInfo(trader.source || source || '')

  // Compare checkbox state
  const isSelected = useComparisonStore(useCallback(s => s.isSelected(trader.id), [trader.id]))

  // Memoize trading style classification
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

  // Prefetch trader detail on hover with debounce
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current) }, [])
  const handleMouseEnter = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = setTimeout(async () => {
      try {
        const detailUrl = `/api/traders/${encodeURIComponent(traderHandle)}`
        const [{ mutate: swrMutate }, { fetcher: swrFetcher }] = await Promise.all([
          import('swr'),
          import('@/lib/hooks/useSWR'),
        ])
        swrMutate(detailUrl, swrFetcher<{ success: boolean; data: unknown }>(detailUrl).then(r => r && typeof r === 'object' && 'data' in r ? r.data : r), { revalidate: false })
      } catch { /* prefetch is best-effort */ }
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
    if (prevRoi != null && trader.roi != null && prevRoi !== trader.roi) {
      setFlashClass(trader.roi > prevRoi ? 'flash-green' : 'flash-red')
      const timer = setTimeout(() => setFlashClass(''), 1000)
      return () => clearTimeout(timer)
    }
    if (prevRank !== rank && prevRank !== 0) {
      setFlashClass(rank < prevRank ? 'flash-green' : 'flash-red')
      const timer = setTimeout(() => setFlashClass(''), 1000)
      return () => clearTimeout(timer)
    }
  }, [trader.roi, rank])

  const rankClass = rank <= 3 ? ` rank-${rank}` : ''
  const heroStyle = rank === 1 ? HERO_STYLE_RANK_1
    : rank === 2 ? HERO_STYLE_RANK_2
    : rank === 3 ? HERO_STYLE_RANK_3
    : undefined

  const shareUrl = typeof window !== 'undefined' ? `${window.location.origin}${href}` : href

  return (
    <>
    <TraderRowSwipeActions
      onCompareToggle={handleCompareToggle}
      shareUrl={shareUrl}
      displayName={displayName}
    >
    <Link
      href={href}
      prefetch={false}
      className="ranking-row-link"
      style={{ ...LINK_BASE_STYLE, '--row-index': rank } as React.CSSProperties}
      aria-label={`#${rank} ${displayName}, ROI ${Number(trader.roi ?? 0) >= 0 ? '+' : ''}${Number(trader.roi ?? 0).toFixed(2)}%`}
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === ' ') { e.preventDefault(); e.currentTarget.click() } }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <Box
        className={`ranking-row ranking-table-grid ranking-table-grid-custom touch-target${rankClass}${flashClass ? ` ${flashClass}` : ''}`}
        style={{
          ...ROW_BASE_STYLE,
          borderBottom: rank <= 3 ? undefined : '1px solid var(--glass-border-light)',
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
        <TraderInfoCell
          trader={trader}
          rank={rank}
          displayName={displayName}
          isAddress={isAddress}
          traderHandle={traderHandle}
          sourceInfo={sourceInfo}
          searchQuery={searchQuery}
          language={language}
          tradingStyleInfo={tradingStyleInfo}
        />

        {/* Arena Score */}
        <Box className="col-score" style={SCORE_CELL_STYLE}>
          <ArenaScoreCircle
            score={trader.arena_score}
            roi={trader.roi}
            pnl={trader.pnl}
            showConfidence
            trader={trader}
          />
          <ScoreBreakdownTooltip trader={trader} language={language} />
        </Box>

        {/* All metric columns */}
        <TraderMetricCells
          trader={trader}
          rank={rank}
          source={source}
          language={language}
          getPnLTooltipFn={getPnLTooltipFn}
          t={t}
        />
      </Box>

      {/* Expand button overlay */}
      {onToggleExpand && (trader.profitability_score != null || trader.risk_control_score != null || trader.execution_score != null) && (
        <Box
          onClick={(e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); onToggleExpand(trader.id) }}
          role="button"
          aria-label="Toggle score breakdown"
          aria-expanded={isExpanded}
          style={EXPAND_BTN_STYLE}
          className="expand-btn"
          title={t('expandScoreDetails')}
        >
          <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
            aria-hidden="true"
            style={isExpanded ? CHEVRON_EXPANDED_STYLE : CHEVRON_COLLAPSED_STYLE}>
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
    </TraderRowSwipeActions>
    </>
  )
}, (prev, next) => areTraderPropsEqual(prev, next) && prev.source === next.source && prev.isExpanded === next.isExpanded)
