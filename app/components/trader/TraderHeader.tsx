'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Image from 'next/image'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import { Box, Text } from '../base'
import { getAvatarGradient, getAvatarInitial, isWalletAddress, generateBlockieSvg } from '@/lib/utils/avatar'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import { formatDisplayName } from '@/app/components/ranking/utils'
import { ProBadgeOverlay } from '../ui/ProBadge'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import ExchangeLogo from '../ui/ExchangeLogo'
import TraderFollowButton from '../ui/TraderFollowButton'
import WatchlistToggleButton from './WatchlistToggleButton'
import UserFollowButton from '../ui/UserFollowButton'
import ShareButton from '../common/ShareButton'
import ShareRankCardButtons from './ShareRankCardButtons'
import {
  getSourceCategory,
  formatAum, getActiveDays, formatActiveDays,
  Badge, ActionButton,
} from './TraderHeaderHelpers'
import { getScoreColor, getScoreColorHex } from '@/lib/utils/score-colors'
import { useComparisonStore } from '@/lib/stores'

// Lazy-load rarely-used components
const _OnChainBadge = dynamic(() => import('./OnChainBadge').then(m => ({ default: m.OnChainBadge })), { ssr: false })
const Web3VerifiedBadge = dynamic(() => import('./Web3VerifiedBadge').then(m => ({ default: m.Web3VerifiedBadge })), { ssr: false })
const _BadgeDisplay = dynamic(() => import('./BadgeDisplay').then(m => ({ default: m.BadgeDisplay })), { ssr: false })
const VerifiedBadge = dynamic(() => import('./VerifiedBadge'), { ssr: false })
const RankTrendSparkline = dynamic(() => import('./RankTrendSparkline'), { ssr: false })
const RankPercentileBadge = dynamic(() => import('./RankPercentileBadge'), { ssr: false })

interface TraderHeaderProps {
  handle: string
  displayName?: string
  traderId: string
  uid?: number
  avatarUrl?: string
  coverUrl?: string
  isRegistered?: boolean
  followers?: number
  following?: number
  aum?: number
  isOwnProfile?: boolean
  source?: string
  proBadgeTier?: 'pro' | null
  isPro?: boolean
  activeSince?: string
  roi90d?: number
  maxDrawdown?: number
  winRate?: number
  /** Arena Score for display in header */
  arenaScore?: number | null
  /** Score confidence level — 'full', 'partial', or 'minimal' */
  scoreConfidence?: string | null
  /** Total trades count — shown as warning when very low */
  tradesCount?: number | null
  /** Leaderboard rank for the Share on X wrapped card */
  rank?: number | null
  /** Pre-fetched current user ID to avoid duplicate auth calls */
  currentUserId?: string | null
  /** Whether this trader has been claimed and verified */
  isVerifiedTrader?: boolean
  /** Whether this trader is a bot/AI agent */
  isBot?: boolean
  /** Last data update timestamp (ISO string) for "Updated X ago" display */
  lastUpdated?: string | null
  /** Platform for rank trend API */
  platform?: string
  /** Trader key for rank trend API */
  traderKey?: string
  /** Bio from claimed user profile */
  claimedBio?: string | null
  /** Avatar URL from claimed user profile (preferred over exchange avatar) */
  claimedAvatarUrl?: string | null
  /** Number of linked accounts (for multi-account users) */
  linkedAccountCount?: number
  /** Platforms of linked accounts (for showing exchange badges) */
  linkedPlatforms?: string[]
  /** External profile URL on the exchange */
  profileUrl?: string | null
  /** Data source type: 'authorized' | 'public_api' | 'enrichment' | 'historical' */
  dataSource?: 'authorized' | 'public_api' | 'enrichment' | 'historical' | null
  /** Whether this trader has an active authorization (API key or wallet bound) */
  isAuthorized?: boolean
  /** When the authorization was last verified */
  authorizedSince?: string | null
  /** Trading style classification (day_trader, swing_trader, scalper, etc.) */
  tradingStyle?: string | null
}

// Helpers extracted to ./TraderHeaderHelpers.tsx
// Exchange links (copy-trade, DEX view, referral) moved to ExchangeLinksBar below header


/** Reactive Compare toggle button (P0-4) */
function CompareToggle({ traderId, handle, source, avatarUrl }: { traderId: string; handle: string; source: string; avatarUrl?: string }) {
  const isSelected = useComparisonStore(s => s.isSelected(traderId))
  const addTrader = useComparisonStore(s => s.addTrader)
  const removeTrader = useComparisonStore(s => s.removeTrader)
  const canAddMore = useComparisonStore(s => s.canAddMore())
  const { t } = useLanguage()

  const handleToggle = () => {
    if (isSelected) {
      removeTrader(traderId)
    } else {
      addTrader({ id: traderId, handle, source, avatarUrl })
    }
  }

  const label = isSelected ? (t('comparing') || 'Comparing') : (t('compare') || 'Compare')
  const titleText = isSelected
    ? (t('removeFromCompare') || 'Remove from Compare')
    : !canAddMore
      ? (t('compareListFull') || 'Compare list full (max 10)')
      : (t('addToCompare') || 'Add to Compare')

  return (
    <ActionButton
      onClick={handleToggle}
      variant={isSelected ? 'accent' : 'ghost'}
      icon={
        isSelected ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )
      }
    >
      <span title={titleText} style={{ opacity: (!isSelected && !canAddMore) ? 0.5 : 1 }}>
        {label}
      </span>
    </ActionButton>
  )
}

export default function TraderHeader({
  handle,
  displayName: displayNameProp,
  traderId,
  uid: _uid,
  avatarUrl,
  coverUrl,
  isRegistered,
  followers = 0,
  following: _following = 0,
  aum,
  isOwnProfile = false,
  source,
  proBadgeTier,
  isPro: _isPro = false,
  activeSince,
  roi90d,
  maxDrawdown: _maxDrawdown,
  winRate: _winRate,
  arenaScore,
  scoreConfidence,
  tradesCount,
  rank,
  currentUserId: externalUserId,
  isVerifiedTrader = false,
  isBot = false,
  lastUpdated,
  claimedBio,
  claimedAvatarUrl,
  linkedAccountCount,
  linkedPlatforms,
  platform,
  traderKey,
  profileUrl: _profileUrl,
  dataSource,
  isAuthorized = false,
  authorizedSince,
  tradingStyle,
}: TraderHeaderProps): React.ReactElement {
  const [userId, setUserId] = useState<string | null>(externalUserId ?? null)
  const [mounted, setMounted] = useState(false)
  const [avatarHovered, setAvatarHovered] = useState(false)
  const [avatarError, setAvatarError] = useState(false)
  const [followerCount, setFollowerCount] = useState(followers)
  // #34: Track follower count changes for animation
  const [followerAnimating, setFollowerAnimating] = useState(false)
  const prevFollowerCountRef = useRef(followers)
  useEffect(() => {
    if (followerCount !== prevFollowerCountRef.current) {
      prevFollowerCountRef.current = followerCount
      setFollowerAnimating(true)
      const timer = setTimeout(() => setFollowerAnimating(false), 300)
      return () => clearTimeout(timer)
    }
  }, [followerCount])
  const [_badgesExpanded, _setBadgesExpanded] = useState(false)
  const [_moreMenuOpen, _setMoreMenuOpen] = useState(false)
  const router = useRouter()
  const [handleCopied, setHandleCopied] = useState(false)
  const { t } = useLanguage()
  const { showToast: _showToast } = useToast()

  // Relative time formatting for "Updated X ago"
  const getRelativeTime = (iso: string): string => {
    const ts = new Date(iso).getTime()
    if (!Number.isFinite(ts)) return ''
    const diff = Date.now() - ts
    if (diff < 0) return t('justNow') || 'just now'
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return t('justNow') || 'just now'
    if (mins < 60) return t('minutesAgoShort').replace('{n}', String(mins))
    const hours = Math.floor(mins / 60)
    if (hours < 24) return t('hoursAgoShort').replace('{n}', String(hours))
    const days = Math.floor(hours / 24)
    return t('daysAgoShort').replace('{n}', String(days))
  }

  const copyHandle = useCallback(() => {
    navigator.clipboard.writeText(handle).then(() => {
      setHandleCopied(true)
      setTimeout(() => setHandleCopied(false), 2000)
      _showToast(t('copiedToClipboard'), 'success', 2000)
    }).catch(() => {
      _showToast(t('copyFailed') || 'Copy failed', 'error', 2000)
    })
  }, [handle, _showToast, t])

  useEffect(() => {
    setMounted(true)
    // Skip auth call if userId was passed from parent
    if (externalUserId !== undefined) {
      setUserId(externalUserId)
      return
    }
     
    supabase.auth.getUser().then(({ data }) => {
      setUserId(data.user?.id ?? null)
    }).catch(() => { /* Intentionally swallowed: auth check non-critical for trader header */ }) // eslint-disable-line no-restricted-syntax -- intentional fire-and-forget
  }, [externalUserId])

  // Prefer claimed user avatar over exchange avatar
  const effectiveAvatarUrl = claimedAvatarUrl || avatarUrl
  const hasCover = Boolean(coverUrl)
  const activeDays = getActiveDays(activeSince)

  const containerBackground = hasCover
    ? `linear-gradient(to bottom, var(--color-overlay-subtle) 0%, var(--color-backdrop) 100%), url(${coverUrl}) center/cover no-repeat`
    : `linear-gradient(135deg, ${tokens.colors.bg.secondary}F8 0%, ${tokens.colors.bg.primary}E8 100%)`

  // Build subtitle parts for the second line
  const subtitleParts: string[] = []
  if (linkedAccountCount && linkedAccountCount >= 2) {
    subtitleParts.push(`${linkedAccountCount} ${t('verifiedAccounts') || 'verified accounts'}`)
  }
  if (followerCount > 0) subtitleParts.push(`${followerCount.toLocaleString('en-US')} ${t('arenaFollowers') || 'followers'}`)
  // copiers removed — only show platform internal followers
  if (aum !== undefined && aum > 0) subtitleParts.push(`${t('aumLabel') || 'AUM'} ${formatAum(aum)}`)
  if (activeDays !== null && activeDays >= 7) subtitleParts.push(formatActiveDays(activeDays, t))
  if (rank != null && rank > 0 && source && EXCHANGE_NAMES[source.toLowerCase()]) {
    subtitleParts.push(t('rankedOnExchange')
      .replace('{rank}', rank.toLocaleString('en-US'))
      .replace('{exchange}', EXCHANGE_NAMES[source.toLowerCase()] || source))
  }

  return (
    <Box
      className="profile-header"
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: tokens.spacing[4],
        padding: `${tokens.spacing[4]} ${tokens.spacing[5]}`,
        background: containerBackground,
        borderRadius: tokens.radius.lg,
        border: '1px solid var(--color-border-primary)',
        boxShadow: '0 4px 16px var(--color-overlay-subtle), inset 0 1px 0 var(--overlay-hover)',
        position: 'relative',
        overflow: 'visible',
        opacity: mounted ? 1 : 0,
        transition: 'opacity 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
      }}
    >
      {/* Profile Info — compact single-row layout */}
      <Box
        className="profile-header-info"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[3],
          flex: 1,
          minWidth: 0,
          position: 'relative',
          zIndex: 1,
        }}
      >
        {/* Avatar — compact 48px, scrolls to top on click */}
        <Box
          style={{ position: 'relative', flexShrink: 0, cursor: 'pointer' }}
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          onMouseEnter={() => setAvatarHovered(true)}
          onMouseLeave={() => setAvatarHovered(false)}
        >
          <Box
            className="profile-header-avatar"
            style={{
              width: 48,
              height: 48,
              borderRadius: tokens.radius.full,
              background: effectiveAvatarUrl ? tokens.colors.bg.secondary : getAvatarGradient(traderId),
              border: `2px solid ${avatarHovered ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
              display: 'grid',
              placeItems: 'center',
              fontWeight: tokens.typography.fontWeight.black,
              fontSize: tokens.typography.fontSize.base,
              color: tokens.colors.white,
              overflow: 'hidden',
              boxShadow: avatarHovered
                ? `0 4px 16px var(--color-accent-primary-40)`
                : `0 2px 8px var(--color-overlay-light)`,
              transition: 'all 0.3s ease',
              transform: avatarHovered ? 'scale(1.05)' : 'scale(1)',
              cursor: 'pointer',
            }}
          >
            {effectiveAvatarUrl && !avatarError ? (
              <Image
                src={`/api/avatar?url=${encodeURIComponent(effectiveAvatarUrl)}`}
                alt={handle}
                width={48}
                height={48}
                sizes="(max-width: 640px) 40px, 48px"
                priority
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                onError={() => setAvatarError(true)}
              />
            ) : isWalletAddress(traderId) ? (
              <img
                src={generateBlockieSvg(traderId, 96)}
                alt={handle}
                width={48}
                height={48}
                style={{ width: '100%', height: '100%', objectFit: 'cover', imageRendering: 'pixelated' }}
              />
            ) : (
              <Text weight="black" style={{ color: tokens.colors.white, fontSize: '20px', lineHeight: '1' }}>
                {getAvatarInitial(handle)}
              </Text>
            )}
          </Box>
          {proBadgeTier === 'pro' && <ProBadgeOverlay position="bottom-right" />}
        </Box>

        {/* Name + badges + subtitle */}
        <Box style={{ flex: 1, minWidth: 0 }}>
          {/* Line 1: Name + exchange badge + score badge */}
          <Box className="trader-name-badges-row" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Text
              as="h1"
              size="lg"
              weight="black"
              className="trader-name-truncate"
              style={{
                color: hasCover ? tokens.colors.white : tokens.colors.text.primary,
                lineHeight: 1.2,
                textShadow: hasCover ? '0 1px 4px var(--color-overlay-dark)' : undefined,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flexShrink: 1,
                minWidth: 0,
              }}
            >
              {displayNameProp || formatDisplayName(handle, source)}
            </Text>

            <button
              onClick={copyHandle}
              title={handleCopied ? t('copiedToClipboard') : `${t('copyHandle')}: ${handle}`}
              aria-label={handleCopied ? t('copiedToClipboard') : `${t('copyHandle')}: ${handle}`}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                padding: 4, minWidth: 44, minHeight: 44,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                color: handleCopied ? tokens.colors.accent.success : tokens.colors.text.tertiary,
                transition: 'color 0.2s ease', flexShrink: 0,
              }}
            >
              {handleCopied ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>

            {/* Inline badges: verified + exchange + score + bot */}
            {isVerifiedTrader && <VerifiedBadge key="verified" size="md" variant="prominent" />}
            {!isVerifiedTrader && isRegistered && (
              <Box
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 20, height: 20, flexShrink: 0,
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

            {source && EXCHANGE_NAMES[source.toLowerCase()] && (
              <Badge key="exchange" color={tokens.colors.accent.primary}>
                <Text size="xs" weight="bold" style={{ color: tokens.colors.accent.primary, letterSpacing: '0.3px', whiteSpace: 'nowrap' }}>
                  {EXCHANGE_NAMES[source.toLowerCase()]}
                </Text>
              </Badge>
            )}

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

            {/* Low confidence warning — prominently shown when score is based on few trades */}
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
            {tradingStyle && tradingStyle !== 'unknown' && (() => {
              const styleConfig: Record<string, { label: string; icon: string; color: string }> = {
                day_trader: { label: 'Day Trader', icon: '⚡', color: '#60a5fa' },
                swing_trader: { label: 'Swing Trader', icon: '📈', color: '#34d399' },
                scalper: { label: 'Scalper', icon: '⏱', color: '#f472b6' },
                position_trader: { label: 'Position Trader', icon: '🏔', color: '#a78bfa' },
                high_frequency: { label: 'High Frequency', icon: '🔥', color: '#fb923c' },
              }
              const cfg = styleConfig[tradingStyle]
              if (!cfg) return null
              return (
                <Badge
                  key="trading-style"
                  color={`${cfg.color}20`}
                  style={{ padding: '2px 8px', flexShrink: 0, border: `1px solid ${cfg.color}40` }}
                  title={cfg.label}
                >
                  <span style={{ fontSize: 10, marginRight: 2 }}>{cfg.icon}</span>
                  <Text size="xs" weight="bold" style={{ color: cfg.color, fontSize: 11, letterSpacing: '0.3px' }}>
                    {cfg.label}
                  </Text>
                </Badge>
              )
            })()}

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
          </Box>

          {/* Line 2: Subtitle — followers, copiers, rank, updated */}
          {(subtitleParts.length > 0 || lastUpdated) && (
            <Box style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2, flexWrap: 'wrap' }}>
              {subtitleParts.length > 0 && (
                <Text size="xs" style={{
                  color: hasCover ? 'rgba(255,255,255,0.7)' : tokens.colors.text.tertiary,
                  fontSize: 12, lineHeight: 1.3,
                  // #34: Brief scale animation when follower count changes
                  transition: 'transform 0.3s ease',
                  transform: followerAnimating ? 'scale(1.08)' : 'scale(1)',
                }}>
                  {subtitleParts.join(' · ')}
                </Text>
              )}
              {lastUpdated && (
                <Text
                  size="xs"
                  style={{ color: tokens.colors.text.tertiary, fontSize: 11, opacity: 0.6 }}
                  title={new Date(lastUpdated).toLocaleString()}
                >
                  {subtitleParts.length > 0 ? ' · ' : ''}{t('updated') || 'Updated'} {getRelativeTime(lastUpdated)}
                </Text>
              )}
            </Box>
          )}

          {/* Bio — from claimed user or exchange profile */}
          {claimedBio && claimedBio !== 'null' && claimedBio !== 'undefined' && (
            <Text size="xs" color="secondary" style={{ marginTop: 2, maxWidth: 400, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {claimedBio}
            </Text>
          )}
        </Box>
      </Box>

      {/* Action buttons — Follow + Share (exchange links moved to ExchangeLinksBar below) */}
      <Box
        className="profile-header-actions action-buttons"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexShrink: 0,
          position: 'relative',
          zIndex: 1,
        }}
      >
        {isOwnProfile && (
          <ActionButton
            onClick={() => router.push('/settings')}
            variant="accent"
            icon={
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            }
          >
            {t('editProfile')}
          </ActionButton>
        )}

        {/* Follow icon */}
        {!isOwnProfile && userId && (
          isRegistered ? (
            <UserFollowButton targetUserId={traderId} currentUserId={userId} size="sm" />
          ) : (
            <TraderFollowButton
              traderId={traderId}
              userId={userId}
              onFollowChange={(isFollowing) => {
                setFollowerCount(prev => isFollowing ? prev + 1 : Math.max(0, prev - 1))
              }}
            />
          )
        )}

        {/* Watchlist star */}
        {source && (
          <WatchlistToggleButton
            source={source}
            sourceTraderID={traderId}
            handle={handle}
          />
        )}

        {/* Compare toggle (P0-4) */}
        {!isOwnProfile && (
          <CompareToggle
            traderId={traderId}
            handle={handle}
            source={source || ''}
            avatarUrl={effectiveAvatarUrl}
          />
        )}

        {/* Share rank card buttons (Copy Link + Share on X) */}
        <ShareRankCardButtons
          handle={handle}
          displayName={displayNameProp || formatDisplayName(handle, source)}
          platform={source}
          rank={rank}
          roi={roi90d}
          arenaScore={arenaScore}
        />

        {/* Share dropdown (Telegram, WhatsApp, etc.) */}
        <ShareButton
          data={{
            type: 'trader',
            url: typeof window !== 'undefined' ? window.location.href : `https://www.arenafi.org/trader/${encodeURIComponent(handle)}`,
            traderName: displayNameProp || formatDisplayName(handle, source),
            roi: roi90d,
            period: '90D',
          }}
          size="sm"
          variant="ghost"
          showLabel={false}
        />
      </Box>

    </Box>
  )
}
