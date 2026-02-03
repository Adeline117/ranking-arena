import React, { memo } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
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
} from './shared/trader-display'

const ScoreBreakdownTooltip = dynamic(
  () => import('./ScoreBreakdownTooltip').then(m => ({ default: m.ScoreBreakdownTooltip })),
  {
    loading: () => <span style={{ width: 14, height: 14, display: 'inline-block' }} />,
    ssr: false,
  }
)

// Reusable N/A indicator for missing data
function NaIndicator() {
  return (
    <span
      title="Not provided by exchange"
      style={{ fontSize: '11px', color: TRADER_TEXT_TERTIARY, opacity: 0.4, letterSpacing: 1 }}
    >
      N/A
    </span>
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
}: TraderRowProps) {
  const traderHandle = trader.handle || trader.id
  const href = `/trader/${encodeURIComponent(traderHandle)}`
  const displayName = formatDisplayName(traderHandle)
  const sourceInfo = parseSourceInfo(trader.source || source || '')

  return (
    <Link
      href={href}
      className="ranking-row-link"
      style={{ textDecoration: 'none', display: 'block' }}
      aria-label={`#${rank} ${displayName}, ROI ${(trader.roi || 0) >= 0 ? '+' : ''}${(trader.roi || 0).toFixed(2)}%`}
      tabIndex={0}
    >
      <Box
        className="ranking-row ranking-table-grid ranking-table-grid-custom touch-target"
        style={{
          display: 'grid',
          alignItems: 'center',
          gap: tokens.spacing[2],
          padding: `${tokens.spacing[4]} ${tokens.spacing[3]}`,
          borderBottom: `1px solid var(--glass-border-light)`,
          cursor: 'pointer',
          position: 'relative',
          minHeight: 72,
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
            size={36}
          />
          <Box style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: 1 }}>
            <Box style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Text size="sm" weight="bold" style={{ color: tokens.colors.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '14px' }}>
                <HighlightedName text={displayName} query={searchQuery} />
              </Text>
              {/* Mobile Score Badge */}
              {trader.arena_score != null && (
                <span className="mobile-score-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
                  <span style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: trader.arena_score >= 60 ? tokens.colors.accent.success : trader.arena_score >= 40 ? tokens.colors.accent.warning : TRADER_TEXT_TERTIARY,
                  }} />
                  <span style={{ fontSize: '11px', fontWeight: 700, color: TRADER_TEXT_TERTIARY }}>{trader.arena_score.toFixed(0)}</span>
                </span>
              )}
            </Box>
            <Box style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <Box className="source-tag" style={{ background: `${sourceInfo.typeColor}15`, border: `1px solid ${sourceInfo.typeColor}30` }}>
                <Text size="xs" weight="bold" style={{ color: sourceInfo.typeColor, fontSize: '10px', lineHeight: 1.2 }}>
                  {sourceInfo.type}
                </Text>
              </Box>
              {trader.also_on && trader.also_on.length > 0 && (
                <Text size="xs" style={{ fontSize: '9px', color: TRADER_TEXT_TERTIARY, lineHeight: 1.2 }}>
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
          const roiColor = roi >= 0 ? tokens.colors.accent.success : TRADER_ACCENT_ERROR
          const pnl = trader.pnl
          const hasPnl = pnl != null
          const pnlColor = hasPnl
            ? (pnl >= 0 ? tokens.colors.accent.success : TRADER_ACCENT_ERROR)
            : TRADER_TEXT_TERTIARY
          const pnlText = hasPnl
            ? `${pnl >= 0 ? '+' : ''}${formatPnL(pnl)}`
            : '—'

          return (
            <Box className="roi-cell" style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
              <Text
                size="md"
                weight="black"
                className="roi-value"
                style={{ color: roiColor, lineHeight: 1.2, fontSize: '16px', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}
                title={`${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%`}
              >
                {formatROI(roi)}
              </Text>
              <Text
                size="xs"
                weight="semibold"
                className="pnl-value"
                style={{ color: pnlColor, lineHeight: 1.2, fontSize: '12px', opacity: hasPnl ? 0.85 : 0.5, cursor: hasPnl ? 'help' : 'default' }}
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
            <Text size="sm" weight="semibold" style={{ color: trader.win_rate > 50 ? tokens.colors.accent.success : TRADER_TEXT_TERTIARY, lineHeight: 1, fontSize: '13px' }}>
              {trader.win_rate.toFixed(0)}%
            </Text>
          ) : (
            <NaIndicator />
          )}
        </Box>

        {/* MDD */}
        <Box className="col-mdd" style={{ textAlign: 'right', alignItems: 'center', justifyContent: 'flex-end' }}>
          {trader.max_drawdown ? (
            <Text size="sm" weight="semibold" style={{ color: TRADER_ACCENT_ERROR, lineHeight: 1, fontSize: '13px' }}>
              -{Math.abs(trader.max_drawdown).toFixed(0)}%
            </Text>
          ) : (
            <NaIndicator />
          )}
        </Box>
      </Box>
    </Link>
  )
}, (prev, next) => areTraderPropsEqual(prev, next) && prev.source === next.source)
