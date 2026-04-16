'use client'

import React, { memo } from 'react'
import { localizedLabel } from '@/lib/utils/format'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import { t as i18nT } from '@/lib/i18n'
import { TraderAvatar } from './shared/TraderDisplay'
import { HighlightedName } from './RankingSearch'
import { CopyButton } from './HeroSection'
import { getScoreColor } from '@/lib/utils/score-colors'
import type { Trader } from './RankingTable'
import type { SourceInfo } from './utils'
import type { TradingStyle } from '@/lib/utils/trading-style'
import { getStyleInfo } from '@/lib/utils/trading-style'
import {
  TRADER_INFO_STYLE,
  NAME_COLUMN_STYLE,
  NAME_ROW_STYLE,
  TAGS_ROW_STYLE,
  MOBILE_BADGE_STYLE,
  MOBILE_BADGE_TEXT_STYLE,
  VERIFIED_BADGE_STYLE,
  BOT_BADGE_STYLE,
  BOT_EMOJI_STYLE,
  TRADING_STYLE_BASE_STYLE,
  ALSO_ON_STYLE,
} from './TraderRowStyles'

export interface TraderInfoCellProps {
  trader: Trader
  rank: number
  displayName: string
  isAddress: boolean
  traderHandle: string
  sourceInfo: SourceInfo
  searchQuery: string
  language: string
  tradingStyleInfo: ReturnType<typeof getStyleInfo> | null
}

/**
 * Trader identity cell: avatar, name, badges (verified/bot/style), source tag, "also on" links.
 */
export const TraderInfoCell = memo(function TraderInfoCell({
  trader,
  rank,
  displayName,
  isAddress,
  traderHandle,
  sourceInfo,
  searchQuery,
  language,
  tradingStyleInfo,
}: TraderInfoCellProps) {
  return (
    <Box style={TRADER_INFO_STYLE}>
      <TraderAvatar
        traderId={trader.id}
        displayName={displayName}
        avatarUrl={trader.avatar_url}
        rank={rank}
        size={rank <= 3 ? 42 : 36}
      />
      <Box style={NAME_COLUMN_STYLE}>
        <Box style={NAME_ROW_STYLE}>
          <Text size="sm" weight="bold" style={{ color: tokens.colors.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: rank <= 3 ? '15px' : '14px', letterSpacing: rank <= 3 ? '-0.01em' : undefined }}>
            <HighlightedName text={displayName} query={searchQuery} />
          </Text>
          {isAddress && <CopyButton text={traderHandle} />}
          {/* Mobile Score Badge */}
          {trader.arena_score != null && Number.isFinite(Number(trader.arena_score)) && (
            <span className="mobile-score-badge" style={MOBILE_BADGE_STYLE} aria-label={`Arena Score: ${Number(trader.arena_score).toFixed(0)}`}>
              <span aria-hidden="true" style={{
                width: 6, height: 6, borderRadius: '50%',
                background: getScoreColor(trader.arena_score),
              }} />
              <span style={MOBILE_BADGE_TEXT_STYLE}>{Number(trader.arena_score).toFixed(0)}</span>
            </span>
          )}
        </Box>
        <Box style={TAGS_ROW_STYLE}>
          <Box className="source-tag" role="img" aria-label={`Platform type: ${sourceInfo.type}`} style={{ background: `${sourceInfo.typeColor}15`, border: `1px solid ${sourceInfo.typeColor}30` }}>
            <Text size="xs" weight="bold" style={{ color: sourceInfo.typeColor, fontSize: tokens.typography.fontSize.xs, lineHeight: 1.2 }}>
              {sourceInfo.type}
            </Text>
          </Box>
          {/* Verified Badge */}
          {trader.is_verified && (
            <span
              role="img"
              aria-label={i18nT('verifiedTooltip')}
              title={i18nT('verifiedTooltip')}
              style={VERIFIED_BADGE_STYLE}>
              <svg aria-hidden="true" width="10" height="10" viewBox="0 0 20 20" fill="currentColor"><path d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"/></svg>
              {i18nT('verifiedBadge')}
            </span>
          )}
          {/* Bot Badge */}
          {(trader.is_bot || trader.trader_type === 'bot') && (
            <span role="img" aria-label={`Bot: ${i18nT('botLabel')}`} style={BOT_BADGE_STYLE}>
              <span aria-hidden="true" style={BOT_EMOJI_STYLE}>{'⚡'}</span>
              {i18nT('botLabel')}
            </span>
          )}
          {/* Trading Style Chip */}
          {tradingStyleInfo && (
            <span
              role="img"
              aria-label={`Trading style: ${tradingStyleInfo.labelEn}`}
              style={{
                ...TRADING_STYLE_BASE_STYLE,
                color: tradingStyleInfo.color,
                background: tradingStyleInfo.bgColor,
                border: `1px solid ${tradingStyleInfo.borderColor}`,
              }}>
              {localizedLabel(tradingStyleInfo.label, tradingStyleInfo.labelEn, language)}
            </span>
          )}
          {trader.also_on && trader.also_on.length > 0 && (
            <Text size="xs" style={ALSO_ON_STYLE}>
              also on: {[...new Set(trader.also_on.map(s => EXCHANGE_NAMES[s] || s.split('_')[0]))].join(', ')}
            </Text>
          )}
        </Box>
      </Box>
    </Box>
  )
})
