'use client'

import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ThumbsUpIcon, CommentIcon } from '@/app/components/ui/icons'
import { useToast } from '@/app/components/ui/Toast'
import { useModalA11y } from '@/lib/hooks/useModalA11y'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { authedFetch } from '@/lib/api/client'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { logger } from '@/lib/logger'
import { readTipCheckoutAcknowledgement } from '@/lib/stripe/tip-client-contract'
import { features } from '@/lib/features'
import {
  captureSettingsViewer,
  isSettingsViewerCurrent,
  type SettingsViewerSnapshot,
} from '@/app/(app)/settings/hooks/settings-viewer-scope'

type Post = {
  id: string
  author_id?: string | null
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

type TipOperation = {
  amountCents: number
  controller: AbortController
  id: number
  modalGeneration: number
  postId: string
  recipientId: string
  resourceScopeKey: string
  viewer: SettingsViewerSnapshot
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function canonicalUuid(value: string | null | undefined): string | null {
  const normalized = value?.toLowerCase() ?? null
  return normalized && UUID_PATTERN.test(normalized) ? normalized : null
}

export default function PostFooterActions({ post }: { post: Post }) {
  const { showToast } = useToast()
  const { language: _language, t } = useLanguage()
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const viewer = captureSettingsViewer(auth)
  const canonicalPostId = canonicalUuid(post.id)
  const canonicalRecipientId = canonicalUuid(post.author_id)
  const resourceScopeKey = `${auth.viewerKey}\u0000${auth.sessionGeneration}\u0000${canonicalPostId ?? 'invalid-post'}\u0000${canonicalRecipientId ?? 'invalid-recipient'}`
  const resourceScopeKeyRef = useRef(resourceScopeKey)
  resourceScopeKeyRef.current = resourceScopeKey
  const tipDialogTitleId = useId()
  const [tipModalScope, setTipModalScope] = useState<string | null>(null)
  const tipModalScopeRef = useRef<string | null>(null)
  tipModalScopeRef.current = tipModalScope
  const [selectedAmount, setSelectedAmount] = useState(100)
  const [loading, setLoading] = useState(false)
  const mountedRef = useRef(false)
  const nextOperationIdRef = useRef(0)
  const modalGenerationRef = useRef(0)
  const operationRef = useRef<TipOperation | null>(null)
  const showTipModal = tipModalScope === resourceScopeKey

  const operationIsCurrent = useCallback(
    (operation: TipOperation): boolean =>
      mountedRef.current &&
      operationRef.current?.id === operation.id &&
      modalGenerationRef.current === operation.modalGeneration &&
      tipModalScopeRef.current === operation.resourceScopeKey &&
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
      tipModalScopeRef.current = null
      modalGenerationRef.current += 1
      setTipModalScope(null)
      setSelectedAmount(100)
    }
    const operation = operationRef.current
    if (!operation || operation.resourceScopeKey === resourceScopeKey) return
    operation.controller.abort()
    operationRef.current = null
    setLoading(false)
  }, [resourceScopeKey, tipModalScope])

  const openTipModal = () => {
    if (!canonicalPostId || !canonicalRecipientId) {
      showToast(t('createPaymentFailed'), 'error')
      return
    }
    modalGenerationRef.current += 1
    tipModalScopeRef.current = resourceScopeKey
    setTipModalScope(resourceScopeKey)
  }

  const closeTipModal = useCallback(() => {
    modalGenerationRef.current += 1
    tipModalScopeRef.current = null
    const operation = operationRef.current
    operation?.controller.abort()
    operationRef.current = null
    setLoading(false)
    setSelectedAmount(100)
    setTipModalScope(null)
  }, [])

  const handleTip = async () => {
    if (
      operationRef.current ||
      loading ||
      tipModalScopeRef.current !== resourceScopeKey ||
      !canonicalPostId ||
      !canonicalRecipientId
    ) {
      return
    }
    const currentViewer = captureSettingsViewer(authRef.current)
    if (!currentViewer || resourceScopeKeyRef.current !== resourceScopeKey) {
      if (!authRef.current.authChecked || authRef.current.loading) return
      showToast(t('loginToTip'), 'warning')
      closeTipModal()
      return
    }

    const operation: TipOperation = {
      amountCents: selectedAmount,
      controller: new AbortController(),
      id: ++nextOperationIdRef.current,
      modalGeneration: modalGenerationRef.current,
      postId: canonicalPostId,
      recipientId: canonicalRecipientId,
      resourceScopeKey,
      viewer: currentViewer,
    }
    operationRef.current = operation
    setLoading(true)
    try {
      const result = await authedFetch<unknown>(
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
      if (!result.ok || result.status !== 200) {
        showToast(t('createPaymentFailed'), 'error')
        return
      }

      const acknowledgement = readTipCheckoutAcknowledgement(result.data, {
        viewerId: operation.viewer.userId,
        postId: operation.postId,
        recipientId: operation.recipientId,
        amountCents: operation.amountCents,
      })
      if (!acknowledgement) {
        showToast(t('createPaymentFailed'), 'error')
        return
      }
      window.location.assign(acknowledgement.url)
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

        {features.tipCheckout ? (
          <button
            type="button"
            className="ml-auto min-h-11 min-w-11 rounded-md px-3 py-2 transition-colors"
            style={{
              border: '1px solid var(--color-border-primary)',
              background: 'var(--color-bg-tertiary)',
            }}
            onClick={openTipModal}
          >
            {t('tip')}
          </button>
        ) : null}
      </div>

      {/* 打赏弹窗 */}
      {showTipModal && (
        <TipModalOverlay labelledBy={tipDialogTitleId} onClose={closeTipModal}>
          <div
            className="w-full max-w-sm rounded-lg p-6"
            style={{ background: 'var(--color-bg-secondary)', boxShadow: 'var(--shadow-elevated)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3
              id={tipDialogTitleId}
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
                  type="button"
                  className="min-h-11 rounded-lg px-2 py-2 text-sm font-medium transition-colors disabled:opacity-50"
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
                  aria-pressed={selectedAmount === cents}
                  disabled={loading}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="flex gap-3">
              <button
                type="button"
                className="min-h-11 flex-1 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors"
                style={{
                  background: 'var(--color-bg-tertiary)',
                  color: 'var(--color-text-secondary)',
                }}
                onClick={closeTipModal}
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                className="min-h-11 flex-1 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors disabled:opacity-50"
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
  labelledBy,
  onClose,
  children,
}: {
  labelledBy: string
  onClose: () => void
  children: React.ReactNode
}) {
  const modalRef = useRef<HTMLDivElement>(null)
  useModalA11y({ open: true, onClose, modalRef })

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      ref={modalRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      {children}
    </div>
  )
}
