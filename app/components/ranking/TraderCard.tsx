import React, { memo, useCallback, useState } from 'react'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import Link from 'next/link'
import { tokens, alpha } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import type { Trader } from './RankingTable'
import type { SourceInfo } from './utils'
import { formatROI, formatDisplayName } from './utils'
import { HighlightedName } from './RankingSearch'
import { Sparkline } from '../ui/Sparkline'
import { RankSparkline } from './RankSparkline'
import Metric from '../ui/Metric'
import ScoreMiniBar from './ScoreMiniBar'
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
import { BOT_BADGE_STYLE, BOT_EMOJI_STYLE } from './TraderRowStyles'
import AntiGamingBadge from './AntiGamingBadge'
import VerifiedDataBadge from './VerifiedDataBadge'
import { useComparisonStore } from '@/lib/stores/comparisonStore'
import type { CompareAccountRef } from '@/lib/compare/identity'
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
  /**
   * Real 7-day rank trajectory (oldest→newest), fetched in batch by RankingTable.
   * When present (≥2 points) the row draws a true trend sparkline; otherwise it
   * keeps the static ROI-bar fallback so there is no layout shift while loading.
   */
  series?: number[]
}

export const TraderCard = memo(
  function TraderCard({
    trader,
    rank,
    source,
    language: _language,
    searchQuery = '',
    getMedalGlowClass,
    parseSourceInfo,
    series,
  }: TraderCardProps) {
    const { t } = useLanguage()
    const traderHandle = trader.handle || trader.id
    const href = `/trader/${encodeURIComponent(trader.id)}${trader.source ? `?platform=${encodeURIComponent(trader.source)}` : ''}`
    const displayName =
      trader.display_name || formatDisplayName(traderHandle, trader.source || source)
    const traderSource = trader.source || source || ''
    const sourceInfo = parseSourceInfo(traderSource)
    const compareAccount: CompareAccountRef = { id: trader.id, source: traderSource }

    const isSelected = useComparisonStore(
      useCallback(
        (s) => s.isSelected({ id: trader.id, source: traderSource }),
        [trader.id, traderSource]
      )
    )
    // Stable boolean selector: only changes when comparison count crosses the max threshold.
    // Previously used s.canAddMore() which returns a new closure on every store change,
    // causing all 50 TraderCards to re-render per comparison add/remove.
    const canAddMore = useComparisonStore(useCallback((s) => s.canAddMore(), []))
    const [shareConfirmed, setShareConfirmed] = useState(false)

    const handleShare = async (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const shareUrl = `${window.location.origin}/trader/${encodeURIComponent(trader.id)}${trader.source ? `?platform=${encodeURIComponent(trader.source)}` : ''}`
      const shareText = `${displayName} — ROI ${formatROI(trader.roi)}, Arena Score ${trader.arena_score != null ? Number(trader.arena_score).toFixed(0) : 'N/A'}`
      if (navigator.share) {
        try {
          await navigator.share({ title: shareText, url: shareUrl })
        } catch {
          /* user cancelled */
        }
      } else {
        await navigator.clipboard.writeText(shareUrl)
        setShareConfirmed(true)
        setTimeout(() => setShareConfirmed(false), 1500)
      }
    }

    const handleCompareToggle = (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (isSelected) {
        useComparisonStore.getState().removeTrader(compareAccount)
      } else {
        useComparisonStore.getState().addTrader({
          id: trader.id,
          handle: traderHandle,
          source: traderSource,
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
          {/* Share + Compare actions */}
          <Box
            style={{
              position: 'absolute',
              top: 4,
              right: 4,
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              zIndex: tokens.zIndex.dropdown,
            }}
          >
            {/* Share button */}
            <Box
              onClick={handleShare}
              style={{
                width: tokens.touchTarget.min,
                height: tokens.touchTarget.min,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                borderRadius: tokens.radius.md,
                transition: 'background 0.15s ease',
              }}
              aria-label="Share trader"
            >
              {shareConfirmed ? (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={tokens.colors.accent.success}
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={tokens.colors.text.tertiary}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
                  <polyline points="16 6 12 2 8 6" />
                  <line x1="12" y1="2" x2="12" y2="15" />
                </svg>
              )}
            </Box>

            {/* Compare checkbox */}
            <Box
              className="compare-checkbox-cell"
              onClick={handleCompareToggle}
              style={{
                width: tokens.touchTarget.min,
                height: tokens.touchTarget.min,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                opacity: isSelected ? 1 : 0,
                transition: 'opacity 0.15s ease',
              }}
            >
              <input
                type="checkbox"
                checked={isSelected}
                disabled={!isSelected && !canAddMore}
                readOnly
                aria-label="Select trader for comparison"
                style={{
                  cursor: 'pointer',
                  width: 16,
                  height: 16,
                  accentColor: tokens.colors.accent.primary,
                }}
              />
            </Box>
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
              avatarMirrorUrl={trader.avatar_url_mirror}
              rank={rank}
              size={44}
            />

            {/* Name + Source */}
            <Box style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <Text
                size="md"
                weight="bold"
                style={{
                  color: tokens.colors.text.primary,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                <HighlightedName text={displayName} query={searchQuery} />
              </Text>
              <Box style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Box
                  className="source-tag"
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
                {/* Confirmed Bot Badge — canonical themed style (was hardcoded
                    #a78bfa, an off-brand violet that didn't shift in light theme) */}
                {(trader.source === 'web3_bot' || trader.trader_type === 'bot') && (
                  <span role="img" aria-label="Bot" style={BOT_BADGE_STYLE}>
                    <span aria-hidden="true" style={BOT_EMOJI_STYLE}>
                      {'⚡'}
                    </span>
                    Bot
                  </span>
                )}
                {/* Suspected Bot Badge */}
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
                <VerifiedDataBadge verified={trader.is_verified_data} />
                <AntiGamingBadge
                  flags={trader.anti_gaming_flags}
                  winRate={trader.win_rate}
                  tradesCount={trader.trades_count}
                />
                {trader.also_on && trader.also_on.length > 0 && (
                  <Text
                    size="xs"
                    style={{ fontSize: tokens.typography.fontSize.xs, color: TRADER_TEXT_TERTIARY }}
                  >
                    +{trader.also_on.length}
                  </Text>
                )}
              </Box>
            </Box>

            {/* Arena Score — badge (number) + graded mini-bar (audit §4) */}
            {trader.arena_score != null &&
              (() => {
                const { bgGradient, borderColor, textColor } = getScoreStyle(trader.arena_score)
                return (
                  <Box
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-end',
                      gap: 4,
                    }}
                  >
                    <Box
                      style={{
                        position: 'relative',
                        minWidth: 50,
                        height: 28,
                        borderRadius: tokens.radius.md,
                        background: bgGradient,
                        border: `1px solid ${borderColor}`,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Text
                        size="sm"
                        weight="black"
                        style={{ color: textColor, fontSize: tokens.typography.fontSize.sm }}
                      >
                        {Number(trader.arena_score).toFixed(0)}
                      </Text>
                      <ScoreConfidenceIndicator trader={trader} />
                    </Box>
                    <ScoreMiniBar score={Number(trader.arena_score)} width={50} height={4} />
                  </Box>
                )
              })()}
          </Box>

          {/* Sparkline */}
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
            {/* Real rank-trajectory sparkline when batch history is loaded; else the
              static ROI-bar fallback (identical 120×24 footprint → no CLS). */}
            <Box style={{ flexShrink: 1, minWidth: 0, overflow: 'hidden' }}>
              {series && series.length >= 2 ? (
                <RankSparkline data={series.map((rank) => ({ rank }))} width={120} height={24} />
              ) : (
                <Sparkline roi={trader.roi} width={120} height={24} />
              )}
            </Box>
            <Metric
              value={trader.roi}
              format="roi"
              size="lg"
              showArrow
              style={{ marginLeft: 'auto' }}
            />
          </Box>

          {/* Stats row */}
          <Box
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: tokens.spacing[2],
            }}
          >
            <MetricStat
              label="Sharpe"
              value={trader.sharpe_ratio != null ? trader.sharpe_ratio.toFixed(2) : undefined}
              color={
                trader.sharpe_ratio != null
                  ? trader.sharpe_ratio >= 2
                    ? tokens.colors.accent.success
                    : trader.sharpe_ratio <= 0
                      ? TRADER_ACCENT_ERROR
                      : undefined
                  : undefined
              }
            />
            <MetricStat
              label="PnL"
              value={
                trader.pnl != null ? (
                  <Metric value={trader.pnl} format="pnl" size="sm" as="span" showArrow />
                ) : undefined
              }
            />
            <MetricStat
              label={t('winRatePercent')}
              value={
                trader.win_rate != null ? (
                  `${Number(trader.win_rate).toFixed(1)}%`
                ) : // Confirmed zero-trade wallet: win% undefined by design —
                // labeled "Holder", not an empty stat.
                trader.trades_count === 0 ? (
                  <span title={t('holderTooltip')} style={{ cursor: 'help' }}>
                    {t('holderBadge')}
                  </span>
                ) : undefined
              }
              color={
                trader.win_rate != null && trader.win_rate > 50
                  ? tokens.colors.accent.success
                  : undefined
              }
              nullTooltip={
                trader.win_rate == null
                  ? trader.trades_count === 0
                    ? t('holderTooltip')
                    : getPlatformNote(trader.source || source || '') ||
                      `Not available for ${EXCHANGE_NAMES[trader.source || source || ''] || (trader.source || source || '').replace('_', ' ')}`
                  : undefined
              }
            />
            <MetricStat
              label="MDD"
              value={
                trader.max_drawdown != null ? (
                  <Metric
                    value={-Math.abs(Number(trader.max_drawdown))}
                    format="percent"
                    display={
                      Math.abs(Number(trader.max_drawdown)) < 0.05
                        ? '< 0.1%'
                        : `-${Math.abs(Number(trader.max_drawdown)).toFixed(1)}%`
                    }
                    size="sm"
                    as="span"
                    showArrow
                  />
                ) : undefined
              }
              nullTooltip={
                trader.max_drawdown == null
                  ? getPlatformNote(trader.source || source || '') ||
                    `Not available for ${EXCHANGE_NAMES[trader.source || source || ''] || (trader.source || source || '').replace('_', ' ')}`
                  : undefined
              }
            />
          </Box>
        </Box>
      </Link>
    )
    // areTraderPropsEqual ignores `series`, so compare it explicitly — otherwise the
    // card would skip its re-render when batch history arrives and never upgrade
    // from the fallback bar to the real trajectory.
  },
  (prev, next) => areTraderPropsEqual(prev, next) && prev.series === next.series
)
