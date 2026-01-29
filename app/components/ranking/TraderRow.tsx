import React, { memo } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { RankingBadge } from '../ui/icons'
import { Box, Text } from '../base'
import { getAvatarGradient, getAvatarInitial, getTraderAvatarUrl } from '@/lib/utils/avatar'
import {
  getOptimizedImageUrl,
  getImageLoadingStrategy,
  handleImageError,
  IMAGE_PLACEHOLDER,
} from '@/lib/performance/image-optimization'
import type { Trader } from './RankingTable'
import type { SourceInfo } from './utils'
import { formatPnL, formatROI, formatDisplayName } from './utils'
import { ScoreBreakdownTooltip } from './ScoreBreakdownTooltip'
import { HighlightedName } from './RankingSearch'

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
        {/* 排名 + Rank Change */}
        <Box style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
          {rank <= 3 ? (
            <Box className={getMedalGlowClass(rank)} style={{ transform: 'scale(1.1)' }}>
              <RankingBadge rank={rank as 1 | 2 | 3} size={28} />
            </Box>
          ) : (
            <Text size="sm" weight="bold" color="tertiary" style={{ fontSize: '14px' }}>
              #{rank}
            </Text>
          )}
          {trader.is_new ? (
            <span style={{ fontSize: '9px', fontWeight: 700, color: tokens.colors.accent.primary, lineHeight: 1 }}>NEW</span>
          ) : trader.rank_change != null && trader.rank_change !== 0 ? (
            <span style={{ fontSize: '9px', fontWeight: 700, color: trader.rank_change > 0 ? tokens.colors.accent.success : tokens.colors.accent.error, lineHeight: 1 }}>
              {trader.rank_change > 0 ? `+${trader.rank_change}` : trader.rank_change}
            </span>
          ) : null}
        </Box>

        {/* 交易员 */}
        <Box style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'nowrap', minWidth: 0 }}>
          <div
            className="trader-avatar"
            style={{
              width: '36px', height: '36px', minWidth: '36px', minHeight: '36px',
              borderRadius: '50%', background: getAvatarGradient(trader.id),
              border: '2px solid var(--color-border-primary)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              overflow: 'hidden', flexShrink: 0, position: 'relative',
              boxShadow: rank <= 3 ? `0 0 12px ${rank === 1 ? 'rgba(255, 215, 0, 0.4)' : rank === 2 ? 'rgba(192, 192, 192, 0.4)' : 'rgba(205, 127, 50, 0.4)'}` : 'none',
            }}
          >
            <span style={{ color: '#ffffff', fontSize: '14px', fontWeight: 900, lineHeight: 1, textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}>
              {getAvatarInitial(displayName)}
            </span>
            {(() => {
              const proxyAvatarUrl = getTraderAvatarUrl(trader.avatar_url)
              if (!proxyAvatarUrl) return null

              const rowIndex = rank - 1
              const loadingStrategy = getImageLoadingStrategy(rowIndex, 'above')
              const isPriority = rowIndex < 3

              return (
                <Image
                  src={getOptimizedImageUrl(proxyAvatarUrl, {
                    width: 72,
                    quality: 85,
                    format: 'webp',
                  })}
                  alt={displayName}
                  width={36}
                  height={36}
                  priority={isPriority}
                  loading={loadingStrategy.loading}
                  placeholder="blur"
                  blurDataURL={IMAGE_PLACEHOLDER.avatar}
                  style={{ width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', inset: 0, zIndex: 1 }}
                  onError={handleImageError}
                />
              )
            })()}
          </div>
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
                    background: trader.arena_score >= 60 ? tokens.colors.accent.success : trader.arena_score >= 40 ? tokens.colors.accent.warning : tokens.colors.text.tertiary,
                  }} />
                  <span style={{ fontSize: '11px', fontWeight: 700, color: tokens.colors.text.secondary }}>{trader.arena_score.toFixed(0)}</span>
                </span>
              )}
            </Box>
            <Box style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {(() => {
                const info = parseSourceInfo(trader.source || source || '')
                return (
                  <Box className="source-tag" style={{ background: `${info.typeColor}15`, border: `1px solid ${info.typeColor}30` }}>
                    <Text size="xs" weight="bold" style={{ color: info.typeColor, fontSize: '10px', lineHeight: 1.2 }}>
                      {info.type}
                    </Text>
                  </Box>
                )
              })()}
              {/* Also on other exchanges */}
              {trader.also_on && trader.also_on.length > 0 && (
                <Text size="xs" style={{ fontSize: '9px', color: tokens.colors.text.tertiary, lineHeight: 1.2 }}>
                  also on: {trader.also_on.map(s => s.split('_')[0]).filter((v, i, a) => a.indexOf(v) === i).join(', ')}
                </Text>
              )}
            </Box>
          </Box>
        </Box>

        {/* Arena Score + Score Breakdown Tooltip */}
        <Box className="col-score" style={{ textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
          <Box style={{
            position: 'relative', minWidth: 46, height: 24, borderRadius: tokens.radius.md,
            background: trader.arena_score != null && trader.arena_score >= 60 ? tokens.gradient.successSubtle : trader.arena_score != null && trader.arena_score >= 40 ? tokens.gradient.warningSubtle : tokens.glass.bg.light,
            border: `1px solid ${trader.arena_score != null && trader.arena_score >= 60 ? `${tokens.colors.accent.success}50` : trader.arena_score != null && trader.arena_score >= 40 ? `${tokens.colors.accent.warning}40` : 'rgba(255, 255, 255, 0.15)'}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
          }}>
            {trader.arena_score != null && (
              <Box style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${trader.arena_score}%`, background: trader.arena_score >= 60 ? `${tokens.colors.accent.success}20` : trader.arena_score >= 40 ? `${tokens.colors.accent.warning}20` : `${tokens.colors.accent.primary}15`, transition: 'width 0.3s ease' }} />
            )}
            <Text size="sm" weight="black" style={{ position: 'relative', color: trader.arena_score != null && trader.arena_score >= 60 ? tokens.colors.accent.success : trader.arena_score != null && trader.arena_score >= 40 ? tokens.colors.accent.warning : tokens.colors.text.secondary, fontSize: '12px', lineHeight: 1 }}>
              {trader.arena_score != null ? trader.arena_score.toFixed(1) : '—'}
            </Text>
          </Box>
          <ScoreBreakdownTooltip trader={trader} language={language} />
        </Box>

        {/* ROI */}
        <Box className="roi-cell" style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
          <Text size="md" weight="black" className="roi-value" style={{ color: (trader.roi || 0) >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error, lineHeight: 1.2, fontSize: '16px', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }} title={`${(trader.roi || 0) >= 0 ? '+' : ''}${(trader.roi || 0).toFixed(2)}%`}>
            {formatROI(trader.roi || 0)}
          </Text>
          <Text size="xs" weight="semibold" className="pnl-value" style={{ color: trader.pnl != null ? (trader.pnl >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error) : tokens.colors.text.tertiary, lineHeight: 1.2, fontSize: '12px', opacity: trader.pnl != null ? 0.85 : 0.5, cursor: trader.pnl != null ? 'help' : 'default' }} title={trader.pnl != null ? getPnLTooltipFn(trader.source || source || '', language) : undefined}>
            {trader.pnl != null ? `${trader.pnl >= 0 ? '+' : ''}${formatPnL(trader.pnl)}` : '—'}
          </Text>
        </Box>

        {/* Win% */}
        <Box className="col-winrate" style={{ textAlign: 'right', alignItems: 'center', justifyContent: 'flex-end' }}>
          <Text size="sm" weight="semibold" style={{ color: trader.win_rate != null && trader.win_rate > 0.5 ? tokens.colors.accent.success : tokens.colors.text.secondary, lineHeight: 1, fontSize: '13px' }}>
            {trader.win_rate != null ? `${trader.win_rate.toFixed(0)}%` : '—'}
          </Text>
        </Box>

        {/* MDD */}
        <Box className="col-mdd" style={{ textAlign: 'right', alignItems: 'center', justifyContent: 'flex-end' }}>
          <Text size="sm" weight="semibold" style={{ color: trader.max_drawdown != null ? tokens.colors.accent.error : tokens.colors.text.tertiary, lineHeight: 1, fontSize: '13px', opacity: trader.max_drawdown != null ? 1 : 0.5 }}>
            {trader.max_drawdown != null ? `-${Math.abs(trader.max_drawdown).toFixed(0)}%` : '—'}
          </Text>
        </Box>
      </Box>
    </Link>
  )
}, (prev, next) => {
  return (
    prev.trader.id === next.trader.id &&
    prev.trader.roi === next.trader.roi &&
    prev.trader.arena_score === next.trader.arena_score &&
    prev.trader.pnl === next.trader.pnl &&
    prev.trader.win_rate === next.trader.win_rate &&
    prev.trader.max_drawdown === next.trader.max_drawdown &&
    prev.trader.rank_change === next.trader.rank_change &&
    prev.trader.is_new === next.trader.is_new &&
    prev.rank === next.rank &&
    prev.language === next.language &&
    prev.searchQuery === next.searchQuery
  )
})
