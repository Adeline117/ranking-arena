'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { useToast } from './Toast'
import { tokens } from '@/lib/design-tokens'
import { getCsrfHeaders } from '@/lib/api/client'

// 客服账号邮箱 - 用于查找客服用户 ID
const SUPPORT_EMAIL = 'adelinewen1107@outlook.com'

type ContactSupportButtonProps = {
  size?: 'sm' | 'md' | 'lg'
  fullWidth?: boolean
  variant?: 'default' | 'link' | 'card'
  label?: string
  className?: string
}

export default function ContactSupportButton({ 
  size = 'md',
  fullWidth = false,
  variant = 'default',
  label,
  className = '',
}: ContactSupportButtonProps) {
  const router = useRouter()
  const { showToast } = useToast()
  const [loading, setLoading] = useState(false)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [supportUserId, setSupportUserId] = useState<string | null>(null)

  // 获取当前用户和客服用户 ID
  useEffect(() => {
    const init = async () => {
      // 获取当前用户
      const { data: { user } } = await supabase.auth.getUser()
      setCurrentUserId(user?.id || null)

      // 获取客服用户 ID
      const { data: supportUser } = await supabase
        .from('user_profiles')
        .select('id')
        .eq('email', SUPPORT_EMAIL)
        .single()
      
      if (supportUser) {
        setSupportUserId(supportUser.id)
      } else {
        // 如果没找到，尝试从 auth.users 表查询（需要通过 API）
        // 备用：使用已知的 handle
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('id')
          .ilike('handle', 'adelinewen%')
          .limit(1)
          .single()
        
        if (profile) {
          setSupportUserId(profile.id)
        }
      }
    }

    init()
  }, [])

  const handleClick = async () => {
    if (!currentUserId) {
      showToast('请先登录后再联系客服', 'warning')
      router.push('/login?redirect=/help')
      return
    }

    if (!supportUserId) {
      showToast('客服暂不可用，请稍后再试', 'error')
      return
    }

    if (currentUserId === supportUserId) {
      showToast('你就是客服啊~', 'info')
      return
    }

    setLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      
      const response = await fetch('/api/messages/start', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': session?.access_token ? `Bearer ${session.access_token}` : '',
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({
          senderId: currentUserId,
          receiverId: supportUserId,
        }),
      })

      const data = await response.json()
      
      if (response.ok) {
        router.push(`/messages/${data.conversation_id}`)
      } else {
        if (data.error === '该用户已关闭私信功能') {
          showToast('客服暂时无法接收消息', 'warning')
        } else {
          showToast(data.error || '无法联系客服', 'error')
        }
      }
    } catch (error) {
      console.error('Contact support error:', error)
      showToast('操作失败，请重试', 'error')
    } finally {
      setLoading(false)
    }
  }

  const defaultLabel = label || '联系客服'
  
  const sizeStyles = {
    sm: { padding: '6px 12px', fontSize: '12px', borderRadius: '6px' },
    md: { padding: '10px 16px', fontSize: '14px', borderRadius: '10px' },
    lg: { padding: '12px 20px', fontSize: '15px', borderRadius: '12px' },
  }

  // 链接样式
  if (variant === 'link') {
    return (
      <button
        onClick={handleClick}
        disabled={loading}
        className={className}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--color-pro-gradient-start)',
          cursor: loading ? 'not-allowed' : 'pointer',
          textDecoration: 'underline',
          padding: 0,
          fontSize: 'inherit',
          fontWeight: 500,
          opacity: loading ? 0.6 : 1,
        }}
      >
        {loading ? '跳转中...' : defaultLabel}
      </button>
    )
  }

  // 卡片样式（用于帮助页面）
  if (variant === 'card') {
    return (
      <button
        onClick={handleClick}
        disabled={loading}
        className={className}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[3],
          padding: tokens.spacing[4],
          background: 'var(--color-bg-secondary)',
          border: '1px solid var(--color-border-primary)',
          borderRadius: tokens.radius.xl,
          cursor: loading ? 'not-allowed' : 'pointer',
          opacity: loading ? 0.6 : 1,
          transition: 'all 0.2s',
          width: fullWidth ? '100%' : 'auto',
          textAlign: 'left',
        }}
      >
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: tokens.radius.lg,
            background: 'var(--color-pro-glow)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--color-pro-gradient-start)',
          }}
        >
          <MessageIcon size={22} />
        </div>
        <div>
          <div style={{ 
            fontSize: tokens.typography.fontSize.sm, 
            fontWeight: 700,
            color: 'var(--color-text-secondary)',
          }}>
            {loading ? '跳转中...' : defaultLabel}
          </div>
          <div style={{ 
            fontSize: tokens.typography.fontSize.xs, 
            color: 'var(--color-text-tertiary)',
            marginTop: 2,
          }}>
            发送私信联系我们
          </div>
        </div>
      </button>
    )
  }

  // 默认按钮样式
  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className={className}
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
      {loading ? '...' : defaultLabel}
    </button>
  )
}

// 消息图标
function MessageIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  )
}
