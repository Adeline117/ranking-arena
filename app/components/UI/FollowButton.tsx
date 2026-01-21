'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useToast } from './Toast'
import { useApiMutation } from '@/lib/hooks/useApiMutation'
import { apiRequest } from '@/lib/api/client'
import { useFollowSync, type FollowChangePayload } from '@/lib/hooks/useBroadcastSync'

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

  // 防止重复点击的锁
  const pendingRef = useRef(false)
  // 跟踪期望的状态（用于乐观更新）
  const expectedStateRef = useRef<boolean | null>(null)

  // 多窗口同步
  const { broadcast, on } = useFollowSync()

  // 监听其他窗口的关注状态变化
  useEffect(() => {
    const unsubscribe = on('FOLLOW_CHANGED', (payload: FollowChangePayload) => {
      // 只处理同一交易员的状态变化
      if (payload.traderId === traderId && payload.userId === userId) {
        // 避免在有待处理操作时更新
        if (!pendingRef.current) {
          setFollowing(payload.following)
          onFollowChange?.(payload.following)
        }
      }
    })

    return unsubscribe
  }, [traderId, userId, on, onFollowChange])

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
        pendingRef.current = false
        expectedStateRef.current = null
        setFollowing(data.following)
        onFollowChange?.(data.following)

        // 广播状态变化到其他窗口
        if (userId) {
          broadcast('FOLLOW_CHANGED', {
            traderId,
            following: data.following,
            userId,
          })
        }
      },
      onError: (error) => {
        pendingRef.current = false
        // 回滚乐观更新
        if (expectedStateRef.current !== null) {
          setFollowing(!expectedStateRef.current)
          expectedStateRef.current = null
        }
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

    const abortController = new AbortController()

    ;(async () => {
      try {
        const response = await fetch(
          `/api/follow?userId=${userId}&traderId=${traderId}`,
          { signal: abortController.signal }
        )
        if (response.ok) {
          const data = await response.json()
          // 只有在没有待处理操作时才更新状态
          if (!pendingRef.current) {
            setFollowing(data.following)
          }
        }
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          console.error('Check following error:', error)
        }
      }
    })()

    return () => {
      abortController.abort()
    }
  }, [userId, traderId])

  const handleToggle = useCallback(() => {
    if (!userId) {
      showToast('请先登录', 'warning')
      return
    }

    // 防止重复点击
    if (pendingRef.current || isLoading) {
      return
    }

    pendingRef.current = true
    const newState = !following
    expectedStateRef.current = newState

    // 乐观更新 UI
    setFollowing(newState)

    mutate({ action: newState ? 'follow' : 'unfollow' })
  }, [userId, following, isLoading, mutate, showToast])

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
