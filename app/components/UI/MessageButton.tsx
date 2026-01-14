'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useToast } from './Toast'
import { tokens } from '@/lib/design-tokens'

type MessageButtonProps = {
  targetUserId: string
  currentUserId: string | null
  size?: 'sm' | 'md' | 'lg'
  fullWidth?: boolean
}

export default function MessageButton({ 
  targetUserId, 
  currentUserId, 
  size = 'md',
  fullWidth = false
}: MessageButtonProps) {
  const router = useRouter()
  const { showToast } = useToast()
  const [loading, setLoading] = useState(false)

  const handleClick = async () => {
    if (!currentUserId) {
      showToast('请先登录', 'warning')
      window.location.href = '/login'
      return
    }

    if (currentUserId === targetUserId) {
      showToast('不能给自己发私信', 'warning')
      return
    }

    setLoading(true)
    try {
      const response = await fetch('/api/messages/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          senderId: currentUserId,
          receiverId: targetUserId,
        }),
      })

      const data = await response.json()
      
      if (response.ok) {
        // 显示消息限制提示
        if (data.message_limit && !data.is_mutual_follow) {
          const remaining = data.message_limit.max - data.message_limit.sent
          if (remaining > 0 && remaining < 3) {
            showToast(`你们还不是互相关注，你还可以发送 ${remaining} 条消息`, 'info')
          }
        }
        
        // 跳转到会话页面
        router.push(`/messages/${data.conversation_id}`)
      } else {
        if (data.error === '该用户已关闭私信功能') {
          showToast('该用户已关闭私信功能', 'warning')
        } else if (data.limit_reached) {
          showToast('在对方回复前，你最多只能发送3条消息', 'warning')
        } else {
          showToast(data.error || '无法发起私信', 'error')
        }
      }
    } catch (error) {
      console.error('Start message error:', error)
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
      disabled={loading}
      style={{
        ...sizeStyles[size],
        width: fullWidth ? '100%' : 'auto',
        border: '1px solid rgba(255,255,255,0.2)',
        background: 'rgba(255,255,255,0.05)',
        color: '#eaeaea',
        fontWeight: 700,
        cursor: loading ? 'not-allowed' : 'pointer',
        opacity: loading ? 0.6 : 1,
        transition: 'all 200ms ease',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '6px',
      }}
    >
      <MessageIcon size={size === 'sm' ? 14 : 16} />
      {loading ? '...' : '私信'}
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

