'use client'

import { useRouter } from 'next/navigation'
import { useToast } from './Toast'
import { ButtonSpinner } from './LoadingSpinner'
import { useApiMutation } from '@/lib/hooks/useApiMutation'
import { apiRequest } from '@/lib/api/client'
import { supabase } from '@/lib/supabase/client'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useLoginModal } from '@/lib/hooks/useLoginModal'
import { tokens } from '@/lib/design-tokens'

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
  const { t } = useLanguage()

  const { mutate, isLoading } = useApiMutation<StartMessageResponse, void>(
    async () => {
      // Get fresh access token for auth
       
      const { data: sessionData } = await supabase.auth.getSession()
      const token = sessionData.session?.access_token
      const headers: Record<string, string> = {}
      if (token) headers['Authorization'] = `Bearer ${token}`

      return apiRequest<StartMessageResponse>('/api/messages/start', {
        method: 'POST',
        headers,
        body: {
          receiverId: targetUserId,
        },
      })
    },
    {
      onSuccess: (data) => {
        if (data.message_limit && !data.is_mutual_follow) {
          const remaining = data.message_limit.max - data.message_limit.sent
          if (remaining > 0 && remaining < 3) {
            showToast(t('msgLimitWarning').replace('{remaining}', String(remaining)), 'info')
          }
        }
      },
      onError: (error) => {
        if (error.message === '该用户已关闭私信功能' || error.message === 'User has disabled direct messages') {
          showToast(t('userDmDisabled'), 'warning')
        } else if (error.limitReached) {
          showToast(t('msgLimitReached'), 'warning')
        }
      },
      showToast: false,
      retryCount: 1,
    }
  )

  const { openLoginModal } = useLoginModal()

  const handleClick = async () => {
    if (!currentUserId) {
      openLoginModal(t('pleaseLogin'))
      return
    }

    if (currentUserId === targetUserId) {
      showToast(t('cannotMessageSelf'), 'warning')
      return
    }

    const data = await mutate()
    if (data?.conversation_id) {
      router.push(`/messages/${data.conversation_id}`)
    }
  }

  const sizeStyles = {
    sm: { padding: '10px 16px', fontSize: tokens.typography.fontSize.sm, borderRadius: tokens.radius.md, minHeight: '44px' },
    md: { padding: '12px 20px', fontSize: tokens.typography.fontSize.base, borderRadius: tokens.radius.lg, minHeight: '44px' },
    lg: { padding: '14px 24px', fontSize: tokens.typography.fontSize.md, borderRadius: tokens.radius.lg, minHeight: '48px' },
  }

  if (!currentUserId) {
    return (
      <button
        onClick={() => useLoginModal.getState().openLoginModal()}
        className="interactive-scale"
        style={{
          ...sizeStyles[size],
          width: fullWidth ? '100%' : 'auto',
          border: `1px solid var(--glass-border-medium)`,
          background: 'var(--glass-bg-light)',
          color: tokens.colors.text.primary,
          fontWeight: 700,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '6px',
          transition: 'all 200ms ease',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--glass-bg-medium, rgba(255,255,255,0.08))' }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--glass-bg-light)' }}
      >
        <MessageIcon size={size === 'sm' ? 14 : 16} />
        {t('directMessage')}
      </button>
    )
  }

  if (currentUserId === targetUserId) {
    return null
  }

  return (
    <button
      onClick={handleClick}
      aria-label="Send message"
      className="interactive-scale"
      disabled={isLoading}
      style={{
        ...sizeStyles[size],
        width: fullWidth ? '100%' : 'auto',
        border: `1px solid var(--glass-border-medium)`,
        background: 'var(--glass-bg-light)',
        color: tokens.colors.text.primary,
        fontWeight: 700,
        cursor: isLoading ? 'not-allowed' : 'pointer',
        opacity: isLoading ? 0.6 : 1,
        transition: 'all 200ms ease',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '6px',
      }}
      onMouseEnter={(e) => { if (!isLoading) e.currentTarget.style.background = 'var(--glass-bg-medium, rgba(255,255,255,0.08))' }}
      onMouseLeave={(e) => { if (!isLoading) e.currentTarget.style.background = 'var(--glass-bg-light)' }}
    >
      {isLoading ? (
        <ButtonSpinner size="xs" />
      ) : (
        <MessageIcon size={size === 'sm' ? 14 : 16} />
      )}
      {isLoading ? '...' : t('directMessage')}
    </button>
  )
}

function MessageIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  )
}
