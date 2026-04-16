'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import dynamic from 'next/dynamic'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import { Box, Text } from '../base'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import { formatDisplayName } from '@/app/components/ranking/utils'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import {
  formatAum, getActiveDays, formatActiveDays,
} from './TraderHeaderHelpers'
import { TraderHeaderBadges } from './TraderHeaderBadges'
import { TraderHeaderAvatar } from './TraderHeaderAvatar'
import { TraderHeaderActions } from './TraderHeaderActions'

// Lazy-load rarely-used components
const _OnChainBadge = dynamic(() => import('./OnChainBadge').then(m => ({ default: m.OnChainBadge })), { ssr: false })
const _BadgeDisplay = dynamic(() => import('./BadgeDisplay').then(m => ({ default: m.BadgeDisplay })), { ssr: false })

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
// Avatar block extracted to ./TraderHeaderAvatar.tsx
// Action buttons block extracted to ./TraderHeaderActions.tsx (incl. CompareToggle)
// Exchange links (copy-trade, DEX view, referral) moved to ExchangeLinksBar below header

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
  // getActiveDays() calls new Date() so its output depends on wall-clock time.
  // Running it during SSR risks a server/client hydration mismatch whenever the
  // render crosses a day boundary. Only compute it after mount — before that
  // the activeSince subtitle item is simply omitted on the server, which is
  // harmless because the parts array is joined with a separator.
  const activeDays = mounted ? getActiveDays(activeSince) : null

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
        <TraderHeaderAvatar
          traderId={traderId}
          handle={handle}
          avatarUrl={avatarUrl}
          claimedAvatarUrl={claimedAvatarUrl}
          proBadgeTier={proBadgeTier}
        />

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

            {/* Inline badges: verified + exchange + score + confidence + rank
             * percentile + trading style + bot + data-source + web3 + trend
             * sparkline + linked exchanges. Extracted to TraderHeaderBadges.tsx. */}
            <TraderHeaderBadges
              source={source}
              isRegistered={isRegistered}
              isVerifiedTrader={isVerifiedTrader}
              isBot={isBot}
              arenaScore={arenaScore}
              scoreConfidence={scoreConfidence}
              tradesCount={tradesCount}
              rank={rank}
              tradingStyle={tradingStyle}
              isAuthorized={isAuthorized}
              dataSource={dataSource}
              authorizedSince={authorizedSince}
              platform={platform}
              traderKey={traderKey}
              linkedPlatforms={linkedPlatforms}
              t={t}
            />
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
      <TraderHeaderActions
        traderId={traderId}
        handle={handle}
        source={source}
        displayName={displayNameProp}
        effectiveAvatarUrl={effectiveAvatarUrl}
        isOwnProfile={isOwnProfile}
        isRegistered={isRegistered}
        userId={userId}
        rank={rank}
        roi90d={roi90d}
        arenaScore={arenaScore}
        onFollowChange={(delta) => setFollowerCount(prev => Math.max(0, prev + delta))}
      />

    </Box>
  )
}
