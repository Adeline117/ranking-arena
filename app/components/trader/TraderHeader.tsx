'use client'

import { useState, useEffect, useCallback } from 'react'
import Image from 'next/image'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import { Box, Text } from '../base'
import CopyTradeButton from './CopyTradeButton'
import { getAvatarGradient, getAvatarInitial, isWalletAddress, generateBlockieSvg } from '@/lib/utils/avatar'
import { EXCHANGE_NAMES, EXCHANGE_CONFIG } from '@/lib/constants/exchanges'
import { formatDisplayName } from '@/app/components/ranking/utils'
import { ProBadgeOverlay } from '../ui/ProBadge'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import TraderFollowButton from '../ui/TraderFollowButton'
import UserFollowButton from '../ui/UserFollowButton'
import ShareButton from '../common/ShareButton'
import ShareOnXButton from './ShareOnXButton'
import {
  SOURCE_CONFIG, getSourceCategory, CATEGORY_I18N_KEYS, CATEGORY_COLORS,
  getTradingStyleTags, formatAum, getActiveDays, formatActiveDays,
  Badge, StatItem, ActionButton,
} from './TraderHeaderHelpers'
import { getScoreColor, getScoreColorHex } from '@/lib/utils/score-colors'

// Lazy-load rarely-used components
const ClaimTraderButton = dynamic(() => import('./ClaimTraderButton'), { ssr: false })
const OnChainBadge = dynamic(() => import('./OnChainBadge').then(m => ({ default: m.OnChainBadge })), { ssr: false })
const Web3VerifiedBadge = dynamic(() => import('./Web3VerifiedBadge').then(m => ({ default: m.Web3VerifiedBadge })), { ssr: false })
const BadgeDisplay = dynamic(() => import('./BadgeDisplay').then(m => ({ default: m.BadgeDisplay })), { ssr: false })
const VerifiedBadge = dynamic(() => import('./VerifiedBadge'), { ssr: false })

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
  copiers?: number
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
  /** Bio from claimed user profile */
  claimedBio?: string | null
  /** Avatar URL from claimed user profile (preferred over exchange avatar) */
  claimedAvatarUrl?: string | null
}

// Helpers extracted to ./TraderHeaderHelpers.tsx

interface CopyTradeSectionProps {
  isPro: boolean
  traderId: string
  source?: string
  handle: string
  router: ReturnType<typeof useRouter>
  t: (key: string) => string
}

function CopyTradeSection({ isPro: _isPro, traderId, source, handle, router: _router, t: _t }: CopyTradeSectionProps): React.ReactElement {
  return <CopyTradeButton traderId={traderId} source={source} traderHandle={handle} />
}

export default function TraderHeader({
  handle,
  displayName: displayNameProp,
  traderId,
  uid,
  avatarUrl,
  coverUrl,
  isRegistered,
  followers = 0,
  following = 0,
  copiers,
  aum,
  isOwnProfile = false,
  source,
  proBadgeTier,
  isPro = false,
  activeSince,
  roi90d,
  maxDrawdown,
  winRate,
  arenaScore,
  rank,
  currentUserId: externalUserId,
  isVerifiedTrader = false,
  isBot = false,
  lastUpdated,
  claimedBio,
  claimedAvatarUrl,
}: TraderHeaderProps): React.ReactElement {
  const [userId, setUserId] = useState<string | null>(externalUserId ?? null)
  const [mounted, setMounted] = useState(false)
  const [avatarHovered, setAvatarHovered] = useState(false)
  const [avatarError, setAvatarError] = useState(false)
  const [followerCount, setFollowerCount] = useState(followers)
  const [badgesExpanded, setBadgesExpanded] = useState(false)
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const router = useRouter()
  const [handleCopied, setHandleCopied] = useState(false)
  const { t } = useLanguage()
  const { showToast: _showToast } = useToast()

  // Relative time formatting for "Updated X ago"
  const getRelativeTime = (iso: string): string => {
    const diff = Date.now() - new Date(iso).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return t('justNow') || 'just now'
    if (mins < 60) return `${mins}m ago`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    return `${days}d ago`
  }

  const copyHandle = useCallback(() => {
    navigator.clipboard.writeText(handle).then(() => {
      setHandleCopied(true)
      setTimeout(() => setHandleCopied(false), 2000)
    }).catch(() => { // eslint-disable-line no-restricted-syntax -- intentional fire-and-forget
      // fallback
    })
  }, [handle])

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
  const sourceLabelKey = source ? SOURCE_CONFIG[source.toLowerCase()] : null
  const sourceLabel = sourceLabelKey ? t(sourceLabelKey) : null
  const hasCover = Boolean(coverUrl)
  const activeDays = getActiveDays(activeSince)
  const tags = getTradingStyleTags(t, source, roi90d, maxDrawdown, winRate)
  const iconStroke = hasCover ? 'var(--glass-bg-light)' : tokens.colors.text.tertiary

  const containerBackground = hasCover
    ? `linear-gradient(to bottom, var(--color-overlay-subtle) 0%, var(--color-backdrop) 100%), url(${coverUrl}) center/cover no-repeat`
    : `linear-gradient(135deg, ${tokens.colors.bg.secondary}F8 0%, ${tokens.colors.bg.primary}E8 100%)`

  return (
    <Box
      className="profile-header"
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        marginBottom: tokens.spacing[6],
        padding: tokens.spacing[6],
        background: containerBackground,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}50`,
        boxShadow: '0 8px 32px var(--color-overlay-subtle), inset 0 1px 0 var(--overlay-hover)',
        position: 'relative',
        overflow: 'visible',
        opacity: mounted ? 1 : 0,
        transition: 'opacity 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
      }}
    >
      {!hasCover && (
        <Box style={{ position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: tokens.radius.xl, pointerEvents: 'none' }}>
          <Box
            style={{
              position: 'absolute',
              top: -100,
              left: -100,
              width: 300,
              height: 300,
              background: `radial-gradient(circle, ${tokens.colors.accent.primary}08 0%, transparent 70%)`,
            }}
          />
          <Box
            style={{
              position: 'absolute',
              bottom: -80,
              right: -80,
              width: 200,
              height: 200,
              background: `radial-gradient(circle, ${tokens.colors.accent.brand}06 0%, transparent 70%)`,
            }}
          />
        </Box>
      )}
      
      {/* Profile Info */}
      <Box
        className="profile-header-info"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[5],
          flex: 1,
          position: 'relative',
          zIndex: 1,
        }}
      >
        {/* Avatar with Pro Badge wrapper */}
        <Box
          style={{
            position: 'relative',
            flexShrink: 0,
          }}
          onMouseEnter={() => setAvatarHovered(true)}
          onMouseLeave={() => setAvatarHovered(false)}
        >
          <Box
            className="profile-header-avatar"
            style={{
              width: 72,
              height: 72,
              borderRadius: tokens.radius.full,
              background: effectiveAvatarUrl ? tokens.colors.bg.secondary : getAvatarGradient(traderId),
              border: `3px solid ${avatarHovered ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
              display: 'grid',
              placeItems: 'center',
              fontWeight: tokens.typography.fontWeight.black,
              fontSize: tokens.typography.fontSize.xl,
              color: tokens.colors.white,
              overflow: 'hidden',
              boxShadow: avatarHovered
                ? `0 8px 32px var(--color-accent-primary-40), 0 0 0 4px ${tokens.colors.accent.primary}20`
                : `0 4px 16px var(--color-overlay-light)`,
              transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
              transform: avatarHovered ? 'scale(1.08)' : 'scale(1)',
              cursor: 'pointer',
            }}
          >
            {effectiveAvatarUrl && !avatarError ? (
              <Image
                src={`/api/avatar?url=${encodeURIComponent(effectiveAvatarUrl)}`}
                alt={handle}
                width={72}
                height={72}
                sizes="(max-width: 640px) 56px, 72px"
                priority
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  transition: 'all 0.4s ease',
                }}
                onError={() => setAvatarError(true)}
              />
            ) : isWalletAddress(traderId) ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={generateBlockieSvg(traderId, 144)}
                alt={handle}
                width={72}
                height={72}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  imageRendering: 'pixelated',
                }}
              />
            ) : (
              <Text
                size="2xl"
                weight="black"
                style={{
                  color: tokens.colors.white,
                  textShadow: 'var(--text-shadow-md)',
                  fontSize: '32px',
                  lineHeight: '1',
                }}
              >
                {getAvatarInitial(handle)}
              </Text>
            )}
          </Box>
          {/* Pro badge positioned outside avatar to avoid overflow:hidden clipping */}
          {proBadgeTier === 'pro' && (
            <ProBadgeOverlay position="bottom-right" />
          )}
        </Box>

        {/* Info */}
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Box className="trader-name-badges-row" style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[2], flexWrap: 'wrap' }}>
            <Text
              size="2xl"
              weight="black"
              className="trader-name-truncate"
              style={{
                color: hasCover ? tokens.colors.white : tokens.colors.text.primary,
                lineHeight: tokens.typography.lineHeight.tight,
                textShadow: hasCover ? '0 2px 8px var(--color-overlay-dark)' : undefined,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: '100%',
              }}
            >
              {displayNameProp || formatDisplayName(handle, source)}
            </Text>

            <button
              onClick={copyHandle}
              title={handleCopied ? t('copiedToClipboard') : `${t('copyHandle')}: ${handle}`}
              aria-label={handleCopied ? t('copiedToClipboard') : `${t('copyHandle')}: ${handle}`}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 8,
                minWidth: 44,
                minHeight: 44,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: handleCopied ? tokens.colors.accent.success : tokens.colors.text.tertiary,
                transition: 'color 0.2s ease',
                flexShrink: 0,
              }}
            >
              {handleCopied ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>

            {/* Badges container — collapses on mobile with +N more */}
            {(() => {
              const allBadges: React.ReactNode[] = []

              // Priority 1: Verified/Score/Bot/Exchange (always visible on mobile)
              if (isVerifiedTrader) {
                allBadges.push(<VerifiedBadge key="verified" size="md" variant="prominent" />)
              } else if (isRegistered) {
                allBadges.push(
                  <Box
                    key="registered"
                    style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      width: 22, height: 22,
                      background: `linear-gradient(135deg, ${tokens.colors.accent.success}, ${tokens.colors.accent.success})`,
                      borderRadius: tokens.radius.full,
                      boxShadow: `0 2px 8px ${tokens.colors.accent.success}40`,
                    }}
                    title={t('verifiedUser')}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </Box>
                )
              }

              if (arenaScore != null && arenaScore > 0) {
                allBadges.push(
                  <Badge key="score" color={getScoreColorHex(arenaScore)} style={{ padding: '3px 10px' }} title={`Arena Score: ${arenaScore.toFixed(1)}`}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={getScoreColor(arenaScore)} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 3 }}>
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                    </svg>
                    <Text size="xs" weight="black" style={{ color: getScoreColor(arenaScore), fontFamily: tokens.typography.fontFamily.mono.join(', '), letterSpacing: '-0.02em' }}>
                      {arenaScore.toFixed(0)}
                    </Text>
                  </Badge>
                )
              }

              if (isBot) {
                allBadges.push(
                  <Badge key="bot" color="#a78bfa" style={{ padding: '3px 10px' }} title={t('botTooltip')}>
                    <span style={{ fontSize: 12, marginRight: 3 }}>{'⚡'}</span>
                    <Text size="xs" weight="bold" style={{ color: '#a78bfa', letterSpacing: '0.3px' }}>
                      {t('botLabel')}
                    </Text>
                  </Badge>
                )
              }

              if (source && EXCHANGE_NAMES[source.toLowerCase()]) {
                allBadges.push(
                  <Badge key="exchange" color={tokens.colors.accent.primary}>
                    <Text size="xs" weight="bold" style={{ color: tokens.colors.accent.primary, letterSpacing: '0.3px' }}>
                      {EXCHANGE_NAMES[source.toLowerCase()]}
                    </Text>
                  </Badge>
                )
              }

              // Priority 2: Secondary badges (hidden on mobile unless expanded)
              if (uid) {
                allBadges.push(
                  <Badge key="uid" color={tokens.colors.accent.primary} style={{ padding: `3px ${tokens.spacing[2]}` }} title={t('userNumber')}>
                    <Text size="xs" weight="bold" style={{ color: tokens.colors.accent.primary, fontFamily: 'monospace', letterSpacing: '0.5px' }}>
                      #{uid.toString().padStart(6, '0')}
                    </Text>
                  </Badge>
                )
              }

              // Source category badge (Futures/Spot/On-chain) — skip if exchange name already contains the category
              if (sourceLabel) {
                const exchangeName = source ? (EXCHANGE_NAMES[source.toLowerCase()] || '') : ''
                const isDuplicate = exchangeName.toLowerCase().includes(sourceLabel.toLowerCase())
                if (!isDuplicate) {
                  allBadges.push(
                    <Badge key="sourceLabel" color={tokens.colors.text.secondary}>
                      <Text size="xs" weight="bold" style={{ color: tokens.colors.text.secondary, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                        {sourceLabel}
                      </Text>
                    </Badge>
                  )
                }
              }

              if (getSourceCategory(source) === 'web3') {
                allBadges.push(<Web3VerifiedBadge key="web3" size="md" />)
              }
              allBadges.push(<OnChainBadge key="onchain" traderHandle={handle} size="sm" />)
              allBadges.push(<BadgeDisplay key="badges" traderHandle={handle} size="sm" maxDisplay={3} />)

              const MOBILE_VISIBLE_COUNT = 4
              const overflowCount = allBadges.length - MOBILE_VISIBLE_COUNT

              return (
                <>
                  {allBadges.map((badge, i) => (
                    <Box
                      key={i}
                      className={i >= MOBILE_VISIBLE_COUNT ? 'badge-overflow-item' : undefined}
                      style={i >= MOBILE_VISIBLE_COUNT && !badgesExpanded ? { display: 'inline-flex' } : { display: 'inline-flex' }}
                    >
                      {badge}
                    </Box>
                  ))}
                  {overflowCount > 0 && (
                    <button
                      className="badge-overflow-toggle"
                      onClick={() => setBadgesExpanded(!badgesExpanded)}
                      style={{
                        background: `${tokens.colors.bg.tertiary}`,
                        border: `1px solid ${tokens.colors.border.primary}`,
                        borderRadius: tokens.radius.full,
                        padding: '3px 10px',
                        cursor: 'pointer',
                        fontSize: 11,
                        fontWeight: 600,
                        color: tokens.colors.text.secondary,
                        display: 'none', // shown via CSS on mobile
                        alignItems: 'center',
                        transition: 'background 0.2s ease',
                      }}
                    >
                      {badgesExpanded ? t('showLess') || 'Less' : `+${overflowCount}`}
                    </button>
                  )}
                </>
              )
            })()}
          </Box>

          {/* Ranked #X on Exchange subtitle */}
          {rank != null && rank > 0 && source && EXCHANGE_NAMES[source.toLowerCase()] && (
            <Text
              size="xs"
              style={{
                color: tokens.colors.text.secondary,
                marginTop: 2,
                marginBottom: 2,
                fontWeight: 500,
                letterSpacing: '0.2px',
              }}
            >
              {t('rankedOnExchange')
                .replace('{rank}', rank.toLocaleString())
                .replace('{exchange}', EXCHANGE_NAMES[source.toLowerCase()] || source)}
            </Text>
          )}

          {/* "Updated X ago" — small gray text below rank */}
          {lastUpdated && (
            <Text
              size="xs"
              style={{
                color: tokens.colors.text.tertiary,
                fontSize: 10,
                marginTop: 2,
                opacity: 0.6,
              }}
              title={new Date(lastUpdated).toLocaleString()}
            >
              {t('updated') || 'Updated'} {getRelativeTime(lastUpdated)}
            </Text>
          )}

          {/* Claimed user bio */}
          {isVerifiedTrader && claimedBio && (
            <Text size="sm" color="secondary" style={{ marginTop: 4, maxWidth: 500, lineHeight: 1.5 }}>
              {claimedBio}
            </Text>
          )}

          {/* Stats row — hide followers/following when both are 0 */}
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], flexWrap: 'wrap', marginTop: tokens.spacing[1] }}>
            {(followerCount > 0 || following > 0) && (
              <>
                <StatItem
                  icon={
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={hasCover ? tokens.colors.white : tokens.colors.accent.primary} strokeWidth="2" strokeLinecap="round">
                      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                    </svg>
                  }
                  value={followerCount}
                  label={t('arenaFollowers') || 'Arena Followers'}
                  hasCover={hasCover}
                />
                <StatItem value={following} label={t('following') || '关注中'} hasCover={hasCover} />
              </>
            )}

            {copiers !== undefined && copiers > 0 && (
              <StatItem
                icon={
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={iconStroke} strokeWidth="2" strokeLinecap="round">
                    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                }
                value={copiers}
                label={t('copiers')}
                hasCover={hasCover}
              />
            )}

            {aum !== undefined && aum > 0 && (
              <StatItem
                icon={
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={iconStroke} strokeWidth="2" strokeLinecap="round">
                    <line x1="12" y1="1" x2="12" y2="23" />
                    <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                  </svg>
                }
                value={formatAum(aum)}
                label="AUM"
                hasCover={hasCover}
              />
            )}

            {activeDays !== null && activeDays >= 7 && (
              <StatItem
                icon={
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={iconStroke} strokeWidth="2" strokeLinecap="round">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                }
                value={formatActiveDays(activeDays, t)}
                label={t('activeDays')}
                hasCover={hasCover}
              />
            )}
          </Box>

          {/* Trading style tags */}
          {tags.length > 0 && (
            <Box style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              {tags.map((tag, i) => (
                <Badge key={i} color={tag.color} style={{ padding: '2px 8px' }}>
                  <Text style={{ fontSize: 11, fontWeight: 600, color: tag.color }}>
                    {tag.label}
                  </Text>
                </Badge>
              ))}
            </Box>
          )}
        </Box>
      </Box>

      {/* Action buttons - primary visible, secondary in more menu on mobile */}
      <Box
        className="profile-header-actions action-buttons"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexShrink: 0,
          flexWrap: 'wrap',
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

        {/* Primary actions: Follow + Copy Trade (always visible) */}
        {!isOwnProfile && userId && (
          isRegistered ? (
            <UserFollowButton
              targetUserId={traderId}
              currentUserId={userId}
              size="sm"
            />
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

        {!isOwnProfile && (
          <CopyTradeSection isPro={isPro} traderId={traderId} source={source} handle={handle} router={router} t={t} />
        )}

        {/* Secondary actions: visible on desktop, hidden in more menu on mobile */}
        <Box className="action-secondary-group" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {!isOwnProfile && !isRegistered && userId && (
            <ClaimTraderButton traderId={traderId} handle={handle} userId={userId} source={source} />
          )}

          <ShareOnXButton
            handle={handle}
            displayName={displayNameProp || formatDisplayName(handle, source)}
            platform={source}
            rank={rank}
            roi={roi90d}
          />

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

        {/* More menu toggle (mobile only) */}
        <button
          className="action-more-toggle"
          onClick={() => setMoreMenuOpen(!moreMenuOpen)}
          style={{
            background: tokens.colors.bg.tertiary,
            border: `1px solid ${tokens.colors.border.primary}`,
            borderRadius: tokens.radius.lg,
            padding: '8px 10px',
            cursor: 'pointer',
            color: tokens.colors.text.secondary,
            display: 'none', // shown via CSS on mobile
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: 36,
            minHeight: 36,
          }}
          aria-label={t('moreActions') || 'More actions'}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="5" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="12" cy="19" r="2" />
          </svg>
        </button>

        {/* More menu dropdown (mobile) */}
        {moreMenuOpen && (
          <Box
            className="action-more-dropdown"
            style={{
              position: 'absolute',
              top: '100%',
              right: 0,
              marginTop: 4,
              background: tokens.colors.bg.secondary,
              border: `1px solid ${tokens.colors.border.primary}`,
              borderRadius: tokens.radius.lg,
              boxShadow: '0 8px 24px var(--color-overlay-light)',
              padding: tokens.spacing[2],
              display: 'none', // shown via CSS on mobile
              flexDirection: 'column',
              gap: 4,
              minWidth: 180,
              zIndex: 50,
            }}
            onClick={() => setMoreMenuOpen(false)}
          >
            {!isOwnProfile && !isRegistered && userId && (
              <ClaimTraderButton traderId={traderId} handle={handle} userId={userId} source={source} />
            )}
            <ShareOnXButton
              handle={handle}
              displayName={displayNameProp || formatDisplayName(handle, source)}
              platform={source}
              rank={rank}
              roi={roi90d}
            />
          </Box>
        )}
      </Box>

    </Box>
  )
}
