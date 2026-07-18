'use client'

import { useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useToast } from './Toast'
import { ButtonSpinner } from './LoadingSpinner'
import { useApiMutation } from '@/lib/hooks/useApiMutation'
import { apiRequest } from '@/lib/api/client'
import { supabase } from '@/lib/supabase/client'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'
import { BUTTON_SIZE_STYLES, MessageIcon } from './button-styles'
import {
  consumeProfileActionLogin,
  profileUserTarget,
  queueProfileActionLogin,
} from '@/lib/auth/profile-action-login'

type MessageButtonProps = {
  targetUserId: string
  currentUserId: string | null
  size?: 'sm' | 'md' | 'lg'
  fullWidth?: boolean
  loginReturnPath?: string
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
  fullWidth = false,
  loginReturnPath,
}: MessageButtonProps) {
  const router = useRouter()
  const { showToast } = useToast()
  const { t } = useLanguage()
  const redirectToLogin = useCallback(() => {
    router.push(
      queueProfileActionLogin({
        action: 'message-user',
        target: profileUserTarget(targetUserId),
        fallbackPath: loginReturnPath,
      })
    )
  }, [loginReturnPath, router, targetUserId])

  const { mutate, isLoading } = useApiMutation<StartMessageResponse, void>(
    async () => {
      // Get fresh access token for auth
      const { data: sessionData } = await supabase.auth.getSession()
      const token = sessionData.session?.access_token
      if (!token) {
        // Session expired — return structured error so onError can handle it
        return {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: t('loginExpiredPleaseRelogin'),
          },
        }
      }
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` }

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
        if (error.code === 'UNAUTHORIZED') {
          showToast(t('loginExpiredPleaseRelogin'), 'error')
          redirectToLogin()
        } else if (
          error.message?.includes('disabled direct messages') ||
          error.message?.includes('关闭私信')
        ) {
          showToast(t('userDmDisabled'), 'warning')
        } else if (error.limitReached || error.code === 'PERMISSION_DENIED') {
          showToast(t('msgLimitReached'), 'warning')
        } else {
          showToast(t('unexpectedError'), 'error')
        }
      },
      showToast: false,
      retryCount: 0, // Don't retry auth errors — show login prompt instead
    }
  )

  const handleClick = useCallback(async () => {
    if (!currentUserId) {
      redirectToLogin()
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
  }, [currentUserId, mutate, redirectToLogin, router, showToast, t, targetUserId])

  useEffect(() => {
    if (!currentUserId || currentUserId === targetUserId || isLoading) return
    const action = consumeProfileActionLogin({
      actions: ['message-user'],
      target: profileUserTarget(targetUserId),
    })
    if (action === 'message-user') {
      void handleClick()
    }
  }, [currentUserId, handleClick, isLoading, targetUserId])

  const sizeStyles = BUTTON_SIZE_STYLES

  if (!currentUserId) {
    return (
      <button
        onClick={handleClick}
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
          gap: tokens.spacing[1.5],
          transition: 'all 200ms ease',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--glass-bg-medium, rgba(255,255,255,0.08))'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'var(--glass-bg-light)'
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
        gap: tokens.spacing[1.5],
      }}
      onMouseEnter={(e) => {
        if (!isLoading)
          e.currentTarget.style.background = 'var(--glass-bg-medium, rgba(255,255,255,0.08))'
      }}
      onMouseLeave={(e) => {
        if (!isLoading) e.currentTarget.style.background = 'var(--glass-bg-light)'
      }}
    >
      {isLoading ? <ButtonSpinner size="xs" /> : <MessageIcon size={size === 'sm' ? 14 : 16} />}
      {isLoading ? '...' : t('directMessage')}
    </button>
  )
}
