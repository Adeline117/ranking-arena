'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import { Box, Text } from '../base'
import TraderFollowButton from '../ui/TraderFollowButton'
import UserFollowButton from '../ui/UserFollowButton'
import MessageButton from '../ui/MessageButton'
import { DynamicFollowListModal as FollowListModal } from '../ui/Dynamic'
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

/**
 * 带动画的头像组件
 */
function AnimatedAvatar({ 
  avatarUrl, 
  handle, 
  traderId, 
  size = 80 
}: { 
  avatarUrl?: string
  handle: string
  traderId: string
  size?: number
}) {
  const [imageLoaded, setImageLoaded] = useState(false)
  const [imageError, setImageError] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  
  const showFallback = !avatarUrl || imageError || !imageLoaded
  
  return (
    <Box
      style={{
        width: size,
        height: size,
        borderRadius: tokens.radius.full,
        background: getAvatarGradient(traderId),
        border: `3px solid ${isHovered ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
        display: 'grid',
        placeItems: 'center',
        marginBottom: tokens.spacing[4],
        overflow: 'hidden',
        flexShrink: 0,
        boxShadow: isHovered 
          ? `0 8px 32px var(--color-accent-primary-40), 0 0 0 4px ${tokens.colors.accent.primary}20`
          : tokens.shadow.lg,
        transition: `all ${tokens.transition.smooth}`,
        position: 'relative',
        transform: isHovered ? 'scale(1.08) rotate(2deg)' : 'scale(1) rotate(0deg)',
        cursor: 'pointer',
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* 光环效果 */}
      <Box
        style={{
          position: 'absolute',
          inset: -4,
          borderRadius: tokens.radius.full,
          background: `conic-gradient(from 0deg, ${tokens.colors.accent.primary}00, ${tokens.colors.accent.primary}40, ${tokens.colors.accent.primary}00)`,
          opacity: isHovered ? 1 : 0,
          transition: 'opacity 0.4s ease',
          animation: isHovered ? 'spin 3s linear infinite' : 'none',
        }}
      />
      {/* 头像图片 */}
      {avatarUrl && !imageError && (
        <Image 
          src={avatarUrl.startsWith("/") ? avatarUrl : `/api/avatar?url=${encodeURIComponent(avatarUrl)}`} 
          alt={handle} 
          fill
          sizes="64px"
          loading="lazy"
          style={{ 
            objectFit: 'cover',
            opacity: imageLoaded ? 1 : 0,
            transition: 'opacity 0.4s ease',
          }}
          onLoad={() => setImageLoaded(true)}
          onError={() => setImageError(true)}
        />
      )}
      {/* 首字母 fallback */}
      {showFallback && (
        <Text 
          size="2xl" 
          weight="black" 
          style={{ 
            color: tokens.colors.white,
            textShadow: '0 2px 8px var(--color-overlay-dark)',
            fontSize: `${Math.round(size * 0.42)}px`,
            lineHeight: '1',
            position: 'relative',
            zIndex: 1,
          }}
        >
          {getAvatarInitial(handle)}
        </Text>
      )}
    </Box>
  )
}

interface SocialLinks {
  twitter?: string
  telegram?: string
  discord?: string
  github?: string
  website?: string
}

const socialLinkStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
  borderRadius: tokens.radius.md,
  background: `${tokens.colors.bg.tertiary}80`,
  color: tokens.colors.text.secondary,
  fontSize: tokens.typography.fontSize.xs,
  textDecoration: 'none',
  transition: `all ${tokens.transition.base}`,
  border: `1px solid ${tokens.colors.border.primary}40`,
}

function SocialLink({
  href,
  icon,
  text,
  title
}: {
  href?: string
  icon: string
  text: string
  title: string
}): React.ReactElement {
  const content = (
    <>
      <span style={{ fontSize: tokens.typography.fontSize.xs }}>{icon}</span>
      <span>{text}</span>
    </>
  )

  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" title={title} style={socialLinkStyle}>
        {content}
      </a>
    )
  }

  return (
    <span title={title} style={socialLinkStyle}>
      {content}
    </span>
  )
}

interface TraderAboutCardProps {
  handle: string
  traderId?: string
  avatarUrl?: string
  bio?: string
  followers?: number
  following?: number  // 合并后的总关注数（用户 + 交易员）
  isRegistered?: boolean
  isOwnProfile?: boolean
  showFollowers?: boolean
  showFollowing?: boolean
  socialLinks?: SocialLinks
}

/**
 * 交易员卡片 - 右侧固定卡片
 * 现代化玻璃质感设计
 */
export default function TraderAboutCard({
  handle,
  traderId,
  avatarUrl,
  bio,
  followers = 0,
  following = 0,
  isRegistered,
  isOwnProfile = false,
  showFollowers = true,
  socialLinks,
}: TraderAboutCardProps) {
  const [userId, setUserId] = useState<string | null>(null)
  const [modalType, setModalType] = useState<'followers' | null>(null)
  const [mounted, setMounted] = useState(false)
  const [followersCount, setFollowersCount] = useState(followers)
  const _router = useRouter()
  const { t } = useLanguage()

  useEffect(() => {
    setMounted(true)
     
    supabase.auth.getUser().then(({ data }) => {
      setUserId(data.user?.id ?? null)
    }).catch(() => { /* Intentionally swallowed: auth check non-critical for about card */ }) // eslint-disable-line no-restricted-syntax -- intentional fire-and-forget
  }, [])

  const handleFollowersClick = () => {
    if (!isRegistered) return
    if (isOwnProfile || showFollowers) {
      setModalType('followers')
    }
  }

  return (
    <Box
      className="about-card glass-card"
      style={{
        background: `linear-gradient(165deg, ${tokens.colors.bg.secondary}F0 0%, ${tokens.colors.bg.primary}E8 100%)`,
        backdropFilter: tokens.glass.blur.lg,
        WebkitBackdropFilter: tokens.glass.blur.lg,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}60`,
        padding: tokens.spacing[6],
        boxShadow: `0 8px 32px var(--color-overlay-light), inset 0 1px 0 var(--glass-bg-light)`,
        transition: `all ${tokens.transition.smooth}`,
        zIndex: 10,
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateX(0)' : 'translateX(30px)',
        overflow: 'hidden',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'translateY(-4px)'
        e.currentTarget.style.boxShadow = '0 20px 48px var(--color-overlay-light), inset 0 1px 0 var(--glass-bg-light)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'translateY(0)'
        e.currentTarget.style.boxShadow = '0 8px 32px var(--color-overlay-light), inset 0 1px 0 var(--glass-bg-light)'
      }}
    >
      {/* 装饰背景 */}
      <Box
        style={{
          position: 'absolute',
          top: -60,
          right: -60,
          width: 180,
          height: 180,
          background: `radial-gradient(circle, ${tokens.colors.accent.primary}15 0%, transparent 70%)`,
          pointerEvents: 'none',
        }}
      />
      
      {/* 头像 */}
      <Box style={{ display: 'flex', justifyContent: 'center', position: 'relative', zIndex: 1 }}>
        <AnimatedAvatar 
          avatarUrl={avatarUrl}
          handle={handle}
          traderId={traderId || handle}
          size={80}
        />
      </Box>

      {/* 交易员ID */}
      <Text 
        size="xl" 
        weight="black" 
        style={{ 
          marginBottom: tokens.spacing[2], 
          color: tokens.colors.text.primary,
          lineHeight: tokens.typography.lineHeight.tight,
          textAlign: 'center',
          position: 'relative',
          zIndex: 1,
        }}
      >
        {handle}
      </Text>

      {/* Bio */}
      {bio ? (
        <Text
          size="sm"
          color="secondary"
          style={{
            marginBottom: tokens.spacing[5],
            lineHeight: tokens.typography.lineHeight.relaxed,
            textAlign: 'center',
            position: 'relative',
            zIndex: 1,
          }}
        >
          {bio.length > 60 ? bio.slice(0, 60) + '...' : bio}
        </Text>
      ) : isOwnProfile ? (
        <Text
          size="sm"
          color="tertiary"
          style={{
            marginBottom: tokens.spacing[5],
            lineHeight: tokens.typography.lineHeight.relaxed,
            textAlign: 'center',
            position: 'relative',
            zIndex: 1,
            fontStyle: 'italic',
          }}
        >
          {t('addBioHint')}
        </Text>
      ) : null}

      {/* 社交链接 */}
      {socialLinks && Object.values(socialLinks).some(v => v) && (
        <Box
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: tokens.spacing[2],
            justifyContent: 'center',
            marginBottom: tokens.spacing[4],
            position: 'relative',
            zIndex: 1,
          }}
        >
          {socialLinks.twitter && (
            <SocialLink
              href={`https://x.com/${socialLinks.twitter}`}
              icon="𝕏"
              text={socialLinks.twitter}
              title={`@${socialLinks.twitter}`}
            />
          )}
          {socialLinks.telegram && (
            <SocialLink
              href={`https://t.me/${socialLinks.telegram}`}
              icon="TG"
              text={socialLinks.telegram}
              title={`@${socialLinks.telegram}`}
            />
          )}
          {socialLinks.discord && (
            <SocialLink
              icon="DC"
              text={socialLinks.discord.length > 12 ? socialLinks.discord.slice(0, 12) + '...' : socialLinks.discord}
              title={socialLinks.discord}
            />
          )}
          {socialLinks.github && (
            <SocialLink
              href={`https://github.com/${socialLinks.github}`}
              icon="GH"
              text={socialLinks.github}
              title={socialLinks.github}
            />
          )}
          {socialLinks.website && (
            <SocialLink
              href={socialLinks.website.startsWith('http') ? socialLinks.website : `https://${socialLinks.website}`}
              icon="W"
              text={socialLinks.website.replace(/^https?:\/\//, '').slice(0, 20)}
              title={socialLinks.website}
            />
          )}
        </Box>
      )}

      {/* 操作按钮 - 只在非自己的主页显示（编辑按钮在 TraderHeader 中） */}
      <Box style={{ position: 'relative', zIndex: 1 }}>
        {!isOwnProfile && traderId && userId ? (
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2], marginBottom: tokens.spacing[5] }}>
            {isRegistered ? (
              <>
                <UserFollowButton 
                  targetUserId={traderId} 
                  currentUserId={userId} 
                  fullWidth 
                  size="lg"
                  onFollowChange={(isFollowing) => {
                    setFollowersCount(prev => isFollowing ? prev + 1 : prev - 1)
                  }}
                />
                <MessageButton 
                  targetUserId={traderId} 
                  currentUserId={userId} 
                  fullWidth 
                  size="md"
                />
              </>
            ) : (
              <TraderFollowButton
                traderId={traderId}
                userId={userId}
                onFollowChange={(isFollowing) => {
                  setFollowersCount(prev => isFollowing ? prev + 1 : prev - 1)
                }}
              />
            )}
          </Box>
        ) : null}
      </Box>

      {/* 统计数据 - 只有两项：关注中 和 被关注 */}
      <Box
        style={{
          paddingTop: tokens.spacing[5],
          borderTop: `1px solid ${tokens.colors.border.primary}40`,
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: tokens.spacing[3],
          position: 'relative',
          zIndex: 1,
        }}
      >
        {/* 关注中（用户 + 交易员合并） - 只有自己主页才跳转到关注页面 */}
        {isOwnProfile ? (
          <Link href="/following" style={{ textDecoration: 'none' }}>
            <StatItem
              label={t('following')}
              value={following}
              clickable
            />
          </Link>
        ) : (
          <StatItem
            label={t('following')}
            value={following}
            clickable={false}
          />
        )}

        {/* 被关注 */}
        <StatItem
          label={t('followers')}
          value={followersCount}
          onClick={handleFollowersClick}
          clickable={isRegistered && (isOwnProfile || showFollowers)}
        />
      </Box>

      {/* 被关注列表弹窗 */}
      {isRegistered && (
        <FollowListModal
          isOpen={modalType === 'followers'}
          onClose={() => setModalType(null)}
          type="followers"
          handle={handle}
          currentUserId={userId}
          isOwnProfile={isOwnProfile}
          isPublic={showFollowers}
        />
      )}
      
    </Box>
  )
}

// 统计项组件
function StatItem({
  label,
  value,
  onClick,
  clickable,
}: {
  label: string
  value: number
  onClick?: () => void
  clickable?: boolean
}) {
  const [isHovered, setIsHovered] = useState(false)

  return (
    <Box
      style={{
        flex: 1,
        cursor: clickable ? 'pointer' : 'default',
        padding: tokens.spacing[3],
        borderRadius: tokens.radius.lg,
        background: isHovered && clickable ? `${tokens.colors.accent.primary}10` : 'transparent',
        transition: `all ${tokens.transition.slow}`,
        transform: isHovered && clickable ? 'scale(1.02)' : 'scale(1)',
        textAlign: 'center',
      }}
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <Text 
        size="xs" 
        color="tertiary" 
        style={{ 
          fontWeight: tokens.typography.fontWeight.medium, 
          marginBottom: tokens.spacing[1],
          display: 'block',
        }}
      >
        {label}
      </Text>
      <Text 
        size="lg" 
        weight="black" 
        style={{ 
          color: tokens.colors.text.primary,
          display: 'block',
        }}
      >
        {value.toLocaleString('en-US')}
      </Text>
    </Box>
  )
}
