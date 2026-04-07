import React, { memo, useCallback } from 'react'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import type { Trader } from './RankingTable'
import type { SourceInfo } from './utils'
import { formatROI, formatPnL, formatDisplayName } from './utils'
import { HighlightedName } from './RankingSearch'
import { Sparkline } from '../ui/Sparkline'
import {
  TRADER_TEXT_TERTIARY,
  TRADER_ACCENT_ERROR,
  RankDisplay,
  TraderAvatar,
  ScoreConfidenceIndicator,
  MetricStat,
  areTraderPropsEqual,
  getScoreStyle,
} from './shared/TraderDisplay'
import { useComparisonStore } from '@/lib/stores'
import { getPlatformNote } from '@/lib/constants/platform-metrics'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'

export interface TraderCardProps {
  trader: Trader
  rank: number
  source?: string
  language: string
  searchQuery?: string
  getMedalGlowClass: (rank: number) => string
  parseSourceInfo: (src: string) => SourceInfo
}

export const TraderCard = memo(function TraderCard({
  trader,
  rank,
  source,
  language: _language,
  searchQuery = '',
  getMedalGlowClass,
  parseSourceInfo,
}: TraderCardProps) {
  const { t } = useLanguage()
  const traderHandle = trader.handle || trader.id
  const href = `/trader/${encodeURIComponent(trader.id)}${trader.source ? `?platform=${encodeURIComponent(trader.source)}` : ""}`
  const displayName = trader.display_name || formatDisplayName(traderHandle, trader.source || source)
  const sourceInfo = parseSourceInfo(trader.source || source || '')

  const isSelected = useComparisonStore(useCallback(s => s.isSelected(trader.id), [trader.id]))
  const canAddMore = useComparisonStore(useCallback(s => s.selectedTraders.length < 5, []))

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

  return (
    <Link
      href={href}
      prefetch={false}
      style={{ textDecoration: 'none', display: 'block' }}
      aria-label={`#${rank} ${displayName}, ROI ${formatROI(trader.roi)}`}
    >
      <Box
        className="ranking-row trader-card-contained glass-card glass-card-hover"
        style={{
          padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
          borderRadius: tokens.radius.lg,
          cursor: 'pointer',
          display: 'flex',
          flexDirection: 'column',
          gap: tokens.spacing[2],
          position: 'relative',
          border: isSelected ? `2px solid ${tokens.colors.accent.primary}` : undefined,
        }}
      >
        {/* Compare checkbox */}
        <Box
          className="compare-checkbox-cell"
          onClick={handleCompareToggle}
          style={{
            position: 'absolute',
            top: 4,
            right: 4,
            width: tokens.touchTarget.min,
            height: tokens.touchTarget.min,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: isSelected ? 1 : 0,
            transition: 'opacity 0.15s ease',
            zIndex: 2,
          }}
        >
          <input
            type="checkbox"
            checked={isSelected}
            disabled={!isSelected && !canAddMore}
            readOnly
            aria-label="Select trader for comparison"
            style={{ cursor: 'pointer', width: 16, height: 16, accentColor: tokens.colors.accent.primary }}
          />
        </Box>

        {/* Top row: Rank + Avatar + Name */}
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
          {/* Rank */}
          <Box style={{ minWidth: 32 }}>
            <RankDisplay
              rank={rank}
              rankChange={trader.rank_change}
              isNew={trader.is_new}
              glowClass={getMedalGlowClass(rank)}
            />
          </Box>

          {/* Avatar */}
          <TraderAvatar
            traderId={trader.id}
            displayName={displayName}
            avatarUrl={trader.avatar_url}
            rank={rank}
            size={44}
          />

          {/* Name + Source */}
          <Box style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <Text size="md" weight="bold" style={{ color: tokens.colors.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              <HighlightedName text={displayName} query={searchQuery} />
            </Text>
            <Box style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Box className="source-tag" style={{ background: `${sourceInfo.typeColor}15`, border: `1px solid ${sourceInfo.typeColor}30` }}>
                <Text size="xs" weight="bold" style={{ color: sourceInfo.typeColor, fontSize: tokens.typography.fontSize.xs, lineHeight: 1.2 }}>
                  {sourceInfo.type}
                </Text>
              </Box>
              {/* Bot Badge */}
              {(trader.source === 'web3_bot' || trader.trader_type === 'bot') && (
                <span style={{
                  padding: '1px 5px',
                  borderRadius: tokens.radius.md,
                  fontSize: 11,
                  fontWeight: 600,
                  color: '#a78bfa',
                  background: 'rgba(167, 139, 250, 0.12)',
                  border: '1px solid rgba(167, 139, 250, 0.25)',
                  lineHeight: 1.4,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 2,
                }}>
                  <span style={{ fontSize: 9 }}>{'⚡'}</span>
                  Bot
                </span>
              )}
              {trader.also_on && trader.also_on.length > 0 && (
                <Text size="xs" style={{ fontSize: tokens.typography.fontSize.xs, color: TRADER_TEXT_TERTIARY }}>
                  +{trader.also_on.length}
                </Text>
              )}
            </Box>
          </Box>

          {/* Arena Score */}
          {trader.arena_score != null && (() => {
            const { bgGradient, borderColor, textColor } = getScoreStyle(trader.arena_score)
            return (
              <Box style={{
                position: 'relative',
                minWidth: 50, height: 28, borderRadius: tokens.radius.md,
                background: bgGradient,
                border: `1px solid ${borderColor}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Text size="sm" weight="black" style={{ color: textColor, fontSize: tokens.typography.fontSize.sm }}>
                  {Number(trader.arena_score).toFixed(0)}
                </Text>
                <ScoreConfidenceIndicator trader={trader} />
              </Box>
            )
          })()}
        </Box>

        {/* Sparkline */}
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          {/* roi is guaranteed non-null by data layer (leaderboard_ranks.roi coerced via ?? 0) */}
          <Box style={{ flexShrink: 1, minWidth: 0, overflow: 'hidden' }}>
            <Sparkline roi={trader.roi} width={120} height={24} />
          </Box>
          <Text size="lg" weight="black" style={{ color: trader.roi != null && Number.isFinite(trader.roi) ? (trader.roi >= 0 ? tokens.colors.accent.success : TRADER_ACCENT_ERROR) : tokens.colors.text.tertiary, marginLeft: 'auto' }}>
            {formatROI(trader.roi)}
          </Text>
        </Box>

        {/* Stats row */}
        <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: tokens.spacing[2] }}>
          <MetricStat
            label="Sharpe"
            value={trader.sharpe_ratio != null ? trader.sharpe_ratio.toFixed(2) : undefined}
            color={trader.sharpe_ratio != null ? (trader.sharpe_ratio >= 2 ? tokens.colors.accent.success : trader.sharpe_ratio <= 0 ? TRADER_ACCENT_ERROR : undefined) : undefined}
          />
          <MetricStat
            label="PnL"
            value={formatPnL(trader.pnl)}
            color={trader.pnl != null ? ((trader.pnl >= 0) ? tokens.colors.accent.success : TRADER_ACCENT_ERROR) : undefined}
          />
          <MetricStat
            label={t('winRatePercent')}
            value={trader.win_rate != null ? `${Number(trader.win_rate).toFixed(1)}%` : undefined}
            color={trader.win_rate != null && trader.win_rate > 50 ? tokens.colors.accent.success : undefined}
            nullTooltip={trader.win_rate == null ? (getPlatformNote(trader.source || source || '') || `Not available for ${EXCHANGE_NAMES[trader.source || source || ''] || (trader.source || source || '').replace('_', ' ')}`) : undefined}
          />
          <MetricStat
            label="MDD"
            value={trader.max_drawdown != null ? (Math.abs(Number(trader.max_drawdown)) < 0.05 ? '< 0.1%' : `-${Math.abs(Number(trader.max_drawdown)).toFixed(1)}%`) : undefined}
            color={trader.max_drawdown != null ? TRADER_ACCENT_ERROR : undefined}
            nullTooltip={trader.max_drawdown == null ? (getPlatformNote(trader.source || source || '') || `Not available for ${EXCHANGE_NAMES[trader.source || source || ''] || (trader.source || source || '').replace('_', ' ')}`) : undefined}
          />
        </Box>

      </Box>
    </Link>
  )
}, areTraderPropsEqual)
