'use client'

import { useState, useEffect } from 'react'
import { useToast } from './Toast'

type FollowButtonProps = {
  traderId: string
  userId: string | null
  initialFollowing?: boolean
}

export default function FollowButton({ traderId, userId, initialFollowing = false }: FollowButtonProps) {
  const { showToast } = useToast()
  const [following, setFollowing] = useState(initialFollowing)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!userId) return
    ;(async () => {
      try {
        // 通过 API 检查关注状态
        const response = await fetch(`/api/follow?userId=${userId}&traderId=${traderId}`)
        if (response.ok) {
          const data = await response.json()
          setFollowing(data.following)
        }
      } catch (error) {
        console.error('Check following error:', error)
      }
    })()
  }, [userId, traderId])

  const handleToggle = async () => {
    if (!userId) {
      showToast('请先登录', 'warning')
      return
    }

    setLoading(true)
    try {
      const response = await fetch('/api/follow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          traderId,
          action: following ? 'unfollow' : 'follow',
        }),
      })

      const data = await response.json()
      if (response.ok) {
        setFollowing(data.following)
      } else if (data.tableNotFound) {
        // 表不存在，静默处理，不记录错误
        showToast('关注功能暂未开放', 'warning')
      } else {
        console.error('Toggle follow error:', data)
        showToast('操作失败，请重试', 'error')
      }
    } catch (error) {
      console.error('Toggle follow error:', error)
      showToast('操作失败，请重试', 'error')
    } finally {
      setLoading(false)
    }
  }

  if (!userId) {
    return (
      <button
        onClick={() => window.location.href = '/login'}
        style={{
          padding: '8px 16px',
          borderRadius: '8px',
          border: '1px solid rgba(255,255,255,0.2)',
          background: 'rgba(255,255,255,0.05)',
          color: '#eaeaea',
          fontWeight: 700,
          fontSize: '13px',
          cursor: 'pointer',
        }}
      >
        关注
      </button>
    )
  }

  return (
    <button
      onClick={handleToggle}
      disabled={loading}
      style={{
        width: '100%',
        padding: '12px 16px',
        borderRadius: '12px',
        border: following ? '1px solid rgba(255,255,255,0.2)' : 'none',
        background: following ? 'rgba(255,255,255,0.05)' : '#8b6fa8',
        color: '#fff',
        fontWeight: 900,
        fontSize: '14px',
        cursor: loading ? 'not-allowed' : 'pointer',
        opacity: loading ? 0.6 : 1,
        transition: 'all 200ms ease',
      }}
    >
      {loading ? '...' : following ? '已关注' : '关注'}
    </button>
  )
}
