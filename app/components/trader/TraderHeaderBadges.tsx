'use client'

/**
 * TraderHeaderBadges
 *
 * Extracted from TraderHeader.tsx (2026-04-09) to cut the god component down
 * from 731 lines. This file owns the inline badge row that sits next to the
 * trader name: verified / exchange / arena-score / confidence / rank
 * percentile / trading style / bot / data-source / web3 / rank-trend sparkline
 * / linked-exchange cluster.
 *
 * Pure presentation — zero state. All behavior is prop-driven.
 */

import dynamic from 'next/dynamic'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import ExchangeLogo from '../ui/ExchangeLogo'
import { Badge, getSourceCategory } from './TraderHeaderHelpers'
import { getScoreColor, getScoreColorHex } from '@/lib/utils/score-colors'

const Web3VerifiedBadge = dynamic(
  () => import('./Web3VerifiedBadge').then((m) => ({ default: m.Web3VerifiedBadge })),
  { ssr: false },
)
const VerifiedBadge = dynamic(() => import('./VerifiedBadge'), { ssr: false })
const RankTrendSparkline = dynamic(() => import('./RankTrendSparkline'), { ssr: false })
const RankPercentileBadge = dynamic(() => import('./RankPercentileBadge'), { ssr: false })

export interface TraderHeaderBadgesProps {
  source?: string
  isRegistered?: boolean
  isVerifiedTrader?: boolean
  isBot?: boolean
  arenaScore?: number | null
  scoreConfidence?: string | null
  tradesCount?: number | null
  rank?: number | null
  tradingStyle?: string | null
  isAuthorized?: boolean
  dataSource?: 'authorized' | 'public_api' | 'enrichment' | 'historical' | null
  authorizedSince?: string | null
  platform?: string
  traderKey?: string
  linkedPlatforms?: string[]
  t: (key: string) => string
}

const TRADING_STYLE_CONFIG: Record<string, { label: string; icon: string; color: string }> = {
  day_trader: { label: 'Day Trader', icon: '⚡', color: '#60a5fa' },
  swing_trader: { label: 'Swing Trader', icon: '📈', color: '#34d399' },
  scalper: { label: 'Scalper', icon: '⏱', color: '#f472b6' },
  position_trader: { label: 'Position Trader', icon: '🏔', color: '#a78bfa' },
  high_frequency: { label: 'High Frequency', icon: '🔥', color: '#fb923c' },
}

export function TraderHeaderBadges({
  source,
  isRegistered,
  isVerifiedTrader = false,
  isBot = false,
  arenaScore,
  scoreConfidence,
  tradesCount,
  rank,
  tradingStyle,
  isAuthorized = false,
  dataSource,
  authorizedSince,
  platform,
  traderKey,
  linkedPlatforms,
  t,
}: TraderHeaderBadgesProps): React.ReactElement {
  const tradingStyleCfg = tradingStyle && tradingStyle !== 'unknown'
    ? TRADING_STYLE_CONFIG[tradingStyle]
    : undefined

  return (
    <>
      {/* Verified trader checkmark */}
      {isVerifiedTrader && <VerifiedBadge key="verified" size="md" variant="prominent" />}
      {!isVerifiedTrader && isRegistered && (
        <Box
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 20,
            height: 20,
            flexShrink: 0,
            background: `linear-gradient(135deg, ${tokens.colors.accent.success}, ${tokens.colors.accent.success})`,
            borderRadius: tokens.radius.full,
          }}
          title={t('verifiedUser')}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </Box>
      )}

      {/* Exchange badge */}
      {source && EXCHANGE_NAMES[source.toLowerCase()] && (
        <Badge key="exchange" color={tokens.colors.accent.primary}>
          <Text size="xs" weight="bold" style={{ color: tokens.colors.accent.primary, letterSpacing: '0.3px', whiteSpace: 'nowrap' }}>
            {EXCHANGE_NAMES[source.toLowerCase()]}
          </Text>
        </Badge>
      )}

      {/* Arena score */}
      {arenaScore != null && arenaScore > 0 && (
        <Badge key="score" color={getScoreColorHex(arenaScore)} style={{ padding: '2px 8px', flexShrink: 0 }} title={`Arena Score: ${arenaScore.toFixed(1)}`}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={getScoreColor(arenaScore)} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 2 }}>
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
          </svg>
          <Text size="xs" weight="black" style={{ color: getScoreColor(arenaScore), fontFamily: tokens.typography.fontFamily.mono.join(', '), letterSpacing: '-0.02em' }}>
            {arenaScore.toFixed(0)}
          </Text>
        </Badge>
      )}

      {/* Low confidence warning */}
      {scoreConfidence && scoreConfidence !== 'full' && (
        <Badge
          key="confidence"
          color={scoreConfidence === 'minimal' ? tokens.colors.accent.error + '20' : tokens.colors.accent.warning + '20'}
          style={{ padding: '2px 8px', flexShrink: 0, border: `1px solid ${scoreConfidence === 'minimal' ? tokens.colors.accent.error : tokens.colors.accent.warning}40` }}
          title={scoreConfidence === 'minimal'
            ? `Low confidence: only ${tradesCount ?? '?'} trades`
            : `Partial confidence: limited trade history`}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={scoreConfidence === 'minimal' ? tokens.colors.accent.error : tokens.colors.accent.warning} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 2 }}>
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <Text size="xs" weight="bold" style={{ color: scoreConfidence === 'minimal' ? tokens.colors.accent.error : tokens.colors.accent.warning }}>
            {tradesCount != null && tradesCount < 10
              ? `${tradesCount} trades`
              : scoreConfidence === 'minimal' ? 'Low data' : 'Partial'}
          </Text>
        </Badge>
      )}

      {/* Rank Percentile Badge */}
      {rank != null && rank > 0 && source && (
        <RankPercentileBadge rank={rank} platform={source} />
      )}

      {/* Trading Style Tag */}
      {tradingStyleCfg && (
        <Badge
          key="trading-style"
          color={`${tradingStyleCfg.color}20`}
          style={{ padding: '2px 8px', flexShrink: 0, border: `1px solid ${tradingStyleCfg.color}40` }}
          title={tradingStyleCfg.label}
        >
          <span style={{ fontSize: 10, marginRight: 2 }}>{tradingStyleCfg.icon}</span>
          <Text size="xs" weight="bold" style={{ color: tradingStyleCfg.color, fontSize: 11, letterSpacing: '0.3px' }}>
            {tradingStyleCfg.label}
          </Text>
        </Badge>
      )}

      {/* Bot badge */}
      {isBot && (
        <Badge key="bot" color="var(--color-brand)" style={{ padding: '2px 8px', flexShrink: 0 }} title={t('botTooltip')}>
          <span style={{ fontSize: 11, marginRight: 2 }}>{'⚡'}</span>
          <Text size="xs" weight="bold" style={{ color: 'var(--color-brand)' }}>{t('botLabel')}</Text>
        </Badge>
      )}

      {/* Data Source Badge: Verified (blue) vs Public (gray) */}
      {(isAuthorized || dataSource === 'authorized') && (
        <Badge
          key="data-source"
          color={tokens.colors.accent.primary}
          style={{ padding: '2px 8px', flexShrink: 0 }}
          title={authorizedSince
            ? `${t('dataSourceVerifiedTooltip')} · ${t('verifiedSince')} ${new Date(authorizedSince).toLocaleDateString()}`
            : t('dataSourceVerifiedTooltip')
          }
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.accent.primary} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 2 }}>
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          <Text size="xs" weight="bold" style={{ color: tokens.colors.accent.primary, letterSpacing: '0.3px' }}>
            {t('dataSourceVerified')}
          </Text>
        </Badge>
      )}
      {!isAuthorized && dataSource !== 'authorized' && dataSource && (
        <Badge
          key="data-source-public"
          color={tokens.colors.text.tertiary}
          style={{ padding: '2px 8px', flexShrink: 0 }}
          title={t('dataSourcePublicTooltip')}
        >
          <Text size="xs" weight="bold" style={{ color: tokens.colors.text.tertiary, letterSpacing: '0.3px' }}>
            {t('dataSourcePublic')}
          </Text>
        </Badge>
      )}

      {/* Web3 verified badge */}
      {getSourceCategory(source) === 'web3' && <Web3VerifiedBadge key="web3" size="sm" />}

      {/* Arena Score 30D trend sparkline */}
      {platform && traderKey && (
        <RankTrendSparkline platform={platform} traderKey={traderKey} width={100} height={28} />
      )}

      {/* Linked exchange badges for multi-account users */}
      {linkedPlatforms && linkedPlatforms.length >= 2 && (
        <Box
          key="linked-exchanges"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 2,
            marginLeft: 4,
            padding: '2px 6px',
            background: 'var(--color-accent-primary-08)',
            borderRadius: tokens.radius.full,
            border: '1px solid var(--color-accent-primary-15)',
          }}
          title={`${linkedPlatforms.length} linked accounts`}
        >
          {[...new Set(linkedPlatforms)].slice(0, 5).map((p) => (
            <Box key={p} style={{ width: 14, height: 14, borderRadius: '50%', overflow: 'hidden', flexShrink: 0 }}>
              <ExchangeLogo exchange={p} size={14} />
            </Box>
          ))}
          {[...new Set(linkedPlatforms)].length > 5 && (
            <Text size="xs" style={{ color: tokens.colors.text.tertiary, fontSize: 10 }}>
              +{[...new Set(linkedPlatforms)].length - 5}
            </Text>
          )}
        </Box>
      )}
    </>
  )
}
