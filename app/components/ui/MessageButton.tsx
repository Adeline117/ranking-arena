'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useToast } from './Toast'
import { ButtonSpinner } from './LoadingSpinner'
import { authedFetch } from '@/lib/api/client'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'
import { BUTTON_SIZE_STYLES, MessageIcon } from './button-styles'
import {
  captureSettingsViewer,
  isSettingsViewerCurrent,
  type SettingsViewerSnapshot,
} from '@/app/(app)/settings/hooks/settings-viewer-scope'
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
  conversation_id?: unknown
  sender_id?: unknown
  receiver_id?: unknown
  can_message?: unknown
  message_limit?: unknown
  is_mutual_follow?: unknown
  error?: unknown
  error_code?: unknown
}

type MessageLimit = {
  reached: boolean
  max: number
  sent: number
}

type StartMessageAcknowledgement = {
  conversation_id: string
  sender_id: string
  receiver_id: string
  can_message: boolean
  message_limit: null | {
    reached: boolean
    max: number
    sent: number
  }
  is_mutual_follow: boolean
}

type MessageOperation = {
  controller: AbortController
  currentUserId: string
  id: number
  resourceScopeKey: string
  targetUserId: string
  viewer: SettingsViewerSnapshot
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readMessageLimit(value: unknown): MessageLimit | null | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  const { reached, max, sent } = value
  if (
    typeof reached !== 'boolean' ||
    typeof max !== 'number' ||
    !Number.isSafeInteger(max) ||
    max < 1 ||
    typeof sent !== 'number' ||
    !Number.isSafeInteger(sent) ||
    sent < 0 ||
    reached !== sent >= max
  ) {
    return undefined
  }
  return { reached, max, sent }
}

function readStartMessageAcknowledgement(
  value: StartMessageResponse | null,
  operation: MessageOperation
): StartMessageAcknowledgement | null {
  if (!isRecord(value)) return null
  const messageLimit = readMessageLimit(value.message_limit)
  if (
    typeof value.conversation_id !== 'string' ||
    !UUID_PATTERN.test(value.conversation_id) ||
    value.sender_id !== operation.currentUserId ||
    value.receiver_id !== operation.targetUserId ||
    typeof value.can_message !== 'boolean' ||
    typeof value.is_mutual_follow !== 'boolean' ||
    messageLimit === undefined ||
    value.can_message !== (messageLimit?.reached !== true) ||
    (value.is_mutual_follow && messageLimit !== null)
  ) {
    return null
  }
  return {
    conversation_id: value.conversation_id,
    sender_id: value.sender_id,
    receiver_id: value.receiver_id,
    can_message: value.can_message,
    message_limit: messageLimit,
    is_mutual_follow: value.is_mutual_follow,
  }
}

function responseError(payload: StartMessageResponse | null): string {
  return typeof payload?.error === 'string' ? payload.error : ''
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
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const viewer = captureSettingsViewer(auth)
  const exactViewer = viewer?.userId === currentUserId ? viewer : null
  const resourceScopeKey = `${auth.viewerKey}\u0000${auth.sessionGeneration}\u0000${currentUserId ?? 'anonymous'}\u0000${targetUserId}`
  const resourceScopeKeyRef = useRef(resourceScopeKey)
  resourceScopeKeyRef.current = resourceScopeKey
  const mountedRef = useRef(false)
  const nextOperationIdRef = useRef(0)
  const operationRef = useRef<MessageOperation | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const operationIsCurrent = useCallback(
    (operation: MessageOperation): boolean =>
      mountedRef.current &&
      operationRef.current?.id === operation.id &&
      resourceScopeKeyRef.current === operation.resourceScopeKey &&
      isSettingsViewerCurrent(operation.viewer, authRef.current),
    []
  )
  const redirectToLogin = useCallback(() => {
    router.push(
      queueProfileActionLogin({
        action: 'message-user',
        target: profileUserTarget(targetUserId),
        fallbackPath: loginReturnPath,
        initiatingUserId: currentUserId,
      })
    )
  }, [currentUserId, loginReturnPath, router, targetUserId])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      operationRef.current?.controller.abort()
      operationRef.current = null
    }
  }, [])

  useEffect(() => {
    const activeOperation = operationRef.current
    if (!activeOperation || activeOperation.resourceScopeKey === resourceScopeKey) return
    activeOperation.controller.abort()
    operationRef.current = null
    setIsLoading(false)
  }, [resourceScopeKey])

  const handleClick = useCallback(async () => {
    if (!currentUserId) {
      redirectToLogin()
      return
    }

    if (currentUserId === targetUserId) {
      showToast(t('cannotMessageSelf'), 'warning')
      return
    }

    const currentViewer = captureSettingsViewer(authRef.current)
    if (
      !currentViewer ||
      currentViewer.userId !== currentUserId ||
      resourceScopeKeyRef.current !== resourceScopeKey
    ) {
      if (authRef.current.authChecked && !authRef.current.loading && !authRef.current.userId) {
        showToast(t('loginExpiredPleaseRelogin'), 'error')
        redirectToLogin()
      }
      return
    }

    if (operationRef.current) return

    const operation: MessageOperation = {
      controller: new AbortController(),
      currentUserId,
      id: ++nextOperationIdRef.current,
      resourceScopeKey,
      targetUserId,
      viewer: currentViewer,
    }
    operationRef.current = operation
    setIsLoading(true)

    try {
      const result = await authedFetch<StartMessageResponse>(
        '/api/messages/start',
        'POST',
        operation.viewer.accessToken,
        { receiverId: operation.targetUserId },
        15_000,
        {
          expectedUserId: operation.viewer.userId,
          expectedSessionGeneration: operation.viewer.sessionGeneration,
          signal: operation.controller.signal,
        }
      )
      if (!operationIsCurrent(operation) || result.stale) return

      if (result.status === 401) {
        showToast(t('loginExpiredPleaseRelogin'), 'error')
        redirectToLogin()
        return
      }

      if (!result.ok) {
        const error = responseError(result.data)
        if (error.includes('disabled direct messages') || error.includes('关闭私信')) {
          showToast(t('userDmDisabled'), 'warning')
        } else if (result.status === 403) {
          showToast(t('msgLimitReached'), 'warning')
        } else {
          showToast(t('unexpectedError'), 'error')
        }
        return
      }

      const acknowledgement = readStartMessageAcknowledgement(result.data, operation)
      if (!acknowledgement) {
        showToast(t('unexpectedError'), 'error')
        return
      }
      if (!acknowledgement.can_message) {
        showToast(t('msgLimitReached'), 'warning')
        return
      }
      if (acknowledgement.message_limit && !acknowledgement.is_mutual_follow) {
        const remaining = acknowledgement.message_limit.max - acknowledgement.message_limit.sent
        if (remaining > 0 && remaining < 3) {
          showToast(t('msgLimitWarning').replace('{remaining}', String(remaining)), 'info')
        }
      }
      router.push(`/messages/${acknowledgement.conversation_id}`)
    } catch {
      if (operationIsCurrent(operation)) {
        showToast(t('unexpectedError'), 'error')
      }
    } finally {
      const ownsOperation = operationRef.current?.id === operation.id
      const isCurrent = operationIsCurrent(operation)
      if (ownsOperation) {
        operationRef.current = null
        if (isCurrent) setIsLoading(false)
      }
    }
  }, [
    currentUserId,
    operationIsCurrent,
    redirectToLogin,
    resourceScopeKey,
    router,
    showToast,
    t,
    targetUserId,
  ])

  useEffect(() => {
    if (!exactViewer || isLoading) return
    const action = consumeProfileActionLogin({
      actions: ['message-user'],
      target: profileUserTarget(targetUserId),
      currentUserId,
    })
    if (action === 'message-user' && currentUserId !== targetUserId) {
      void handleClick()
    }
  }, [currentUserId, exactViewer, handleClick, isLoading, targetUserId])

  const sizeStyles = BUTTON_SIZE_STYLES
  const activeLoading = isLoading && operationRef.current?.resourceScopeKey === resourceScopeKey
  const authPending =
    Boolean(currentUserId) &&
    !exactViewer &&
    (!auth.authChecked || auth.loading || Boolean(auth.userId))

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
          fontWeight: tokens.typography.fontWeight.bold,
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
      disabled={activeLoading || authPending}
      style={{
        ...sizeStyles[size],
        width: fullWidth ? '100%' : 'auto',
        border: `1px solid var(--glass-border-medium)`,
        background: 'var(--glass-bg-light)',
        color: tokens.colors.text.primary,
        fontWeight: tokens.typography.fontWeight.bold,
        cursor: activeLoading || authPending ? 'not-allowed' : 'pointer',
        opacity: activeLoading || authPending ? 0.6 : 1,
        transition: 'all 200ms ease',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: tokens.spacing[1.5],
      }}
      onMouseEnter={(e) => {
        if (!activeLoading && !authPending)
          e.currentTarget.style.background = 'var(--glass-bg-medium, rgba(255,255,255,0.08))'
      }}
      onMouseLeave={(e) => {
        if (!activeLoading && !authPending)
          e.currentTarget.style.background = 'var(--glass-bg-light)'
      }}
    >
      {activeLoading ? <ButtonSpinner size="xs" /> : <MessageIcon size={size === 'sm' ? 14 : 16} />}
      {activeLoading ? '...' : t('directMessage')}
    </button>
  )
}
