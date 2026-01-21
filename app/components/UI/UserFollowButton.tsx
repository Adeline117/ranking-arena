'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useToast } from './Toast'
import { tokens } from '@/lib/design-tokens'
import { apiPost } from '@/lib/api/client'

type UserFollowButtonProps = {
  targetUserId: string
  currentUserId: string | null
  initialFollowing?: boolean
  size?: 'sm' | 'md' | 'lg'
  fullWidth?: boolean
  onFollowChange?: (following: boolean, mutual: boolean) => void
}

/**
 * 关注用户的按钮
 * 用于用户主页，关注/取消关注平台用户
 *
 * 区分于 TraderFollowButton（用于关注交易员）
 */
export default function UserFollowButton({
  targetUserId,
  currentUserId,
  initialFollowing = false,
  size = 'md',
  fullWidth = false,
  onFollowChange
}: UserFollowButtonProps) {
  const router = useRouter()
  const { showToast } = useToast()
  const [following, setFollowing] = useState(initialFollowing)
  const [followedBy, setFollowedBy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [initialLoading, setInitialLoading] = useState(true) // 初始加载状态

  useEffect(() => {
    if (!currentUserId || currentUserId === targetUserId) {
      setInitialLoading(false)
      return
    }
    ;(async () => {
      try {
        const response = await fetch(`/api/users/follow?followerId=${currentUserId}&followingId=${targetUserId}`)
        if (response.ok) {
          const data = await response.json()
          setFollowing(data.following)
          setFollowedBy(data.followedBy)
        }
      } catch (error) {
        console.error('Check following error:', error)
      } finally {
        setInitialLoading(false)
      }
    })()
  }, [currentUserId, targetUserId])

  const handleToggle = async () => {
    if (!currentUserId) {
      showToast('请先登录', 'warning')
      router.push('/login')
      return
    }

    if (currentUserId === targetUserId) {
      showToast('不能关注自己', 'warning')
      return
    }

    setLoading(true)
    try {
      const result = await apiPost<{ following: boolean; mutual?: boolean; tableNotFound?: boolean }>('/api/users/follow', {
        followerId: currentUserId,
        followingId: targetUserId,
        action: following ? 'unfollow' : 'follow',
      })

      if (result.success && result.data) {
        setFollowing(result.data.following)
        // 根据 API 返回的 mutual 状态更新 followedBy（互关时对方也关注了我）
        if (result.data.mutual !== undefined) {
          setFollowedBy(result.data.mutual)
        }
        onFollowChange?.(result.data.following, result.data.mutual ?? false)
        showToast(result.data.following ? '关注成功' : '已取消关注', 'success')
      } else if (result.data?.tableNotFound) {
        showToast('关注功能暂未开放', 'warning')
      } else {
        const errorMsg = typeof result.error === 'string' 
          ? result.error 
          : result.error?.message || '操作失败，请重试'
        console.error('Toggle follow error:', errorMsg)
        showToast(errorMsg, 'error')
      }
    } catch (error) {
      console.error('Toggle follow error:', error)
      showToast('操作失败，请重试', 'error')
    } finally {
      setLoading(false)
    }
  }

  const sizeStyles = {
    sm: { padding: '6px 12px', fontSize: '12px', borderRadius: '6px' },
    md: { padding: '10px 16px', fontSize: '14px', borderRadius: '10px' },
    lg: { padding: '12px 20px', fontSize: '15px', borderRadius: '12px' },
  }

  const isMutual = following && followedBy

  if (!currentUserId) {
    return (
      <button
        onClick={() => router.push('/login')}
        style={{
          ...sizeStyles[size],
          width: fullWidth ? '100%' : 'auto',
          border: '1px solid rgba(255,255,255,0.2)',
          background: 'rgba(255,255,255,0.05)',
          color: '#eaeaea',
          fontWeight: 700,
          cursor: 'pointer',
        }}
      >
        关注
      </button>
    )
  }

  // 如果是自己的资料，不显示关注按钮
  if (currentUserId === targetUserId) {
    return null
  }

  // 初始加载时显示加载状态
  if (initialLoading) {
    return (
      <button
        disabled
        style={{
          ...sizeStyles[size],
          width: fullWidth ? '100%' : 'auto',
          border: '1px solid rgba(255,255,255,0.2)',
          background: 'rgba(255,255,255,0.05)',
          color: '#fff',
          fontWeight: 700,
          cursor: 'not-allowed',
          opacity: 0.6,
        }}
      >
        ...
      </button>
    )
  }

  return (
    <button
      onClick={handleToggle}
      disabled={loading}
      style={{
        ...sizeStyles[size],
        width: fullWidth ? '100%' : 'auto',
        border: following ? '1px solid rgba(255,255,255,0.2)' : 'none',
        background: following ? 'rgba(255,255,255,0.05)' : '#8b6fa8',
        color: '#fff',
        fontWeight: 700,
        cursor: loading ? 'not-allowed' : 'pointer',
        opacity: loading ? 0.6 : 1,
        transition: 'all 200ms ease',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '4px',
      }}
    >
      {loading ? '...' : (
        <>
          {following ? (isMutual ? '互相关注' : '取消关注') : (followedBy ? '回关' : '关注')}
        </>
      )}
    </button>
  )
}
