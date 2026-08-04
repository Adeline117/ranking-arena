'use client'

import { useEffect, useRef, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { authedFetch } from '@/lib/api/client'
import { trackEvent } from '@/lib/analytics/track'
import { REFERRAL_REWARD_THRESHOLD, REFERRAL_ADVOCATE_PRO_DAYS } from '@/lib/constants/referral'
import {
  captureSettingsViewer,
  isSettingsViewerCurrent,
  type SettingsViewerSnapshot,
} from '@/app/(app)/settings/hooks/settings-viewer-scope'
import { useViewerOwnedState } from '@/lib/state/viewer-owned-state'
import {
  readReferralCodeCreation,
  readReferralSnapshot,
  type ReferralSnapshot,
} from '@/lib/referral/reward-contract'

type ReferralUiState = {
  data: ReferralSnapshot | null
  loading: boolean
  loadError: boolean
  mutationError: boolean
  copied: boolean
  generating: boolean
}

type ReferralOperation = {
  id: number
  viewer: SettingsViewerSnapshot
  controller: AbortController
}

const emptyReferralUiState = (): ReferralUiState => ({
  data: null,
  loading: true,
  loadError: false,
  mutationError: false,
  copied: false,
  generating: false,
})

function referralScopeKey(
  viewer: SettingsViewerSnapshot | null,
  fallback: { viewerKey: string; sessionGeneration: number }
): string {
  return viewer
    ? `${viewer.viewerKey}\u0000${viewer.sessionGeneration}`
    : `invalid:${fallback.viewerKey}\u0000${fallback.sessionGeneration}`
}

export default function ReferralCard() {
  const { t } = useLanguage()
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const currentViewer = captureSettingsViewer(auth)
  const scopeKey = referralScopeKey(currentViewer, auth)
  const [ui, setUi] = useViewerOwnedState<ReferralUiState>(
    emptyReferralUiState,
    emptyReferralUiState,
    scopeKey
  )
  const uiRef = useRef(ui)
  uiRef.current = ui
  const mountedRef = useRef(false)
  const nextOperationIdRef = useRef(0)
  const serverOperationRef = useRef<ReferralOperation | null>(null)
  const copyOperationRef = useRef<ReferralOperation | null>(null)
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)

  const viewerIsCurrent = (viewer: SettingsViewerSnapshot): boolean =>
    mountedRef.current && isSettingsViewerCurrent(viewer, authRef.current)

  const operationIsCurrent = (
    operation: ReferralOperation,
    operationRef: { current: ReferralOperation | null }
  ): boolean => operationRef.current?.id === operation.id && viewerIsCurrent(operation.viewer)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      serverOperationRef.current?.controller.abort()
      copyOperationRef.current?.controller.abort()
      serverOperationRef.current = null
      copyOperationRef.current = null
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
    }
  }, [])

  useEffect(() => {
    if (!currentViewer) return
    const operation: ReferralOperation = {
      id: ++nextOperationIdRef.current,
      viewer: currentViewer,
      controller: new AbortController(),
    }
    serverOperationRef.current = operation
    setUi((current) => ({
      ...current,
      loading: true,
      loadError: false,
      mutationError: false,
      generating: false,
    }))

    void (async () => {
      try {
        const result = await authedFetch<unknown>(
          '/api/referral',
          'GET',
          operation.viewer.accessToken,
          undefined,
          15_000,
          {
            expectedUserId: operation.viewer.userId,
            expectedSessionGeneration: operation.viewer.sessionGeneration,
            signal: operation.controller.signal,
          }
        )
        if (!operationIsCurrent(operation, serverOperationRef) || result.stale) return
        const nextData =
          result.ok && result.status === 200
            ? readReferralSnapshot(result.data, { ownerId: operation.viewer.userId })
            : null
        if (!nextData) throw new Error('Invalid referral acknowledgement')
        setUi((current) => ({ ...current, data: nextData }))
      } catch {
        if (operationIsCurrent(operation, serverOperationRef)) {
          setUi((current) => ({ ...current, loadError: true }))
        }
      } finally {
        if (operationIsCurrent(operation, serverOperationRef)) {
          setUi((current) => ({ ...current, loading: false }))
          serverOperationRef.current = null
        }
      }
    })()

    return () => {
      operation.controller.abort()
      if (serverOperationRef.current?.id === operation.id) serverOperationRef.current = null
    }
    // Access-token rotation does not change the viewer-owned resource identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadNonce, scopeKey])

  const generateCode = async () => {
    const viewer = captureSettingsViewer(authRef.current)
    const currentReferral = uiRef.current.data
    if (
      !viewer ||
      !currentReferral ||
      currentReferral.codeSource === 'custom' ||
      uiRef.current.generating ||
      serverOperationRef.current
    ) {
      return
    }
    const operation: ReferralOperation = {
      id: ++nextOperationIdRef.current,
      viewer,
      controller: new AbortController(),
    }
    serverOperationRef.current = operation
    setUi((current) => ({ ...current, generating: true, mutationError: false }))
    try {
      const result = await authedFetch<unknown>(
        '/api/referral',
        'POST',
        viewer.accessToken,
        { action: 'create' },
        15_000,
        {
          expectedUserId: viewer.userId,
          expectedSessionGeneration: viewer.sessionGeneration,
          signal: operation.controller.signal,
        }
      )
      if (!operationIsCurrent(operation, serverOperationRef) || result.stale) return
      const next =
        result.ok && result.status === 201
          ? readReferralCodeCreation(result.data, { ownerId: operation.viewer.userId })
          : null
      if (!next) throw new Error('Invalid referral creation acknowledgement')
      setUi((current) => ({
        ...current,
        data:
          current.data?.ownerId === operation.viewer.userId
            ? {
                ...current.data,
                referralCode: next.referralCode,
                referralLink: next.referralLink,
                codeSource: next.codeSource,
              }
            : current.data,
      }))
    } catch {
      if (operationIsCurrent(operation, serverOperationRef)) {
        setUi((current) => ({ ...current, mutationError: true }))
        // A concurrent tab can create the permanent code first. Reconcile the
        // owner snapshot so the UI does not offer an endless 409 retry loop.
        setReloadNonce((value) => value + 1)
      }
    } finally {
      if (operationIsCurrent(operation, serverOperationRef)) {
        setUi((current) => ({ ...current, generating: false }))
        serverOperationRef.current = null
      }
    }
  }

  const copyLink = async () => {
    const viewer = captureSettingsViewer(authRef.current)
    const link = uiRef.current.data?.referralLink
    if (!viewer || !link || copyOperationRef.current) return
    const operation: ReferralOperation = {
      id: ++nextOperationIdRef.current,
      viewer,
      controller: new AbortController(),
    }
    copyOperationRef.current = operation

    const finishCopy = () => {
      if (!operationIsCurrent(operation, copyOperationRef)) return
      setUi((current) => ({ ...current, copied: true }))
      trackEvent('copy_referral_link')
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
      copyTimeoutRef.current = setTimeout(() => {
        if (!operationIsCurrent(operation, copyOperationRef)) return
        setUi((current) => ({ ...current, copied: false }))
        copyOperationRef.current = null
        copyTimeoutRef.current = null
      }, 2000)
    }

    try {
      await navigator.clipboard.writeText(link)
      if (!operationIsCurrent(operation, copyOperationRef)) return
      finishCopy()
    } catch {
      if (!operationIsCurrent(operation, copyOperationRef)) return
      // Fallback for older browsers
      const textarea = document.createElement('textarea')
      textarea.value = link
      try {
        document.body.appendChild(textarea)
        textarea.select()
        const copied = document.execCommand('copy')
        if (copied && operationIsCurrent(operation, copyOperationRef)) finishCopy()
      } finally {
        textarea.remove()
      }
    }
  }

  if (!currentViewer) return null
  if (ui.loading && !ui.data) return null

  const { data, copied, generating, loadError, mutationError } = ui

  const progress = data ? Math.min(data.qualifiedReferralCount / REFERRAL_REWARD_THRESHOLD, 1) : 0
  const rewardStatus = data?.advocateReward.status ?? 'not_granted'
  const rewardActive = rewardStatus === 'active'
  const rewardStatusLabel = rewardActive
    ? t('referralRewardUnlocked')
    : rewardStatus === 'pending'
      ? t('processing')
      : rewardStatus === 'scheduled'
        ? `${t('processing')} · ${new Intl.DateTimeFormat().format(
            new Date(data?.advocateReward.entitlementStartsAt ?? 0)
          )}`
        : rewardStatus === 'expired'
          ? `${t('complete')} · ${new Intl.DateTimeFormat().format(
              new Date(data?.advocateReward.entitlementExpiresAt ?? 0)
            )}`
          : rewardStatus === 'revoked'
            ? t('apiKeyRevokedSection')
            : data
              ? `${data.qualifiedReferralCount}/${REFERRAL_REWARD_THRESHOLD}`
              : `0/${REFERRAL_REWARD_THRESHOLD}`

  if (!data) {
    return (
      <div
        role="alert"
        style={{
          background: tokens.glass.bg.medium,
          border: tokens.glass.border.light,
          borderRadius: tokens.radius.xl,
          padding: tokens.spacing[5],
          color: tokens.colors.text.secondary,
        }}
      >
        <p style={{ margin: `0 0 ${tokens.spacing[3]}` }}>{t('loadFailedRetryShort')}</p>
        <button
          type="button"
          onClick={() => setReloadNonce((value) => value + 1)}
          style={{
            minHeight: 44,
            padding: `0 ${tokens.spacing[4]}`,
            borderRadius: tokens.radius.lg,
            border: tokens.glass.border.light,
            background: tokens.glass.bg.light,
            color: tokens.colors.text.primary,
            cursor: 'pointer',
          }}
        >
          {t('retry')}
        </button>
      </div>
    )
  }

  return (
    <div
      style={{
        background: tokens.glass.bg.medium,
        border: tokens.glass.border.light,
        borderRadius: tokens.radius.xl,
        padding: tokens.spacing[5],
        backdropFilter: tokens.glass.blur.sm,
        WebkitBackdropFilter: tokens.glass.blur.sm,
      }}
    >
      {/* Header */}
      <h3
        style={{
          fontSize: tokens.typography.fontSize.lg,
          fontWeight: tokens.typography.fontWeight.semibold,
          color: tokens.colors.text.primary,
          marginBottom: tokens.spacing[1],
        }}
      >
        {t('referralInviteFriends')}
      </h3>
      <p
        style={{
          fontSize: tokens.typography.fontSize.sm,
          color: tokens.colors.text.secondary,
          marginBottom: tokens.spacing[4],
        }}
      >
        {t('referralRewardBannerTitle')
          .replace('{count}', String(REFERRAL_REWARD_THRESHOLD))
          .replace('{days}', String(REFERRAL_ADVOCATE_PRO_DAYS))}
      </p>

      {loadError && (
        <div
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: tokens.spacing[2],
            marginBottom: tokens.spacing[4],
            color: tokens.colors.text.secondary,
            fontSize: tokens.typography.fontSize.sm,
          }}
        >
          <span>{t('loadFailedRetryShort')}</span>
          <button
            type="button"
            disabled={ui.loading}
            onClick={() => setReloadNonce((value) => value + 1)}
            style={{
              minHeight: 44,
              padding: `0 ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.md,
              border: tokens.glass.border.light,
              background: 'transparent',
              color: tokens.colors.text.primary,
              cursor: ui.loading ? 'wait' : 'pointer',
            }}
          >
            {t('retry')}
          </button>
        </div>
      )}

      {/* Referral link */}
      {data.referralCode ? (
        <div style={{ marginBottom: tokens.spacing[4] }}>
          <div
            style={{
              display: 'flex',
              gap: tokens.spacing[2],
              alignItems: 'center',
            }}
          >
            <input
              type="text"
              readOnly
              aria-label={t('referralYourLink')}
              value={data.referralLink ?? ''}
              style={{
                flex: 1,
                minHeight: 44,
                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.lg,
                border: tokens.glass.border.light,
                background: tokens.glass.bg.light,
                color: tokens.colors.text.primary,
                fontSize: tokens.typography.fontSize.sm,
                outline: 'none',
              }}
            />
            <button
              type="button"
              onClick={copyLink}
              style={{
                minHeight: 44,
                padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.lg,
                border: 'none',
                background: copied ? tokens.colors.accent.success : tokens.colors.accent.primary,
                color: tokens.colors.white,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: tokens.typography.fontWeight.medium,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                transition: `all ${tokens.transition.base}`,
              }}
            >
              {copied ? t('copiedToClipboard') : t('copy')}
            </button>
          </div>
          {data.codeSource !== 'custom' && (
            <button
              type="button"
              onClick={generateCode}
              disabled={generating}
              style={{
                minHeight: 44,
                marginTop: tokens.spacing[2],
                padding: `0 ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.lg,
                border: tokens.glass.border.light,
                background: 'transparent',
                color: tokens.colors.text.tertiary,
                fontSize: tokens.typography.fontSize.sm,
                cursor: generating ? 'wait' : 'pointer',
              }}
            >
              {generating ? t('referralGenerating') : t('referralGenerate')}
            </button>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={generateCode}
          disabled={generating}
          style={{
            minHeight: 44,
            padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
            borderRadius: tokens.radius.lg,
            border: 'none',
            background: tokens.colors.accent.primary,
            color: tokens.colors.white,
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: tokens.typography.fontWeight.medium,
            cursor: generating ? 'wait' : 'pointer',
            marginBottom: tokens.spacing[4],
            opacity: generating ? 0.7 : 1,
          }}
        >
          {generating ? t('referralGenerating') : t('referralGenerate')}
        </button>
      )}

      {mutationError && (
        <p
          role="alert"
          style={{
            margin: `0 0 ${tokens.spacing[4]}`,
            color: tokens.colors.accent.error,
            fontSize: tokens.typography.fontSize.sm,
          }}
        >
          {t('actionFailedRetry')}
        </p>
      )}

      {/* Progress */}
      <div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginBottom: tokens.spacing[2],
          }}
        >
          <span
            style={{
              fontSize: tokens.typography.fontSize.sm,
              color: tokens.colors.text.secondary,
            }}
          >
            {t('referralReferredCount').replace('{count}', String(data.qualifiedReferralCount))}
          </span>
          <span
            style={{
              fontSize: tokens.typography.fontSize.sm,
              color: rewardActive ? tokens.colors.accent.success : tokens.colors.text.tertiary,
              fontWeight: rewardActive
                ? tokens.typography.fontWeight.semibold
                : tokens.typography.fontWeight.normal,
            }}
          >
            {rewardStatusLabel}
          </span>
        </div>
        {/* Progress bar */}
        <div
          style={{
            height: 6,
            borderRadius: tokens.radius.full,
            background: tokens.glass.bg.medium,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${progress * 100}%`,
              borderRadius: tokens.radius.full,
              background: rewardActive
                ? tokens.colors.accent.success
                : `linear-gradient(90deg, ${tokens.colors.accent.primary}, ${tokens.colors.accent.brand || tokens.colors.accent.primary})`,
              transition: 'width 0.3s ease',
            }}
          />
        </div>
      </div>
    </div>
  )
}
