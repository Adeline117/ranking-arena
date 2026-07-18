'use client'

import React, { memo, useCallback, useRef, useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { Box } from '../base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import type { Trader } from './RankingTable'
import type { SourceInfo } from './utils'
import { formatDisplayName } from './utils'
import { RankDisplay, ArenaScoreCircle, areTraderPropsEqual } from './shared/TraderDisplay'
import ScoreMiniBar from './ScoreMiniBar'
import { useComparisonStore } from '@/lib/stores/comparisonStore'
import type { CompareAccountRef } from '@/lib/compare/identity'
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

const ScoreBreakdownLazy = dynamic(() => import('./ScoreBreakdown'), {
  ssr: false,
  loading: () => <div style={LAZY_LOADING_STYLE}>...</div>,
})

const ScoreBreakdownTooltip = dynamic(
  () => import('./ScoreBreakdownTooltip').then((m) => ({ default: m.ScoreBreakdownTooltip })),
  {
    loading: () => <span style={LAZY_ICON_STYLE} />,
    ssr: false,
  }
)

// ── Module-level style constants (avoid per-render allocation) ───────────────

// Score cell now stacks the circle (top) + a graded mini-bar (bottom).
const SCORE_CELL_STACK_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 3,
}
const SCORE_CELL_ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
}

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
  /** Equity-trend points for the ROI-cell sparkline (absent → numeric fallback). */
  roiSpark?: number[]
}

// ── Component ──────────────────────────────────────────────────────────────

export const TraderRow = memo(
  function TraderRow({
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
    roiSpark,
  }: TraderRowProps) {
    const { t } = useLanguage()
    const traderHandle = trader.handle || trader.id
    const href = `/trader/${encodeURIComponent(trader.id)}${trader.source ? `?platform=${encodeURIComponent(trader.source)}` : ''}`
    const displayName =
      trader.display_name || formatDisplayName(trader.handle || trader.id, trader.source || source)
    const isAddress = traderHandle.startsWith('0x') && traderHandle.length > 20
    const traderSource = trader.source || source || ''
    const sourceInfo = parseSourceInfo(traderSource)
    const compareAccount: CompareAccountRef = { id: trader.id, source: traderSource }

    // Compare checkbox state
    const isSelected = useComparisonStore(
      useCallback(
        (s) => s.isSelected({ id: trader.id, source: traderSource }),
        [trader.id, traderSource]
      )
    )
    // 桌面对比可发现性(2026-07-04 #5):桌面行此前只有移动 swipe 才能加对比,
    // 桌面用户发现不了。canAddMore 用于满 10 个时禁用未选中项。
    const canAddMore = useComparisonStore(useCallback((s) => s.canAddMore(), []))

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

    // NOTE: the old hover-prefetch was removed intentionally. It requested
    // `/api/traders/${trader.handle}` where handle is a *truncated display
    // string* (e.g. '0xf822...e01a') → guaranteed 404 on every hover, and its
    // queryKey never matched the detail page's real queries (serving mode
    // uses /core + /records with SSR initialData), so it was pure waste.

    const handleCompareToggle = (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (isSelected) {
        useComparisonStore.getState().removeTrader(compareAccount)
        return true
      }
      return useComparisonStore.getState().addTrader({
        id: trader.id,
        handle: traderHandle,
        source: traderSource,
        avatarUrl: trader.avatar_url || undefined,
      })
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
    const heroStyle =
      rank === 1
        ? HERO_STYLE_RANK_1
        : rank === 2
          ? HERO_STYLE_RANK_2
          : rank === 3
            ? HERO_STYLE_RANK_3
            : undefined

    const shareUrl = typeof window !== 'undefined' ? `${window.location.origin}${href}` : href

    return (
      <>
        <TraderRowSwipeActions
          onCompareToggle={handleCompareToggle}
          shareUrl={shareUrl}
          displayName={displayName}
        >
          {/* Keep the compare control beside the row link so the DOM never nests
              one interactive control inside another. */}
          <button
            type="button"
            className="compare-checkbox-cell row-compare-check"
            onClick={handleCompareToggle}
            aria-label={t('compare')}
            aria-pressed={isSelected}
            disabled={!isSelected && !canAddMore}
            title={t('compare')}
            style={{
              position: 'absolute',
              left: 2,
              top: '50%',
              transform: 'translateY(-50%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 24,
              height: 24,
              minWidth: 24,
              minHeight: 24,
              padding: 0,
              border: 'none',
              background: 'transparent',
              opacity: isSelected ? 1 : 0,
              transition: 'opacity 0.15s ease',
              zIndex: 3,
              cursor: 'pointer',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 15,
                height: 15,
                border: '1px solid var(--color-border-secondary)',
                borderRadius: 3,
                background: isSelected ? 'var(--color-brand-deep)' : 'var(--color-bg-primary)',
                color: 'var(--color-on-accent)',
                fontSize: 11,
                lineHeight: 1,
              }}
            >
              {isSelected ? '✓' : ''}
            </span>
          </button>
          <Link
            href={href}
            prefetch={false}
            className="ranking-row-link"
            style={{ ...LINK_BASE_STYLE, '--row-index': rank } as React.CSSProperties}
            aria-label={`#${rank} ${displayName}, ROI ${Number(trader.roi ?? 0) >= 0 ? '+' : ''}${Number(trader.roi ?? 0).toFixed(2)}%`}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === ' ') {
                e.preventDefault()
                e.currentTarget.click()
              }
            }}
          >
            <Box
              className={`ranking-row ranking-table-grid ranking-table-grid-custom touch-target${rankClass}${flashClass ? ` ${flashClass}` : ''}`}
              style={{
                ...ROW_BASE_STYLE,
                borderBottom: rank <= 3 ? undefined : '1px solid var(--color-border-primary)',
                // Row min-height is driven by CSS (.ranking-table-rows .ranking-row,
                // + density override) so the compact/comfortable toggle can win.
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

              {/* Arena Score — circle (number) + graded mini-bar (audit §4) */}
              <Box className="col-score" style={SCORE_CELL_STYLE}>
                <div style={SCORE_CELL_STACK_STYLE}>
                  <div style={SCORE_CELL_ROW_STYLE}>
                    <ArenaScoreCircle
                      score={trader.arena_score}
                      roi={trader.roi}
                      pnl={trader.pnl}
                      showConfidence
                      trader={trader}
                    />
                    <ScoreBreakdownTooltip trader={trader} language={language} />
                  </div>
                  {trader.arena_score != null && (
                    <ScoreMiniBar score={Number(trader.arena_score)} width={44} height={4} />
                  )}
                </div>
              </Box>

              {/* All metric columns */}
              <TraderMetricCells
                trader={trader}
                rank={rank}
                source={source}
                language={language}
                getPnLTooltipFn={getPnLTooltipFn}
                t={t}
                roiSpark={roiSpark}
              />
            </Box>
          </Link>

          {/* The expand control is a sibling of the row link, not a nested button. */}
          {onToggleExpand &&
            (trader.profitability_score != null ||
              trader.risk_control_score != null ||
              trader.execution_score != null) && (
              <button
                type="button"
                onClick={(e: React.MouseEvent) => {
                  e.preventDefault()
                  e.stopPropagation()
                  onToggleExpand(trader.id)
                }}
                aria-label={t('expandScoreDetails')}
                aria-expanded={isExpanded}
                style={EXPAND_BTN_STYLE}
                className="expand-btn"
                title={t('expandScoreDetails')}
              >
                <svg
                  width={10}
                  height={10}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  style={isExpanded ? CHEVRON_EXPANDED_STYLE : CHEVRON_COLLAPSED_STYLE}
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
            )}

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
  },
  (prev, next) =>
    areTraderPropsEqual(prev, next) &&
    prev.source === next.source &&
    prev.isExpanded === next.isExpanded &&
    prev.roiSpark === next.roiSpark
)
