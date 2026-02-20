import React, { memo, useCallback } from 'react'
import Link from 'next/link'
import { mutate } from 'swr'
import { fetcher } from '@/lib/hooks/useSWR'
import dynamic from 'next/dynamic'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useCountUp } from '@/lib/hooks/useCountUp'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import { getPlatformNote } from '@/lib/constants/platform-metrics'
import { t as i18nT } from '@/lib/i18n'
import type { Trader } from './RankingTable'
import type { SourceInfo } from './utils'
import { formatPnL, formatROI, formatDisplayName } from './utils'
import { HighlightedName } from './RankingSearch'
import {
  TRADER_TEXT_TERTIARY,
  TRADER_ACCENT_ERROR,
  RankDisplay,
  TraderAvatar,
  ArenaScoreBadge,
  areTraderPropsEqual,
} from './shared/TraderDisplay'
import { getScoreColor } from '@/lib/utils/score-colors'
import { CopyButton } from './HeroSection'
import { useComparisonStore } from '@/lib/stores'
import { classifyStyle, getStyleInfo, type TradingStyle } from '@/lib/utils/trading-style'

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

// Animated ROI value with count-up effect
function AnimatedROI({ roi, roiColor }: { roi: number; roiColor: string }) {
  const animatedValue = useCountUp(roi, 500)
  return (
    <Text
      size="md"
      weight="black"
      className="roi-value"
      style={{ color: roiColor, lineHeight: 1.2, fontSize: '16px', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', fontVariantNumeric: 'tabular-nums', fontFeatureSettings: '"tnum" 1' }}
      title={`${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%`}
    >
      {formatROI(animatedValue)}
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
  const traderHandle = trader.handle || trader.id
  const href = `/trader/${encodeURIComponent(trader.id)}${trader.source ? `?platform=${encodeURIComponent(trader.source)}` : ""}`
  // Show original platform ID as primary display name
  // Prefer handle (original exchange nickname) over id
  const displayName = trader.display_name || formatDisplayName(trader.handle || trader.id, trader.source || source)
  const isAddress = traderHandle.startsWith('0x') && traderHandle.length > 20
  const sourceInfo = parseSourceInfo(trader.source || source || '')

  // Compare checkbox state
  const isSelected = useComparisonStore(s => s.isSelected(trader.id))
  const addTrader = useComparisonStore(s => s.addTrader)
  const removeTrader = useComparisonStore(s => s.removeTrader)
  const canAddMore = useComparisonStore(s => s.canAddMore)

  // Prefetch trader detail on hover (warm SWR cache)
  const handleMouseEnter = useCallback(() => {
    const detailUrl = `/api/traders/${encodeURIComponent(traderHandle)}`
    // Prefetch into SWR cache without blocking — only if not already cached
    mutate(detailUrl, fetcher(detailUrl), { revalidate: false })
  }, [traderHandle])

  const handleCompareToggle = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (isSelected) {
      removeTrader(trader.id)
    } else {
      addTrader({
        id: trader.id,
        handle: traderHandle,
        source: trader.source || source || '',
        avatarUrl: trader.avatar_url || undefined,
      })
    }
  }

  // Top 3 background gradients
  const top3Bg = rank === 1
    ? 'linear-gradient(90deg, var(--color-gold-bg) 0%, transparent 100%)'
    : rank === 2
    ? 'linear-gradient(90deg, var(--color-silver-bg) 0%, transparent 100%)'
    : rank === 3
    ? 'linear-gradient(90deg, var(--color-bronze-bg) 0%, transparent 100%)'
    : undefined

  // Zebra stripe
  const zebraBg = rank > 3 && rank % 2 === 0 ? 'var(--overlay-hover)' : undefined

  return (
    <>
    <Link
      href={href}
      className="ranking-row-link"
      style={{ textDecoration: 'none', display: 'block' }}
      aria-label={`#${rank} ${displayName}, ROI ${(trader.roi || 0) >= 0 ? '+' : ''}${(trader.roi || 0).toFixed(2)}%`}
      tabIndex={0}
      onMouseEnter={handleMouseEnter}
    >
      <Box
        className="ranking-row ranking-table-grid ranking-table-grid-custom touch-target"
        style={{
          display: 'grid',
          alignItems: 'center',
          gap: tokens.spacing[2],
          padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
          borderBottom: `1px solid var(--glass-border-light)`,
          cursor: 'pointer',
          position: 'relative',
          minHeight: 56,
          background: top3Bg || zebraBg || 'transparent',
        }}
      >
        {/* Compare checkbox — hidden, use toolbar compare instead */}
        <Box
          className="compare-checkbox-cell"
          onClick={handleCompareToggle}
          style={{
            display: 'none',
          }}
        >
          <input
            type="checkbox"
            checked={isSelected}
            disabled={!isSelected && !canAddMore()}
            readOnly
            aria-label="Select trader for comparison"
            style={{
              cursor: 'pointer',
              width: 16,
              height: 16,
              accentColor: tokens.colors.accent.primary,
              appearance: 'none',
              WebkitAppearance: 'none',
              border: `2px solid ${isSelected ? tokens.colors.accent.primary : 'var(--color-text-tertiary)'}`,
              borderRadius: 4,
              background: isSelected ? tokens.colors.accent.primary : 'transparent',
              position: 'relative',
            }}
          />
        </Box>

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
            size={36}
          />
          <Box style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: 1 }}>
            <Box style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Text size="sm" weight="bold" style={{ color: tokens.colors.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '14px' }}>
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
                  <span style={{ fontSize: tokens.typography.fontSize.xs, fontWeight: 700, color: TRADER_TEXT_TERTIARY }}>{trader.arena_score.toFixed(0)}</span>
                </span>
              )}
            </Box>
            <Box style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <Box className="source-tag" style={{ background: `${sourceInfo.typeColor}15`, border: `1px solid ${sourceInfo.typeColor}30` }}>
                <Text size="xs" weight="bold" style={{ color: sourceInfo.typeColor, fontSize: tokens.typography.fontSize.xs, lineHeight: 1.2 }}>
                  {sourceInfo.type}
                </Text>
              </Box>
              {/* Trading Style Chip */}
              {(() => {
                const style = (trader.trading_style && trader.trading_style !== 'unknown')
                  ? getStyleInfo(trader.trading_style as TradingStyle)
                  : (() => {
                      const computed = classifyStyle({
                        avg_holding_hours: trader.avg_holding_hours,
                        trades_count: trader.trades_count,
                        win_rate: trader.win_rate,
                      })
                      return computed !== 'unknown' ? getStyleInfo(computed) : null
                    })()
                return style ? (
                  <span style={{
                    padding: '1px 6px',
                    borderRadius: tokens.radius.md,
                    fontSize: 12,
                    fontWeight: 600,
                    color: style.color,
                    background: style.bgColor,
                    border: `1px solid ${style.borderColor}`,
                    lineHeight: 1.4,
                  }}>
                    {language === 'zh' ? style.label : style.labelEn}
                  </span>
                ) : null
              })()}
              {trader.also_on && trader.also_on.length > 0 && (
                <Text size="xs" style={{ fontSize: tokens.typography.fontSize.xs, color: TRADER_TEXT_TERTIARY, lineHeight: 1.2 }}>
                  also on: {trader.also_on.map(s => EXCHANGE_NAMES[s] || s.split('_')[0]).filter((v, i, a) => a.indexOf(v) === i).join(', ')}
                </Text>
              )}
            </Box>
          </Box>
        </Box>

        {/* Arena Score */}
        <Box className="col-score" style={{ textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
          <ArenaScoreBadge score={trader.arena_score} showConfidence trader={trader} />
          <ScoreBreakdownTooltip trader={trader} language={language} />
        </Box>

        {/* ROI */}
        {(() => {
          const roi = trader.roi || 0
          const roiColor = roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error
          return (
            <Box className="roi-cell" style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
              <AnimatedROI roi={roi} roiColor={roiColor} />
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
          {trader.win_rate ? (
            <Text size="sm" weight="semibold" style={{ color: trader.win_rate > 50 ? tokens.colors.accent.success : TRADER_TEXT_TERTIARY, lineHeight: 1.2, fontSize: tokens.typography.fontSize.sm, fontVariantNumeric: 'tabular-nums' }}>
              {trader.win_rate.toFixed(1)}%
            </Text>
          ) : (
            <NaIndicator source={trader.source || source} metricType="winRate" />
          )}
        </Box>

        {/* MDD */}
        <Box className="col-mdd" style={{ textAlign: 'right', alignItems: 'center', justifyContent: 'flex-end' }}>
          {trader.max_drawdown ? (
            <Text size="sm" weight="semibold" style={{ color: TRADER_ACCENT_ERROR, lineHeight: 1.2, fontSize: tokens.typography.fontSize.sm, fontVariantNumeric: 'tabular-nums' }}>
              {Math.abs(trader.max_drawdown) < 0.05 ? '< 0.1' : `-${Math.abs(trader.max_drawdown).toFixed(1)}`}%
            </Text>
          ) : (
            <NaIndicator source={trader.source || source} metricType="drawdown" />
          )}
        </Box>
      </Box>

      {/* Expand button overlay */}
      {onToggleExpand && (trader.profitability_score != null || trader.risk_control_score != null || trader.execution_score != null) && (
        <Box
          onClick={(e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); onToggleExpand(trader.id) }}
          style={{
            position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)',
            width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', opacity: 0.4, transition: 'opacity 0.15s',
            borderRadius: tokens.radius.sm,
          }}
          className="expand-btn"
          title={language === 'zh' ? '展开评分详情' : 'Expand score details'}
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
    </>
  )
}, (prev, next) => areTraderPropsEqual(prev, next) && prev.source === next.source && prev.isExpanded === next.isExpanded)
