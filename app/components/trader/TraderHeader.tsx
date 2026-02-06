'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import { Box, Text, Button } from '../base'
import ClaimTraderButton from './ClaimTraderButton'
import CopyTradeButton from './CopyTradeButton'
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import { ProBadgeOverlay } from '../ui/ProBadge'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { OnChainBadge } from './OnChainBadge'
import { BadgeDisplay } from './BadgeDisplay'

interface CommunityScore {
  avg_rating: number
  review_count: number
  recommend_rate: number
}

interface TraderHeaderProps {
  handle: string
  traderId: string
  uid?: number
  avatarUrl?: string
  coverUrl?: string
  isRegistered?: boolean
  followers?: number
  copiers?: number
  aum?: number
  isOwnProfile?: boolean
  source?: string
  communityScore?: CommunityScore | null
  proBadgeTier?: 'pro' | null
  isPro?: boolean
  activeSince?: string
  roi90d?: number
  maxDrawdown?: number
  winRate?: number
}

const SOURCE_CONFIG: Record<string, string> = {
  binance_futures: 'categoryFutures',
  binance_spot: 'categorySpot',
  binance_web3: 'categoryWeb3',
  bybit: 'categoryFutures',
  bitget_futures: 'categoryFutures',
  bitget_spot: 'categorySpot',
  mexc: 'categoryFutures',
  coinex: 'categoryFutures',
  okx_web3: 'categoryWeb3',
  kucoin: 'categoryFutures',
  gmx: 'categoryWeb3',
}


function getSourceCategory(source?: string): 'web3' | 'spot' | 'futures' | null {
  if (!source) return null
  if (source.includes('web3') || source === 'gmx') return 'web3'
  if (source.includes('spot')) return 'spot'
  if (source.includes('futures') || source === 'bybit' || source === 'okx') return 'futures'
  return null
}

const CATEGORY_COLORS: Record<string, string> = {
  web3: '#8B5CF6',
  spot: '#06B6D4',
  futures: '#F59E0B',
}

const CATEGORY_I18N_KEYS: Record<string, string> = {
  web3: 'categoryWeb3',
  spot: 'categorySpot',
  futures: 'categoryFutures',
}

function getTradingStyleTags(
  t: (key: string) => string,
  source?: string,
  roi90d?: number,
  maxDrawdown?: number,
  winRate?: number
): Array<{ label: string; color: string }> {
  const tags: Array<{ label: string; color: string }> = []

  const category = getSourceCategory(source)
  if (category) {
    tags.push({ label: t(CATEGORY_I18N_KEYS[category]), color: CATEGORY_COLORS[category] })
  }

  if (maxDrawdown !== undefined && Math.abs(maxDrawdown) < 10) {
    tags.push({ label: t('tagLowDrawdown'), color: '#10B981' })
  }
  if (winRate !== undefined && winRate > 70) {
    tags.push({ label: t('tagHighWinRate'), color: '#22C55E' })
  }
  if (roi90d !== undefined && roi90d > 100) {
    tags.push({ label: t('tagHighReturns'), color: '#EF4444' })
  }

  return tags.slice(0, 3)
}

function formatAum(aum: number): string {
  if (aum >= 1_000_000) return `$${(aum / 1_000_000).toFixed(1)}M`
  if (aum >= 1_000) return `$${(aum / 1_000).toFixed(0)}K`
  return `$${aum.toFixed(0)}`
}

function getActiveDays(activeSince?: string): number | null {
  if (!activeSince) return null
  const start = new Date(activeSince)
  if (isNaN(start.getTime())) return null
  const now = new Date()
  return Math.floor((now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
}

function formatActiveDays(days: number, t: (key: string) => string): string {
  return days > 365 ? `${Math.floor(days / 365)}${t('activeYears')}` : `${days}${t('activeDaysUnit')}`
}

interface ActionButtonProps {
  onClick: () => void
  variant: 'accent' | 'ghost'
  icon?: React.ReactNode
  children: React.ReactNode
}

function ActionButton({ onClick, variant, icon, children }: ActionButtonProps): React.ReactElement {
  const isAccent = variant === 'accent'
  const baseBackground = isAccent ? `${tokens.colors.accent.primary}15` : tokens.colors.bg.tertiary
  const baseBorder = isAccent ? `${tokens.colors.accent.primary}40` : tokens.colors.border.primary
  const textColor = isAccent ? tokens.colors.text.primary : tokens.colors.text.tertiary

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      style={{
        color: textColor,
        fontSize: tokens.typography.fontSize.sm,
        padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
        borderRadius: tokens.radius.lg,
        background: baseBackground,
        border: `1px solid ${baseBorder}`,
        transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[2],
      }}
      onMouseEnter={(e) => {
        if (isAccent) {
          e.currentTarget.style.background = `${tokens.colors.accent.primary}25`
          e.currentTarget.style.borderColor = tokens.colors.accent.primary
        } else {
          e.currentTarget.style.background = tokens.colors.bg.secondary
          e.currentTarget.style.borderColor = `${tokens.colors.accent.primary}40`
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = baseBackground
        e.currentTarget.style.borderColor = baseBorder
      }}
    >
      {icon}
      {children}
    </Button>
  )
}

interface CopyTradeSectionProps {
  isPro: boolean
  traderId: string
  source?: string
  handle: string
  router: ReturnType<typeof useRouter>
  t: (key: string) => string
}

function CopyTradeSection({ isPro, traderId, source, handle, router, t }: CopyTradeSectionProps): React.ReactElement {
  if (isPro) {
    return (
      <Box style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
        <CopyTradeButton traderId={traderId} source={source} traderHandle={handle} />
        <Text size="xs" color="tertiary" style={{ fontSize: 11, opacity: 0.7 }}>
          {t('jumpToExchange')}
        </Text>
      </Box>
    )
  }

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => router.push('/pricing')}
        style={{
          color: tokens.colors.text.tertiary,
          fontSize: tokens.typography.fontSize.sm,
          padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
          borderRadius: tokens.radius.lg,
          background: tokens.colors.bg.tertiary,
          border: `1px solid ${tokens.colors.border.primary}`,
          transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[2],
          opacity: 0.7,
        }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        {t('copyTradePro')}
      </Button>
      <Text size="xs" color="tertiary" style={{ fontSize: 11, opacity: 0.7 }}>
        {t('unlockToJumpExchange')}
      </Text>
    </Box>
  )
}

interface BadgeProps {
  children: React.ReactNode
  color: string
  style?: React.CSSProperties
  title?: string
}

function Badge({ children, color, style, title }: BadgeProps): React.ReactElement {
  return (
    <Box
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: `4px ${tokens.spacing[3]}`,
        background: `${color}18`,
        borderRadius: tokens.radius.full,
        border: `1px solid ${color}40`,
        ...style,
      }}
      title={title}
    >
      {children}
    </Box>
  )
}

interface StatItemProps {
  icon?: React.ReactNode
  value: string | number
  label: string
  hasCover: boolean
}

function StatItem({ icon, value, label, hasCover }: StatItemProps): React.ReactElement {
  const textColor = hasCover ? 'rgba(255,255,255,0.8)' : tokens.colors.text.secondary
  const valueColor = hasCover ? '#ffffff' : tokens.colors.text.primary
  const textShadow = hasCover ? '0 1px 4px rgba(0,0,0,0.5)' : undefined

  return (
    <Box
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
        borderRadius: tokens.radius.md,
      }}
    >
      {icon}
      <Text size="sm" style={{ color: textColor, textShadow }}>
        <Text as="span" weight="bold" style={{ color: valueColor, marginRight: 4, textShadow }}>
          {typeof value === 'number' ? value.toLocaleString() : value}
        </Text>
        {label}
      </Text>
    </Box>
  )
}

export default function TraderHeader({
  handle,
  traderId,
  uid,
  avatarUrl,
  coverUrl,
  isRegistered,
  followers = 0,
  copiers,
  aum,
  isOwnProfile = false,
  source,
  communityScore,
  proBadgeTier,
  isPro = false,
  activeSince,
  roi90d,
  maxDrawdown,
  winRate,
}: TraderHeaderProps): React.ReactElement {
  const [userId, setUserId] = useState<string | null>(null)
  const [mounted, setMounted] = useState(false)
  const [avatarHovered, setAvatarHovered] = useState(false)
  const router = useRouter()
  const { t } = useLanguage()

  useEffect(() => {
    setMounted(true)
    supabase.auth.getUser().then(({ data }) => {
      setUserId(data.user?.id ?? null)
    })
  }, [])

  const sourceLabelKey = source ? SOURCE_CONFIG[source.toLowerCase()] : null
  const sourceLabel = sourceLabelKey ? t(sourceLabelKey) : null
  const hasCover = Boolean(coverUrl)
  const activeDays = getActiveDays(activeSince)
  const tags = getTradingStyleTags(t, source, roi90d, maxDrawdown, winRate)
  const iconStroke = hasCover ? 'rgba(255,255,255,0.7)' : tokens.colors.text.tertiary

  const containerBackground = hasCover
    ? `linear-gradient(to bottom, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.6) 100%), url(${coverUrl}) center/cover no-repeat`
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
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.05)',
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
              background: avatarUrl ? tokens.colors.bg.secondary : getAvatarGradient(traderId),
              border: `3px solid ${avatarHovered ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
              display: 'grid',
              placeItems: 'center',
              fontWeight: tokens.typography.fontWeight.black,
              fontSize: tokens.typography.fontSize.xl,
              color: '#ffffff',
              overflow: 'hidden',
              boxShadow: avatarHovered
                ? `0 8px 32px rgba(139, 111, 168, 0.4), 0 0 0 4px ${tokens.colors.accent.primary}20`
                : `0 4px 16px rgba(0, 0, 0, 0.15)`,
              transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
              transform: avatarHovered ? 'scale(1.08)' : 'scale(1)',
              cursor: 'pointer',
            }}
          >
            {avatarUrl ? (
              <img
                src={`/api/avatar?url=${encodeURIComponent(avatarUrl)}`}
                alt={handle}
                width={72}
                height={72}
                loading="eager"
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  transition: 'all 0.4s ease',
                }}
                onError={(e) => {
                  const img = e.target as HTMLImageElement
                  img.style.display = 'none'
                  const container = img.parentElement
                  if (container) {
                    container.style.background = getAvatarGradient(traderId)
                    const fallback = document.createElement('span')
                    fallback.textContent = getAvatarInitial(handle)
                    fallback.style.cssText = 'color: #fff; font-size: 32px; font-weight: 900; line-height: 1; text-shadow: 0 2px 8px rgba(0,0,0,0.4);'
                    container.appendChild(fallback)
                  }
                }}
              />
            ) : (
              <Text
                size="2xl"
                weight="black"
                style={{
                  color: '#ffffff',
                  textShadow: '0 2px 8px rgba(0, 0, 0, 0.4)',
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
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], marginBottom: tokens.spacing[2] }}>
            <Text
              size="2xl"
              weight="black"
              style={{
                color: hasCover ? '#ffffff' : tokens.colors.text.primary,
                lineHeight: tokens.typography.lineHeight.tight,
                textShadow: hasCover ? '0 2px 8px rgba(0,0,0,0.5)' : undefined,
              }}
            >
              {handle}
            </Text>

            {uid && (
              <Badge color={tokens.colors.accent.primary} style={{ padding: `3px ${tokens.spacing[2]}` }} title={t('userNumber')}>
                <Text size="xs" weight="bold" style={{ color: tokens.colors.accent.primary, fontFamily: 'monospace', letterSpacing: '0.5px' }}>
                  #{uid.toString().padStart(6, '0')}
                </Text>
              </Badge>
            )}

            {source && EXCHANGE_NAMES[source.toLowerCase()] && (
              <Badge color={tokens.colors.accent.primary}>
                <Text size="xs" weight="bold" style={{ color: tokens.colors.accent.primary, letterSpacing: '0.3px' }}>
                  {EXCHANGE_NAMES[source.toLowerCase()]}
                </Text>
              </Badge>
            )}

            {sourceLabel && (
              <Badge color={tokens.colors.text.secondary}>
                <Text size="xs" weight="bold" style={{ color: tokens.colors.text.secondary, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  {sourceLabel}
                </Text>
              </Badge>
            )}

            {isRegistered && (
              <Box
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 22,
                  height: 22,
                  background: `linear-gradient(135deg, ${tokens.colors.accent.success}, #00D4AA)`,
                  borderRadius: tokens.radius.full,
                  boxShadow: `0 2px 8px ${tokens.colors.accent.success}40`,
                }}
                title={t('verifiedUser')}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </Box>
            )}

            <OnChainBadge traderHandle={handle} size="sm" />

            <BadgeDisplay traderHandle={handle} size="sm" maxDisplay={3} />

            {communityScore && communityScore.review_count > 0 && (
              <Badge color="#FFD700" title={`${communityScore.review_count} ${t('userReviews')}`} style={{ gap: tokens.spacing[1] }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="#FFD700" stroke="#FFD700" strokeWidth="1">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
                <Text size="xs" weight="bold" style={{ color: '#FFD700' }}>
                  {communityScore.avg_rating.toFixed(1)}
                </Text>
                <Text size="xs" style={{ color: 'rgba(255, 215, 0, 0.7)' }}>
                  ({communityScore.review_count})
                </Text>
              </Badge>
            )}
          </Box>
          
          {/* Stats row */}
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], flexWrap: 'wrap' }}>
            <StatItem value={followers} label={t('fans')} hasCover={hasCover} />

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

      {/* Action buttons */}
      <Box
        className="profile-header-actions action-buttons"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[2],
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

        {!isOwnProfile && (
          <CopyTradeSection isPro={isPro} traderId={traderId} source={source} handle={handle} router={router} t={t} />
        )}


        <ActionButton onClick={() => router.push('/')} variant="ghost">
          ← {t('back')}
        </ActionButton>

        {!isOwnProfile && !isRegistered && userId && (
          <ClaimTraderButton traderId={traderId} handle={handle} userId={userId} source={source} />
        )}
      </Box>
    </Box>
  )
}
