'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import { Box, Text, Button } from '../Base'
import FollowButton from '../UI/FollowButton'
import UserFollowButton from '../UI/UserFollowButton'
import MessageButton from '../UI/MessageButton'
import FollowListModal from '../UI/FollowListModal'
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'

/**
 * 带 fallback 的头像组件
 * 解决头像图片加载时首字母和图片同时显示的问题
 */
function AvatarWithFallback({ 
  avatarUrl, 
  handle, 
  traderId, 
  size = 72 
}: { 
  avatarUrl?: string
  handle: string
  traderId: string
  size?: number
}) {
  const [imageLoaded, setImageLoaded] = useState(false)
  const [imageError, setImageError] = useState(false)
  
  const showFallback = !avatarUrl || imageError || !imageLoaded
  
  return (
    <Box
      style={{
        width: size,
        height: size,
        borderRadius: tokens.radius.full,
        background: getAvatarGradient(traderId),
        border: `2px solid ${tokens.colors.border.primary}`,
        display: 'grid',
        placeItems: 'center',
        marginBottom: tokens.spacing[4],
        overflow: 'hidden',
        flexShrink: 0,
        boxShadow: tokens.shadow.md,
        transition: `all ${tokens.transition.base}`,
        position: 'relative',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'scale(1.05)'
        e.currentTarget.style.boxShadow = tokens.shadow.lg
        e.currentTarget.style.borderColor = tokens.colors.accent.primary
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'scale(1)'
        e.currentTarget.style.boxShadow = tokens.shadow.md
        e.currentTarget.style.borderColor = tokens.colors.border.primary
      }}
    >
      {/* 头像图片 */}
      {avatarUrl && !imageError && (
        <img 
          src={avatarUrl} 
          alt={handle} 
          referrerPolicy="origin-when-cross-origin"
          loading="lazy"
          style={{ 
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%', 
            height: '100%', 
            objectFit: 'cover',
            opacity: imageLoaded ? 1 : 0,
            transition: `opacity ${tokens.transition.base}`,
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
            color: '#ffffff',
            textShadow: '0 2px 4px rgba(0, 0, 0, 0.4)',
            fontSize: `${Math.round(size * 0.44)}px`,
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

interface TraderAboutCardProps {
  handle: string
  traderId?: string // 交易员ID，用于关注功能
  avatarUrl?: string
  bio?: string
  followers?: number // 关注他的人数量（粉丝数）- 仅来自 Arena 注册用户的关注（trader_follows 表统计）
  following?: number // 他关注的人数量
  isRegistered?: boolean
  isOwnProfile?: boolean
  showFollowers?: boolean // 是否公开展示粉丝列表
  showFollowing?: boolean // 是否公开展示关注列表
}

/**
 * 交易员卡片 - 右侧固定卡片
 * 头像、一句话定位、关注按钮
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
  showFollowing = true,
}: TraderAboutCardProps) {
  const [userId, setUserId] = useState<string | null>(null)
  const [modalType, setModalType] = useState<'followers' | 'following' | null>(null)
  const router = useRouter()

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUserId(data.user?.id ?? null)
    })
  }, [])

  // 处理点击关注者/关注中
  const handleFollowListClick = (type: 'followers' | 'following') => {
    // 只有注册用户才能查看列表
    if (!isRegistered) return
    
    // 检查隐私设置 - 自己总是可以看到
    if (isOwnProfile) {
      setModalType(type)
      return
    }
    
    // 检查对应的隐私设置
    const canView = type === 'followers' ? showFollowers : showFollowing
    if (canView) {
      setModalType(type)
    }
  }

  return (
    <Box
      bg="secondary"
      p={6}
      radius="lg"
      border="primary"
      style={{
        position: 'sticky',
        top: 80, // 在TopNav下方
        boxShadow: tokens.shadow.md,
        transition: `all ${tokens.transition.base}`,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.boxShadow = tokens.shadow.lg
        e.currentTarget.style.transform = 'translateY(-2px)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = tokens.shadow.md
        e.currentTarget.style.transform = 'translateY(0)'
      }}
    >
      {/* 头像 */}
      <AvatarWithFallback 
        avatarUrl={avatarUrl}
        handle={handle}
        traderId={traderId || handle}
        size={72}
      />

      {/* 交易员ID */}
      <Text 
        size="lg" 
        weight="black" 
        style={{ 
          marginBottom: tokens.spacing[2], 
          color: tokens.colors.text.primary,
          lineHeight: tokens.typography.lineHeight.tight,
        }}
      >
        {handle}
      </Text>

      {/* 一句话定位（bio截取前50字符） */}
      {bio && (
        <Text 
          size="sm" 
          color="secondary" 
          style={{ 
            marginBottom: tokens.spacing[4], 
            lineHeight: tokens.typography.lineHeight.relaxed,
          }}
        >
          {bio.length > 50 ? bio.slice(0, 50) + '...' : bio}
        </Text>
      )}

      {/* 关注按钮/编辑个人资料按钮 - 主要操作 */}
      {isOwnProfile ? (
        <Button
          variant="primary"
          size="md"
          fullWidth
          onClick={() => router.push('/settings')}
          style={{
            marginBottom: tokens.spacing[4],
            fontWeight: tokens.typography.fontWeight.black,
          }}
        >
          编辑个人资料
        </Button>
      ) : traderId && userId ? (
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2], marginBottom: tokens.spacing[4] }}>
          {/* 如果是注册用户，使用用户关注按钮 */}
          {isRegistered ? (
            <>
              <UserFollowButton 
                targetUserId={traderId} 
                currentUserId={userId} 
                fullWidth 
                size="lg"
              />
              <MessageButton 
                targetUserId={traderId} 
                currentUserId={userId} 
                fullWidth 
                size="md"
              />
            </>
          ) : (
            /* 如果是交易员（非注册用户），使用交易员关注按钮 */
            <FollowButton traderId={traderId} userId={userId} />
          )}
        </Box>
      ) : null}

      {/* 次要信息 */}
      <Box
        style={{
          paddingTop: tokens.spacing[4],
          borderTop: `1px solid ${tokens.colors.border.primary}`,
          display: 'flex',
          gap: tokens.spacing[6],
        }}
      >
        {/* 关注者 */}
        <Box 
          style={{ 
            flex: 1,
            cursor: isRegistered && (isOwnProfile || showFollowers) ? 'pointer' : 'default',
            padding: tokens.spacing[2],
            margin: `-${tokens.spacing[2]}`,
            borderRadius: tokens.radius.md,
            transition: `background ${tokens.transition.fast}`,
          }}
          onClick={() => handleFollowListClick('followers')}
          onMouseEnter={(e) => {
            if (isRegistered && (isOwnProfile || showFollowers)) {
              e.currentTarget.style.background = tokens.colors.bg.hover
            }
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent'
          }}
        >
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1], marginBottom: tokens.spacing[1] }}>
            <Text size="xs" color="tertiary" style={{ fontWeight: tokens.typography.fontWeight.medium }}>
              关注者
            </Text>
            {/* 隐私指示器 - 仅自己可见 */}
            {isOwnProfile && (
              <span 
                title={showFollowers ? '公开 - 其他人可以查看' : '私密 - 仅自己可见'}
                style={{ 
                  fontSize: 10,
                  color: showFollowers ? tokens.colors.text.tertiary : tokens.colors.accent.warning,
                  cursor: 'help',
                }}
              >
                {showFollowers ? '👁' : '🔒'}
              </span>
            )}
            {/* 不可点击提示 */}
            {!isOwnProfile && !showFollowers && isRegistered && (
              <span 
                title="该用户已关闭粉丝列表展示"
                style={{ 
                  fontSize: 10,
                  color: tokens.colors.text.tertiary,
                }}
              >
                🔒
              </span>
            )}
          </Box>
          <Text size="base" weight="bold" style={{ color: tokens.colors.text.primary, fontSize: tokens.typography.fontSize.lg }}>
            {followers.toLocaleString()}
          </Text>
        </Box>

        {/* 关注中 */}
        {following !== undefined && (
          <Box 
            style={{ 
              flex: 1,
              cursor: isRegistered && (isOwnProfile || showFollowing) ? 'pointer' : 'default',
              padding: tokens.spacing[2],
              margin: `-${tokens.spacing[2]}`,
              borderRadius: tokens.radius.md,
              transition: `background ${tokens.transition.fast}`,
            }}
            onClick={() => handleFollowListClick('following')}
            onMouseEnter={(e) => {
              if (isRegistered && (isOwnProfile || showFollowing)) {
                e.currentTarget.style.background = tokens.colors.bg.hover
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
            }}
          >
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1], marginBottom: tokens.spacing[1] }}>
              <Text size="xs" color="tertiary" style={{ fontWeight: tokens.typography.fontWeight.medium }}>
                关注中
              </Text>
              {/* 隐私指示器 - 仅自己可见 */}
              {isOwnProfile && (
                <span 
                  title={showFollowing ? '公开 - 其他人可以查看' : '私密 - 仅自己可见'}
                  style={{ 
                    fontSize: 10,
                    color: showFollowing ? tokens.colors.text.tertiary : tokens.colors.accent.warning,
                    cursor: 'help',
                  }}
                >
                  {showFollowing ? '👁' : '🔒'}
                </span>
              )}
              {/* 不可点击提示 */}
              {!isOwnProfile && !showFollowing && isRegistered && (
                <span 
                  title="该用户已关闭关注列表展示"
                  style={{ 
                    fontSize: 10,
                    color: tokens.colors.text.tertiary,
                  }}
                >
                  🔒
                </span>
              )}
            </Box>
            <Text size="base" weight="bold" style={{ color: tokens.colors.text.primary, fontSize: tokens.typography.fontSize.lg }}>
              {following.toLocaleString()}
            </Text>
          </Box>
        )}
      </Box>

      {/* 关注列表弹窗 */}
      {isRegistered && (
        <FollowListModal
          isOpen={modalType !== null}
          onClose={() => setModalType(null)}
          type={modalType || 'followers'}
          handle={handle}
          currentUserId={userId}
          isOwnProfile={isOwnProfile}
        />
      )}
    </Box>
  )
}
