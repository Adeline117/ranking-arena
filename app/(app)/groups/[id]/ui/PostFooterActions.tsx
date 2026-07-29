'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ThumbsUpIcon, CommentIcon } from '@/app/components/ui/icons'
import { useToast } from '@/app/components/ui/Toast'
import { useModalA11y } from '@/lib/hooks/useModalA11y'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { authedFetch } from '@/lib/api/client'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { logger } from '@/lib/logger'
import {
  captureSettingsViewer,
  isSettingsViewerCurrent,
  type SettingsViewerSnapshot,
} from '@/app/(app)/settings/hooks/settings-viewer-scope'

type Post = {
  id: string
  author_handle?: string | null
  like_count?: number | null
  comment_count?: number | null
}

// 打赏金额选项
const TIP_AMOUNTS = [
  { cents: 100, label: '$1' },
  { cents: 300, label: '$3' },
  { cents: 500, label: '$5' },
  { cents: 1000, label: '$10' },
]

type TipCheckoutResponse = {
  error?: unknown
  sessionId?: unknown
  url?: unknown
}

type TipOperation = {
  amountCents: number
  controller: AbortController
  id: number
  postId: string
  resourceScopeKey: string
  viewer: SettingsViewerSnapshot
}

const STRIPE_SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_]+$/

function checkoutUrl(value: TipCheckoutResponse | null): string | null {
  if (
    !value ||
    typeof value.sessionId !== 'string' ||
    !STRIPE_SESSION_ID_PATTERN.test(value.sessionId) ||
    typeof value.url !== 'string'
  ) {
    return null
  }
  try {
    const url = new URL(value.url)
    return url.protocol === 'https:' &&
      url.hostname === 'checkout.stripe.com' &&
      url.pathname.includes(value.sessionId)
      ? url.href
      : null
  } catch {
    return null
  }
}

export default function PostFooterActions({ post }: { post: Post }) {
  const { showToast } = useToast()
  const { language: _language, t } = useLanguage()
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const viewer = captureSettingsViewer(auth)
  const resourceScopeKey = `${auth.viewerKey}\u0000${auth.sessionGeneration}\u0000${post.id}`
  const resourceScopeKeyRef = useRef(resourceScopeKey)
  resourceScopeKeyRef.current = resourceScopeKey
  const [tipModalScope, setTipModalScope] = useState<string | null>(null)
  const [selectedAmount, setSelectedAmount] = useState(100)
  const [loading, setLoading] = useState(false)
  const mountedRef = useRef(false)
  const nextOperationIdRef = useRef(0)
  const operationRef = useRef<TipOperation | null>(null)
  const showTipModal = tipModalScope === resourceScopeKey

  const operationIsCurrent = useCallback(
    (operation: TipOperation): boolean =>
      mountedRef.current &&
      operationRef.current?.id === operation.id &&
      resourceScopeKeyRef.current === operation.resourceScopeKey &&
      isSettingsViewerCurrent(operation.viewer, authRef.current),
    []
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      operationRef.current?.controller.abort()
      operationRef.current = null
    }
  }, [])

  useEffect(() => {
    if (tipModalScope && tipModalScope !== resourceScopeKey) {
      setTipModalScope(null)
      setSelectedAmount(100)
    }
    const operation = operationRef.current
    if (!operation || operation.resourceScopeKey === resourceScopeKey) return
    operation.controller.abort()
    operationRef.current = null
    setLoading(false)
  }, [resourceScopeKey, tipModalScope])

  const handleTip = async () => {
    if (operationRef.current || loading || tipModalScope !== resourceScopeKey) return
    const currentViewer = captureSettingsViewer(authRef.current)
    if (!currentViewer || resourceScopeKeyRef.current !== resourceScopeKey) {
      if (!authRef.current.authChecked || authRef.current.loading) return
      showToast(t('loginToTip'), 'warning')
      setTipModalScope(null)
      return
    }

    const operation: TipOperation = {
      amountCents: selectedAmount,
      controller: new AbortController(),
      id: ++nextOperationIdRef.current,
      postId: post.id,
      resourceScopeKey,
      viewer: currentViewer,
    }
    operationRef.current = operation
    setLoading(true)
    try {
      const result = await authedFetch<TipCheckoutResponse>(
        '/api/tip/checkout',
        'POST',
        operation.viewer.accessToken,
        {
          post_id: operation.postId,
          amount_cents: operation.amountCents,
        },
        20_000,
        {
          expectedUserId: operation.viewer.userId,
          expectedSessionGeneration: operation.viewer.sessionGeneration,
          signal: operation.controller.signal,
        }
      )
      if (!operationIsCurrent(operation) || result.stale) return
      if (!result.ok) {
        const error =
          typeof result.data?.error === 'string' ? result.data.error : t('createPaymentFailed')
        showToast(error, 'error')
        return
      }

      const url = checkoutUrl(result.data)
      if (!url) {
        showToast(t('createPaymentFailed'), 'error')
        return
      }
      window.location.href = url
    } catch (error) {
      if (operationIsCurrent(operation)) {
        logger.error('Tip error:', error)
        showToast(t('tipFailed'), 'error')
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

  const authPending = !viewer && (!auth.authChecked || auth.loading || Boolean(auth.userId))

  return (
    <>
      <div className="mt-3 flex items-center gap-4 text-xs opacity-70">
        <span>@{post.author_handle ?? 'user'}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <ThumbsUpIcon size={12} /> {post.like_count ?? 0}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <CommentIcon size={12} /> {post.comment_count ?? 0}
        </span>

        <button
          className="ml-auto rounded-md px-2 py-1 transition-colors"
          style={{
            border: '1px solid var(--color-border-primary)',
            background: 'var(--color-bg-tertiary)',
          }}
          onClick={() => setTipModalScope(resourceScopeKey)}
        >
          {t('tip')}
        </button>
      </div>

      {/* 打赏弹窗 */}
      {showTipModal && (
        <TipModalOverlay onClose={() => setTipModalScope(null)}>
          <div
            className="w-full max-w-sm rounded-lg p-6"
            style={{ background: 'var(--color-bg-secondary)', boxShadow: 'var(--shadow-elevated)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3
              className="mb-4 text-lg font-semibold"
              style={{ color: 'var(--color-text-primary)' }}
            >
              {t('tipAuthor')} @{post.author_handle ?? 'user'}
            </h3>

            <p className="mb-4 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
              {t('selectTipAmount')}
            </p>

            <div className="mb-6 grid grid-cols-4 gap-2">
              {TIP_AMOUNTS.map(({ cents, label }) => (
                <button
                  key={cents}
                  className="rounded-lg py-2 text-sm font-medium transition-colors"
                  style={{
                    background:
                      selectedAmount === cents
                        ? 'var(--color-accent-primary)'
                        : 'var(--color-bg-tertiary)',
                    color:
                      selectedAmount === cents
                        ? 'var(--color-on-accent)'
                        : 'var(--color-text-secondary)',
                  }}
                  onClick={() => setSelectedAmount(cents)}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="flex gap-3">
              <button
                className="flex-1 rounded-lg py-2.5 text-sm font-medium transition-colors"
                style={{
                  background: 'var(--color-bg-tertiary)',
                  color: 'var(--color-text-secondary)',
                }}
                onClick={() => setTipModalScope(null)}
              >
                {t('cancel')}
              </button>
              <button
                className="flex-1 rounded-lg py-2.5 text-sm font-medium transition-colors disabled:opacity-50"
                style={{ background: 'var(--color-accent-primary)', color: 'var(--foreground)' }}
                onClick={handleTip}
                disabled={loading || authPending}
              >
                {loading
                  ? t('processing')
                  : `${t('pay')} ${TIP_AMOUNTS.find((a) => a.cents === selectedAmount)?.label}`}
              </button>
            </div>
          </div>
        </TipModalOverlay>
      )}
    </>
  )
}

/** Overlay wrapper: scroll lock + Escape key + backdrop click */
function TipModalOverlay({
  onClose,
  children,
}: {
  onClose: () => void
  children: React.ReactNode
}) {
  useModalA11y({ open: true, onClose })

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      {children}
    </div>
  )
}
