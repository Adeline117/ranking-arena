import React, { memo } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import type { Trader } from './RankingTable'
import type { SourceInfo } from './utils'
import { formatROI, formatDisplayName } from './utils'
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
// AddCompareButton removed — compare accessible via toolbar only

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
  language,
  searchQuery = '',
  getMedalGlowClass,
  parseSourceInfo,
}: TraderCardProps) {
  const traderHandle = trader.handle || trader.id
  const href = `/trader/${encodeURIComponent(traderHandle)}`
  const displayName = formatDisplayName(traderHandle)
  const sourceInfo = parseSourceInfo(trader.source || source || '')

  return (
    <Link
      href={href}
      style={{ textDecoration: 'none', display: 'block' }}
      aria-label={`#${rank} ${displayName}, ROI ${(trader.roi || 0) >= 0 ? '+' : ''}${(trader.roi || 0).toFixed(2)}%`}
    >
      <Box
        className="ranking-row trader-card-contained glass-card"
        style={{
          padding: tokens.spacing[4],
          borderRadius: tokens.radius.lg,
          cursor: 'pointer',
          display: 'flex',
          flexDirection: 'column',
          gap: tokens.spacing[3],
        }}
      >
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
                <Text size="xs" weight="bold" style={{ color: sourceInfo.typeColor, fontSize: '10px', lineHeight: 1.2 }}>
                  {sourceInfo.type}
                </Text>
              </Box>
              {trader.also_on && trader.also_on.length > 0 && (
                <Text size="xs" style={{ fontSize: '9px', color: TRADER_TEXT_TERTIARY }}>
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
                <Text size="sm" weight="black" style={{ color: textColor, fontSize: '13px' }}>
                  {trader.arena_score.toFixed(0)}
                </Text>
                <ScoreConfidenceIndicator trader={trader} />
              </Box>
            )
          })()}
        </Box>

        {/* Sparkline */}
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <Sparkline roi={trader.roi || 0} width={120} height={24} />
          <Text size="lg" weight="black" style={{ color: (trader.roi || 0) >= 0 ? tokens.colors.accent.success : TRADER_ACCENT_ERROR, marginLeft: 'auto' }}>
            {formatROI(trader.roi || 0)}
          </Text>
        </Box>

        {/* Stats row */}
        <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: tokens.spacing[2] }}>
          <MetricStat
            label="ROI"
            value={formatROI(trader.roi || 0)}
            color={(trader.roi || 0) >= 0 ? tokens.colors.accent.success : TRADER_ACCENT_ERROR}
          />
          <MetricStat
            label={language === 'zh' ? '胜率' : 'Win%'}
            value={trader.win_rate ? `${trader.win_rate.toFixed(0)}%` : 'N/A'}
            color={trader.win_rate && trader.win_rate > 50 ? tokens.colors.accent.success : undefined}
          />
          <MetricStat
            label="MDD"
            value={trader.max_drawdown ? `-${Math.abs(trader.max_drawdown).toFixed(0)}%` : 'N/A'}
            color={trader.max_drawdown ? TRADER_ACCENT_ERROR : undefined}
          />
        </Box>

      </Box>
    </Link>
  )
}, areTraderPropsEqual)
