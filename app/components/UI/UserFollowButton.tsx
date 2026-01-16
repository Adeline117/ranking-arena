'use client'

import { useState, useEffect } from 'react'
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

export default function UserFollowButton({ 
  targetUserId, 
  currentUserId, 
  initialFollowing = false,
  size = 'md',
  fullWidth = false,
  onFollowChange
}: UserFollowButtonProps) {
  const { showToast } = useToast()
  const [following, setFollowing] = useState(initialFollowing)
  const [followedBy, setFollowedBy] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!currentUserId || currentUserId === targetUserId) return
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
      }
    })()
  }, [currentUserId, targetUserId])

  const handleToggle = async () => {
    if (!currentUserId) {
      showToast('请先登录', 'warning')
      window.location.href = '/login'
      return
    }

    if (currentUserId === targetUserId) {
      showToast('不能关注自己', 'warning')
      return
    }

    setLoading(true)
    try {
      const result = await apiPost<{ following: boolean; tableNotFound?: boolean }>('/api/users/follow', {
        followerId: currentUserId,
        followingId: targetUserId,
        action: following ? 'unfollow' : 'follow',
      })

      if (result.success && result.data) {
        setFollowing(result.data.following)
        const isMutual = result.data.following && followedBy
        onFollowChange?.(result.data.following, isMutual)
        showToast(result.data.following ? '关注成功' : '已取消关注', 'success')
      } else if (result.data?.tableNotFound) {
        showToast('关注功能暂未开放', 'warning')
      } else {
        console.error('Toggle follow error:', result.error)
        showToast(result.error?.message || '操作失败，请重试', 'error')
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
        onClick={() => window.location.href = '/login'}
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
          {following ? (isMutual ? '互关 ✓' : '取消关注') : (followedBy ? '回关' : '关注')}
        </>
      )}
    </button>
  )
}
