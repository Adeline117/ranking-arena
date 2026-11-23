'use client'

/**
 * Mobile ranking (<768px): compact ~56px table rows instead of ~240px cards.
 *
 * Owner decision 2026-11-13. One row = rank, avatar + name (+ source tag),
 * Arena Score (primary, 18px) and ONE user-chosen secondary metric
 * (ROI / PnL / Win% / MDD, default ROI). Geometry lives in a single CSS block
 * (`.mrow*` in lib/performance/critical-css.ts) shared with the SSR shell
 * (SSRRankingTable carries the same classes), so hydration cannot jump.
 *
 * The secondary metric is chosen by CSS, not by React: every row renders all
 * four values and `html[data-rank-metric]` decides which one is visible. That
 * keeps the server HTML, the pre-paint inline script and the client tree on
 * one source of truth with no hydration mismatch.
 */

import React, { memo, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { isAllTime90dSource } from '@/lib/utils/all-time-90d'
import { useRankingPeriod } from './RankingPeriodContext'
import { AllTime90dBadge } from './AllTime90dBadge'
import Metric from '../ui/Metric'
import { HighlightedName } from './HighlightedName'
import { TraderAvatar, ScoreConfidenceIndicator, areTraderPropsEqual } from './shared/TraderDisplay'
import { TraderRowSwipeActions } from './TraderRowSwipeActions'
import { formatDisplayName } from './utils'
import type { SourceInfo } from './utils'
import type { Trader } from './RankingTable'
import { normalizeFiniteScore, type SortColumn, type SortDir } from './RankingTableTypes'
import { getScoreColor } from '@/lib/utils/score-colors'
import { formatDrawdown, NULL_DISPLAY } from '@/lib/utils/format'
import { useComparisonStore } from '@/lib/stores/comparisonStore'
import type { CompareAccountRef } from '@/lib/compare/identity'
import {
  MOBILE_METRICS,
  type MobileMetric,
  LS_KEY_MOBILE_METRIC,
  isMobileMetric,
  readStoredMobileMetric,
  applyMobileMetric,
} from './mobile-metric'

// ── Secondary-metric preference (shared constants live in mobile-metric.ts) ──

const METRIC_LABEL_KEYS: Record<MobileMetric, string> = {
  roi: 'roi',
  pnl: 'pnl',
  win: 'winRatePercent',
  mdd: 'mdd',
}

const SORT_LABEL_KEYS: Record<SortColumn, string> = {
  score: 'score',
  roi: 'roi',
  pnl: 'pnl',
  winrate: 'winRatePercent',
  mdd: 'mdd',
  sortino: 'sortino',
}
const MOBILE_SORT_COLUMNS: readonly SortColumn[] = ['score', 'roi', 'pnl', 'winrate', 'mdd']

function sortOptionLabel(t: (key: string) => string, col: SortColumn, dir: SortDir): string {
  return `${t(SORT_LABEL_KEYS[col])} ${dir === 'desc' ? '↓' : '↑'}`
}

// ── Header (sort picker + column labels + metric picker) ─────────────────────

export interface MobileRankHeaderProps {
  sortColumn?: SortColumn
  sortDir?: SortDir
  /** Server-side re-sort. Without it the header shows a static "Trader" label. */
  onSortChange?: (column: SortColumn, dir: SortDir) => void
}

export function MobileRankHeader({
  sortColumn = 'score',
  sortDir = 'desc',
  onSortChange,
}: MobileRankHeaderProps = {}) {
  const { t } = useLanguage()
  const [metric, setMetric] = useState<MobileMetric>('roi')

  useEffect(() => {
    const stored = readStoredMobileMetric()
    setMetric(stored)
    applyMobileMetric(stored)
  }, [])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value
    if (!isMobileMetric(next)) return
    setMetric(next)
    applyMobileMetric(next)
    try {
      localStorage.setItem(LS_KEY_MOBILE_METRIC, next)
    } catch {
      /* non-fatal: the choice still applies for this session */
    }
  }, [])

  const sortColumns = MOBILE_SORT_COLUMNS.includes(sortColumn)
    ? MOBILE_SORT_COLUMNS
    : [...MOBILE_SORT_COLUMNS, sortColumn]

  const handleSortSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const [col, dir] = e.target.value.split(':') as [SortColumn, SortDir]
    if (!SORT_LABEL_KEYS[col] || (dir !== 'asc' && dir !== 'desc')) return
    onSortChange?.(col, dir)
  }

  return (
    <div className="mrow-head" data-testid="mobile-rank-header">
      <span>#</span>
      {onSortChange ? (
        <span className="mrow-head-sort">
          {/* Same transparent-native-select pattern as the metric picker. */}
          <span className="mrow-head-metric-label" aria-hidden="true">
            {sortOptionLabel(t, sortColumn, sortDir)}
            <svg width={8} height={8} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M4 8h16l-8 10z" />
            </svg>
          </span>
          <select
            className="mrow-head-select"
            aria-label={t('rankingMobileSortLabel')}
            value={`${sortColumn}:${sortDir}`}
            onChange={handleSortSelect}
            data-testid="mobile-rank-sort-select"
          >
            {sortColumns.flatMap((col) =>
              (['desc', 'asc'] as const).map((dir) => (
                <option key={`${col}:${dir}`} value={`${col}:${dir}`}>
                  {sortOptionLabel(t, col, dir)}
                </option>
              ))
            )}
          </select>
        </span>
      ) : (
        <span>{t('trader')}</span>
      )}
      <span className="mrow-head-score">{t('score')}</span>
      <span className="mrow-head-metric">
        {/* Visible label follows html[data-rank-metric] like the rows do; the
            transparent native <select> on top is the actual control (16px so
            iOS does not zoom on focus; native picker = accessible on touch). */}
        <span className="mrow-head-metric-label" aria-hidden="true">
          {MOBILE_METRICS.map((m) => (
            <span key={m} className={`mrow-m mrow-m-${m}`}>
              {t(METRIC_LABEL_KEYS[m])}
            </span>
          ))}
          <svg width={8} height={8} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M4 8h16l-8 10z" />
          </svg>
        </span>
        <select
          className="mrow-head-select"
          aria-label={t('rankingMobileMetricLabel')}
          value={metric}
          onChange={handleChange}
          data-testid="mobile-rank-metric-select"
        >
          {MOBILE_METRICS.map((m) => (
            <option key={m} value={m}>
              {t(METRIC_LABEL_KEYS[m])}
            </option>
          ))}
        </select>
      </span>
    </div>
  )
}

// ── Row ──────────────────────────────────────────────────────────────────────

export interface TraderMobileRowProps {
  trader: Trader
  rank: number
  source?: string
  language: string
  searchQuery?: string
  parseSourceInfo: (src: string) => SourceInfo
}

export const TraderMobileRow = memo(
  function TraderMobileRow({
    trader,
    rank,
    source,
    searchQuery = '',
    parseSourceInfo,
  }: TraderMobileRowProps) {
    const { t } = useLanguage()
    const rankingPeriod = useRankingPeriod()
    const traderHandle = trader.handle || trader.id
    const traderSource = trader.source || source || ''
    const href = `/trader/${encodeURIComponent(trader.id)}${trader.source ? `?platform=${encodeURIComponent(trader.source)}` : ''}`
    const displayName =
      trader.display_name || formatDisplayName(traderHandle, trader.source || source)
    const sourceInfo = parseSourceInfo(traderSource)
    const compareAccount: CompareAccountRef = { id: trader.id, source: traderSource }

    // Idle-window rows were not scored: no score, and the label says why.
    const isIdleWindow = trader.idle_window === true
    const score = isIdleWindow ? null : normalizeFiniteScore(trader.arena_score)
    const roi = normalizeFiniteScore(trader.roi)
    const pnl = normalizeFiniteScore(trader.pnl)
    const winRate = normalizeFiniteScore(trader.win_rate)
    const parsedDrawdown = trader.max_drawdown == null ? null : Number(trader.max_drawdown)
    const drawdownDisplay = formatDrawdown(parsedDrawdown)
    const estimatedPrefix = trader.metrics_estimated ? '~' : ''

    const isSelected = useComparisonStore(
      useCallback(
        (s) => s.isSelected({ id: trader.id, source: traderSource }),
        [trader.id, traderSource]
      )
    )

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

    const shareUrl = typeof window !== 'undefined' ? `${window.location.origin}${href}` : href
    const roiAria =
      roi != null
        ? t('roiValueAria').replace('{value}', `${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%`)
        : t('roiUnknown')
    const scoreAria = isIdleWindow
      ? t('noTradingThisPeriod')
      : score != null
        ? t('arenaScoreAria').replace('{score}', score.toFixed(0))
        : t('arenaScoreUnknownAria')

    return (
      <TraderRowSwipeActions
        onCompareToggle={handleCompareToggle}
        shareUrl={shareUrl}
        displayName={displayName}
      >
        <Link
          href={href}
          prefetch={false}
          className={`mrow${rank <= 3 ? ` mrow-top mrow-top-${rank}` : ''}${isSelected ? ' mrow-selected' : ''}`}
          aria-label={`#${rank} ${displayName}, ${scoreAria}, ${roiAria}`}
          data-rank={rank}
        >
          <span className="mrow-rank">{rank}</span>

          <span className="mrow-trader">
            <TraderAvatar
              traderId={trader.id}
              displayName={displayName}
              avatarUrl={trader.avatar_url}
              avatarMirrorUrl={trader.avatar_url_mirror}
              rank={rank}
              size={32}
            />
            <span className="mrow-copy">
              <span className="mrow-name">
                <HighlightedName text={displayName} query={searchQuery} />
              </span>
              <span className="mrow-tag">
                {sourceInfo.type}
                {isIdleWindow && (
                  <span className="rank-idle-window" data-testid="idle-window-label">
                    {' · '}
                    {t('noTradingThisPeriod')}
                  </span>
                )}
                {rankingPeriod === '90D' && isAllTime90dSource(traderSource) && (
                  <>
                    {' '}
                    <AllTime90dBadge />
                  </>
                )}
              </span>
            </span>
          </span>

          <span className="mrow-score-cell" aria-hidden="true">
            {score != null ? (
              <span
                className="mrow-score"
                style={{ '--mrow-score-ring': getScoreColor(score) } as React.CSSProperties}
              >
                {score.toFixed(0)}
                <ScoreConfidenceIndicator trader={trader} />
              </span>
            ) : (
              <span className="mrow-score mrow-score-empty">{NULL_DISPLAY}</span>
            )}
          </span>

          {/* Secondary metric — all four rendered, html[data-rank-metric] shows one. */}
          <span className="mrow-m mrow-m-roi">
            <Metric value={roi} format="roi" size="md" showArrow as="span" />
          </span>
          <span className="mrow-m mrow-m-pnl">
            <Metric value={pnl} format="pnl" size="sm" showArrow as="span" />
          </span>
          <span className="mrow-m mrow-m-win">
            <span
              className="rank-stat"
              title={trader.metrics_estimated ? t('estimatedFromRoi') : undefined}
            >
              {winRate != null
                ? `${estimatedPrefix}${winRate.toFixed(1)}%`
                : trader.trades_count === 0
                  ? t('holderBadge')
                  : NULL_DISPLAY}
            </span>
          </span>
          <span className="mrow-m mrow-m-mdd">
            <span
              className="rank-stat"
              title={trader.metrics_estimated ? t('estimatedFromRoi') : undefined}
            >
              {drawdownDisplay === NULL_DISPLAY
                ? NULL_DISPLAY
                : `${estimatedPrefix}${drawdownDisplay}`}
            </span>
          </span>
        </Link>
      </TraderRowSwipeActions>
    )
  },
  (prev, next) => areTraderPropsEqual(prev, next) && prev.source === next.source
)
