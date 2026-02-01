'use client'

import { useRouter } from 'next/navigation'
import { useToast } from './Toast'
import { ButtonSpinner } from './LoadingSpinner'
import { useApiMutation } from '@/lib/hooks/useApiMutation'
import { apiRequest } from '@/lib/api/client'
import { supabase } from '@/lib/supabase/client'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

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
        router.push(`/messages/${data.conversation_id}`)
      },
      onError: (error) => {
        if (error.message === '该用户已关闭私信功能') {
          showToast(t('userDmDisabled'), 'warning')
        } else if (error.limitReached) {
          showToast(t('msgLimitReached'), 'warning')
        }
      },
      showToast: false,
      retryCount: 1,
    }
  )

  const handleClick = () => {
    if (!currentUserId) {
      showToast(t('pleaseLogin'), 'warning')
      router.push('/login')
      return
    }

    if (currentUserId === targetUserId) {
      showToast(t('cannotMessageSelf'), 'warning')
      return
    }

    mutate()
  }

  const sizeStyles = {
    sm: { padding: '10px 16px', fontSize: '13px', borderRadius: '8px', minHeight: '44px' },
    md: { padding: '12px 20px', fontSize: '14px', borderRadius: '10px', minHeight: '44px' },
    lg: { padding: '14px 24px', fontSize: '15px', borderRadius: '12px', minHeight: '48px' },
  }

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
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '6px',
        }}
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
