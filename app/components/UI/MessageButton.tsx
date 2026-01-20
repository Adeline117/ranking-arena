'use client'

import { useRouter } from 'next/navigation'
import { useToast } from './Toast'
import { useApiMutation } from '@/lib/hooks/useApiMutation'
import { apiRequest } from '@/lib/api/client'

type MessageButtonProps = {
  targetUserId: string
  currentUserId: string | null
  size?: 'sm' | 'md' | 'lg'
  fullWidth?: boolean
}

type StartMessageResponse = {
  conversation_id: string
  message_limit?: {
    max: number
    sent: number
  }
  is_mutual_follow?: boolean
  error?: string
  limit_reached?: boolean
}

export default function MessageButton({ 
  targetUserId, 
  currentUserId, 
  size = 'md',
  fullWidth = false
}: MessageButtonProps) {
  const router = useRouter()
  const { showToast } = useToast()

  const { mutate, isLoading } = useApiMutation<StartMessageResponse, void>(
    async () => {
      return apiRequest<StartMessageResponse>('/api/messages/start', {
        method: 'POST',
        body: {
          senderId: currentUserId,
          receiverId: targetUserId,
        },
      })
    },
    {
      onSuccess: (data) => {
        // 显示消息限制提示
        if (data.message_limit && !data.is_mutual_follow) {
          const remaining = data.message_limit.max - data.message_limit.sent
          if (remaining > 0 && remaining < 3) {
            showToast(`你们还不是互相关注，你还可以发送 ${remaining} 条消息`, 'info')
          }
        }
        // 跳转到会话页面
        router.push(`/messages/${data.conversation_id}`)
      },
      onError: (error) => {
        if (error.message === '该用户已关闭私信功能') {
          showToast('该用户已关闭私信功能', 'warning')
        } else if (error.limitReached) {
          showToast('在对方回复前，你最多只能发送3条消息', 'warning')
        }
      },
      showToast: false, // 使用自定义错误处理
      retryCount: 1,
    }
  )

  const handleClick = () => {
    if (!currentUserId) {
      showToast('请先登录', 'warning')
      window.location.href = '/login'
      return
    }

    if (currentUserId === targetUserId) {
      showToast('不能给自己发私信', 'warning')
      return
    }

    mutate()
  }

  const sizeStyles = {
    sm: { padding: '6px 12px', fontSize: '12px', borderRadius: '6px' },
    md: { padding: '10px 16px', fontSize: '14px', borderRadius: '10px' },
    lg: { padding: '12px 20px', fontSize: '15px', borderRadius: '12px' },
  }

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
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '6px',
        }}
      >
        <MessageIcon size={size === 'sm' ? 14 : 16} />
        私信
      </button>
    )
  }

  // 如果是自己的资料，不显示私信按钮
  if (currentUserId === targetUserId) {
    return null
  }

  return (
    <button
      onClick={handleClick}
      disabled={isLoading}
      style={{
        ...sizeStyles[size],
        width: fullWidth ? '100%' : 'auto',
        border: '1px solid rgba(255,255,255,0.2)',
        background: 'rgba(255,255,255,0.05)',
        color: '#eaeaea',
        fontWeight: 700,
        cursor: isLoading ? 'not-allowed' : 'pointer',
        opacity: isLoading ? 0.6 : 1,
        transition: 'all 200ms ease',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '6px',
      }}
    >
      {isLoading ? (
        <LoadingSpinner size={size === 'sm' ? 12 : 14} />
      ) : (
        <MessageIcon size={size === 'sm' ? 14 : 16} />
      )}
      {isLoading ? '...' : '私信'}
    </button>
  )
}

// 简单的消息图标
function MessageIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  )
}

// 加载指示器
function LoadingSpinner({ size = 14 }: { size?: number }) {
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
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes spinner-dash {
          0% { stroke-dashoffset: 31.4; }
          50% { stroke-dashoffset: 0; }
          100% { stroke-dashoffset: -31.4; }
        }
      `}</style>
    </svg>
  )
}
