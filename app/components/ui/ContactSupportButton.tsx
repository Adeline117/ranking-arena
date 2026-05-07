'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { useToast } from './Toast'
import { tokens } from '@/lib/design-tokens'
import { BUTTON_SIZE_STYLES, MessageIcon } from './button-styles'
import { getCsrfHeaders } from '@/lib/api/client'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { logger } from '@/lib/logger'

const SUPPORT_HANDLE = 'adeline'
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
  const { t } = useLanguage()
  const [loading, setLoading] = useState(false)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [supportUserId, setSupportUserId] = useState<string | null>(null)
  const pendingRef = useRef(false)

  useEffect(() => {
    const init = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      setCurrentUserId(user?.id || null)

      const { data: supportUser } = await supabase
        .from('user_profiles')
        .select('id')
        .eq('handle', SUPPORT_HANDLE)
        .maybeSingle()

      if (supportUser) {
        setSupportUserId(supportUser.id)
      } else {
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('id')
          .eq('email', SUPPORT_EMAIL)
          .maybeSingle()

        if (profile) {
          setSupportUserId(profile.id)
        }
      }
    }

    init()
  }, [])

  const handleClick = async () => {
    // Check pending state FIRST to prevent race conditions
    if (pendingRef.current || loading) return
    pendingRef.current = true

    if (!currentUserId) {
      showToast(t('pleaseLoginToContactSupport'), 'warning')
      router.push('/login?redirect=/help')
      pendingRef.current = false
      return
    }

    if (!supportUserId) {
      showToast(t('supportUnavailable'), 'error')
      pendingRef.current = false
      return
    }

    if (currentUserId === supportUserId) {
      showToast(t('youAreSupport'), 'info')
      pendingRef.current = false
      return
    }

    setLoading(true)
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      const response = await fetch('/api/messages/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: session?.access_token ? `Bearer ${session.access_token}` : '',
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
        if (
          data.error === '该用户已关闭私信功能' ||
          data.error === 'User has disabled direct messages'
        ) {
          showToast(t('supportCannotReceiveMessages'), 'warning')
        } else {
          showToast(data.error || t('cannotContactSupport'), 'error')
        }
      }
    } catch (error) {
      logger.error('Contact support error:', error)
      showToast(t('operationFailedRetry'), 'error')
    } finally {
      setLoading(false)
      pendingRef.current = false
    }
  }

  const defaultLabel = label || t('contactSupport')

  const sizeStyles = BUTTON_SIZE_STYLES

  if (variant === 'link') {
    return (
      <button
        onClick={handleClick}
        aria-label="Contact support"
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
        {loading ? t('redirecting') : defaultLabel}
      </button>
    )
  }

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
        onMouseEnter={(e) => {
          if (!loading) e.currentTarget.style.borderColor = 'var(--color-accent-primary)'
        }}
        onMouseLeave={(e) => {
          if (!loading) e.currentTarget.style.borderColor = 'var(--color-border-primary)'
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
          <div
            style={{
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: 700,
              color: 'var(--color-text-secondary)',
            }}
          >
            {loading ? t('redirecting') : defaultLabel}
          </div>
          <div
            style={{
              fontSize: tokens.typography.fontSize.xs,
              color: 'var(--color-text-tertiary)',
              marginTop: 2,
            }}
          >
            {t('sendMessageToContactUs')}
          </div>
        </div>
      </button>
    )
  }

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className={className}
      style={{
        ...sizeStyles[size],
        width: fullWidth ? '100%' : 'auto',
        border: `1px solid var(--glass-border-medium)`,
        background: 'var(--glass-bg-light)',
        color: tokens.colors.text.primary,
        fontWeight: 700,
        cursor: loading ? 'not-allowed' : 'pointer',
        opacity: loading ? 0.6 : 1,
        transition: 'all 200ms ease',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: tokens.spacing[1.5],
      }}
      onMouseEnter={(e) => {
        if (!loading)
          e.currentTarget.style.background = 'var(--glass-bg-medium, rgba(255,255,255,0.08))'
      }}
      onMouseLeave={(e) => {
        if (!loading) e.currentTarget.style.background = 'var(--glass-bg-light)'
      }}
    >
      <MessageIcon size={size === 'sm' ? 14 : 16} />
      {loading ? '...' : defaultLabel}
    </button>
  )
}
