'use client'

import { useState, useEffect } from 'react'
import { useToast } from './Toast'
import { useApiMutation } from '@/lib/hooks/useApiMutation'
import { apiRequest } from '@/lib/api/client'

type FollowButtonProps = {
  traderId: string
  userId: string | null
  initialFollowing?: boolean
  onFollowChange?: (following: boolean) => void
}

type FollowResponse = {
  following: boolean
  success?: boolean
  tableNotFound?: boolean
}

export default function FollowButton({ traderId, userId, initialFollowing = false, onFollowChange }: FollowButtonProps) {
  const { showToast } = useToast()
  const [following, setFollowing] = useState(initialFollowing)

  // 使用 useApiMutation 处理关注/取消关注
  const { mutate, isLoading } = useApiMutation<FollowResponse, { action: 'follow' | 'unfollow' }>(
    async ({ action }) => {
      return apiRequest<FollowResponse>('/api/follow', {
        method: 'POST',
        body: { userId, traderId, action },
      })
    },
    {
      onSuccess: (data) => {
        setFollowing(data.following)
        onFollowChange?.(data.following)
      },
      onError: (error) => {
        if (error.tableNotFound) {
          showToast('关注功能暂未开放', 'warning')
        }
      },
      showToast: true,
      retryCount: 1,
    }
  )

  useEffect(() => {
    if (!userId) return
    ;(async () => {
      try {
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

  const handleToggle = () => {
    if (!userId) {
      showToast('请先登录', 'warning')
      return
    }
    mutate({ action: following ? 'unfollow' : 'follow' })
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
      disabled={isLoading}
      style={{
        width: '100%',
        padding: '12px 16px',
        borderRadius: '12px',
        border: following ? '1px solid rgba(255,255,255,0.2)' : 'none',
        background: following ? 'rgba(255,255,255,0.05)' : '#8b6fa8',
        color: '#fff',
        fontWeight: 900,
        fontSize: '14px',
        cursor: isLoading ? 'not-allowed' : 'pointer',
        opacity: isLoading ? 0.6 : 1,
        transition: 'all 200ms ease',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
      }}
    >
      {isLoading && <LoadingSpinner size={14} />}
      {isLoading ? '处理中...' : following ? '取消关注' : '关注'}
    </button>
  )
}

// 小型加载指示器
function LoadingSpinner({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      style={{ animation: 'spin 1s linear infinite' }}
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray="31.4 31.4"
        strokeDashoffset="31.4"
        style={{ animation: 'spinner-dash 1.5s ease-in-out infinite' }}
      />
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        @keyframes spinner-dash {
          0% { stroke-dashoffset: 31.4; }
          50% { stroke-dashoffset: 0; }
          100% { stroke-dashoffset: -31.4; }
        }
      `}</style>
    </svg>
  )
}
