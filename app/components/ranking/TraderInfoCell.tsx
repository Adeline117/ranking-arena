'use client'

import React, { memo } from 'react'
import { tokens, alpha } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import { t as i18nT, type TranslationKey } from '@/lib/i18n'
import { TraderAvatar } from './shared/TraderDisplay'
import { HighlightedName } from './RankingSearch'
import { CopyButton } from './HeroSection'
import { getScoreColor } from '@/lib/utils/score-colors'
import type { Trader } from './RankingTable'
import type { SourceInfo } from './utils'
import { getStyleInfo } from '@/lib/utils/trading-style'
import AntiGamingBadge from './AntiGamingBadge'
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
  tradingStyleInfo,
}: TraderInfoCellProps) {
  return (
    <Box style={TRADER_INFO_STYLE}>
      {/* Fixed size for ALL ranks: realtime reorders across the rank-3 boundary must
          not resize the avatar/name (42↔36 + font swap shifted the whole row — CLS).
          Top-3 distinction stays on the medal glow, which doesn't affect layout. */}
      <TraderAvatar
        traderId={trader.id}
        displayName={displayName}
        avatarUrl={trader.avatar_url}
        avatarMirrorUrl={trader.avatar_url_mirror}
        rank={rank}
        size={36}
      />
      <Box style={NAME_COLUMN_STYLE}>
        <Box style={NAME_ROW_STYLE}>
          <Text
            size="sm"
            weight="bold"
            style={{
              color: tokens.colors.text.primary,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: tokens.typography.fontSize.sm,
            }}
          >
            <HighlightedName text={displayName} query={searchQuery} />
          </Text>
          {isAddress && <CopyButton text={traderHandle} />}
          {/* Mobile Score Badge */}
          {trader.arena_score != null && Number.isFinite(Number(trader.arena_score)) && (
            <span
              className="mobile-score-badge"
              style={MOBILE_BADGE_STYLE}
              aria-label={`Arena Score: ${Number(trader.arena_score).toFixed(0)}`}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: getScoreColor(trader.arena_score),
                }}
              />
              <span style={MOBILE_BADGE_TEXT_STYLE}>{Number(trader.arena_score).toFixed(0)}</span>
            </span>
          )}
        </Box>
        <Box style={TAGS_ROW_STYLE}>
          <Box
            className="source-tag"
            role="img"
            aria-label={`Platform type: ${sourceInfo.type}`}
            style={{
              background: alpha(sourceInfo.typeColor, 8),
              border: `1px solid ${alpha(sourceInfo.typeColor, 19)}`,
            }}
          >
            <Text
              size="xs"
              weight="bold"
              style={{
                color: sourceInfo.typeColor,
                fontSize: tokens.typography.fontSize.xs,
                lineHeight: 1.2,
              }}
            >
              {sourceInfo.type}
            </Text>
          </Box>
          {/* Verified Badge */}
          {trader.is_verified && (
            <span
              role="img"
              aria-label={i18nT('verifiedTooltip')}
              title={i18nT('verifiedTooltip')}
              style={VERIFIED_BADGE_STYLE}
            >
              <svg
                aria-hidden="true"
                width="10"
                height="10"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" />
              </svg>
              {i18nT('verifiedBadge')}
            </span>
          )}
          {/* Bot Badge — confirmed (contract/web3_bot) */}
          {(trader.trader_type === 'bot' || trader.source === 'web3_bot') && (
            <span role="img" aria-label={`Bot: ${i18nT('botLabel')}`} style={BOT_BADGE_STYLE}>
              <span aria-hidden="true" style={BOT_EMOJI_STYLE}>
                {'⚡'}
              </span>
              {i18nT('botLabel')}
            </span>
          )}
          {/* Suspected bot badge — heuristic only */}
          {trader.trader_type === 'suspected_bot' && trader.source !== 'web3_bot' && (
            <span
              role="img"
              aria-label="Suspected bot"
              style={{ ...BOT_BADGE_STYLE, opacity: 0.7 }}
            >
              <span aria-hidden="true" style={BOT_EMOJI_STYLE}>
                {'⚡'}
              </span>
              Bot?
            </span>
          )}
          <AntiGamingBadge
            flags={trader.anti_gaming_flags}
            winRate={trader.win_rate}
            tradesCount={trader.trades_count}
            compact
          />
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
              }}
            >
              {i18nT(
                // snake_case → PascalCase(day_trader → DayTrader):旧写法只大写
                // 首字母,产出 tradingStyleDay_trader 这类不存在的 key 直出原文。
                `tradingStyle${tradingStyleInfo.style
                  .split('_')
                  .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                  .join('')}` as TranslationKey
              )}
            </span>
          )}
          {trader.also_on && trader.also_on.length > 0 && (
            <Text size="xs" style={ALSO_ON_STYLE}>
              also on:{' '}
              {[...new Set(trader.also_on.map((s) => EXCHANGE_NAMES[s] || s.split('_')[0]))].join(
                ', '
              )}
            </Text>
          )}
        </Box>
      </Box>
    </Box>
  )
})
