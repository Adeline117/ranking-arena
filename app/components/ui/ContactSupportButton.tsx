'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { useToast } from './Toast'
import { tokens } from '@/lib/design-tokens'
import { BUTTON_SIZE_STYLES, MessageIcon } from './button-styles'
import { authedFetch } from '@/lib/api/client'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { logger } from '@/lib/logger'
import {
  captureSettingsViewer,
  isSettingsViewerCurrent,
  type SettingsViewerSnapshot,
} from '@/app/(app)/settings/hooks/settings-viewer-scope'

const SUPPORT_HANDLE = 'Adeline'

type ContactSupportButtonProps = {
  size?: 'sm' | 'md' | 'lg'
  fullWidth?: boolean
  variant?: 'default' | 'link' | 'card'
  label?: string
  className?: string
}

type StartSupportConversationResponse = {
  can_message?: unknown
  conversation_id?: unknown
  error?: unknown
  receiver_id?: unknown
  sender_id?: unknown
}

type SupportOperation = {
  controller: AbortController
  id: number
  resourceScopeKey: string
  supportUserId: string | null
  viewer: SettingsViewerSnapshot
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function supportConversationId(
  value: StartSupportConversationResponse | null,
  operation: SupportOperation
): string | null {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.conversation_id !== 'string' ||
    !UUID_PATTERN.test(value.conversation_id) ||
    value.sender_id !== operation.viewer.userId ||
    value.receiver_id !== operation.supportUserId ||
    value.can_message !== true
  ) {
    return null
  }
  return value.conversation_id
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
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const viewer = captureSettingsViewer(auth)
  const resourceScopeKey = `${auth.viewerKey}\u0000${auth.sessionGeneration}`
  const resourceScopeKeyRef = useRef(resourceScopeKey)
  resourceScopeKeyRef.current = resourceScopeKey
  const [loading, setLoading] = useState(false)
  const mountedRef = useRef(false)
  const nextOperationIdRef = useRef(0)
  const operationRef = useRef<SupportOperation | null>(null)
  const supportUserIdRef = useRef<string | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      operationRef.current?.controller.abort()
      operationRef.current = null
    }
  }, [])

  useEffect(() => {
    const operation = operationRef.current
    if (!operation || operation.resourceScopeKey === resourceScopeKey) return
    operation.controller.abort()
    operationRef.current = null
    setLoading(false)
  }, [resourceScopeKey])

  const operationIsCurrent = useCallback(
    (operation: SupportOperation): boolean =>
      mountedRef.current &&
      operationRef.current?.id === operation.id &&
      resourceScopeKeyRef.current === operation.resourceScopeKey &&
      isSettingsViewerCurrent(operation.viewer, authRef.current),
    []
  )

  // Resolved lazily on click (and cached) so anonymous visitors never
  // trigger a user_profiles query. ilike = case-insensitive handle match.
  const resolveSupportUserId = useCallback(async (): Promise<string | null> => {
    if (supportUserIdRef.current) return supportUserIdRef.current

    const { data: supportUser } = await supabase
      .from('user_profiles')
      .select('id')
      .ilike('handle', SUPPORT_HANDLE)
      .maybeSingle()

    supportUserIdRef.current = supportUser?.id || null
    return supportUserIdRef.current
  }, [])

  const handleClick = async () => {
    if (operationRef.current || loading) return
    const currentViewer = captureSettingsViewer(authRef.current)
    if (!currentViewer || resourceScopeKeyRef.current !== resourceScopeKey) {
      if (!authRef.current.authChecked || authRef.current.loading) return
      showToast(t('pleaseLoginToContactSupport'), 'warning')
      router.push('/login?redirect=/help')
      return
    }

    const operation: SupportOperation = {
      controller: new AbortController(),
      id: ++nextOperationIdRef.current,
      resourceScopeKey,
      supportUserId: null,
      viewer: currentViewer,
    }
    operationRef.current = operation
    setLoading(true)
    try {
      operation.supportUserId = await resolveSupportUserId()
      if (!operationIsCurrent(operation)) return
      if (!operation.supportUserId) {
        showToast(t('supportUnavailable'), 'error')
        return
      }
      if (operation.viewer.userId === operation.supportUserId) {
        showToast(t('youAreSupport'), 'info')
        return
      }

      const result = await authedFetch<StartSupportConversationResponse>(
        '/api/messages/start',
        'POST',
        operation.viewer.accessToken,
        { receiverId: operation.supportUserId },
        15_000,
        {
          expectedUserId: operation.viewer.userId,
          expectedSessionGeneration: operation.viewer.sessionGeneration,
          signal: operation.controller.signal,
        }
      )
      if (!operationIsCurrent(operation) || result.stale) return
      if (result.ok) {
        const conversationId = supportConversationId(result.data, operation)
        if (conversationId) {
          router.push(`/messages/${conversationId}`)
        } else {
          showToast(t('cannotContactSupport'), 'error')
        }
      } else {
        const error = typeof result.data?.error === 'string' ? result.data.error : ''
        if (
          error === '该用户已关闭私信功能' ||
          error === 'User has disabled direct messages' ||
          error === 'This user has disabled direct messages'
        ) {
          showToast(t('supportCannotReceiveMessages'), 'warning')
        } else {
          showToast(error || t('cannotContactSupport'), 'error')
        }
      }
    } catch (error) {
      if (operationIsCurrent(operation)) {
        logger.error('Contact support error:', error)
        showToast(t('operationFailedRetry'), 'error')
      }
    } finally {
      const ownsOperation = operationRef.current?.id === operation.id
      const isCurrent = operationIsCurrent(operation)
      if (ownsOperation) {
        operationRef.current = null
        if (isCurrent) setLoading(false)
      }
    }
  }

  const defaultLabel = label || t('contactSupport')

  const sizeStyles = BUTTON_SIZE_STYLES
  const authPending = !viewer && (!auth.authChecked || auth.loading || Boolean(auth.userId))
  const buttonDisabled = loading || authPending

  if (variant === 'link') {
    return (
      <button
        onClick={handleClick}
        aria-label="Contact support"
        disabled={buttonDisabled}
        className={className}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--color-pro-gradient-start)',
          cursor: buttonDisabled ? 'not-allowed' : 'pointer',
          textDecoration: 'underline',
          padding: 0,
          fontSize: 'inherit',
          fontWeight: tokens.typography.fontWeight.medium,
          opacity: buttonDisabled ? 0.6 : 1,
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
        disabled={buttonDisabled}
        className={className}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[3],
          padding: tokens.spacing[4],
          background: 'var(--color-bg-secondary)',
          border: '1px solid var(--color-border-primary)',
          borderRadius: tokens.radius.xl,
          cursor: buttonDisabled ? 'not-allowed' : 'pointer',
          opacity: buttonDisabled ? 0.6 : 1,
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
              fontWeight: tokens.typography.fontWeight.bold,
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
      disabled={buttonDisabled}
      className={className}
      style={{
        ...sizeStyles[size],
        width: fullWidth ? '100%' : 'auto',
        border: `1px solid var(--glass-border-medium)`,
        background: 'var(--glass-bg-light)',
        color: tokens.colors.text.primary,
        fontWeight: tokens.typography.fontWeight.bold,
        cursor: buttonDisabled ? 'not-allowed' : 'pointer',
        opacity: buttonDisabled ? 0.6 : 1,
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
