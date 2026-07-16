'use client'

import { useEffect, useRef } from 'react'
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

interface ReferralData {
  referral_code: string
  referral_count: number
  referral_link: string
}

type ReferralUiState = {
  data: ReferralData | null
  loading: boolean
  copied: boolean
  generating: boolean
}

type ReferralOperation = {
  id: number
  viewer: SettingsViewerSnapshot
}

const emptyReferralUiState = (): ReferralUiState => ({
  data: null,
  loading: true,
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

function readReferralData(value: unknown): ReferralData | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<ReferralData>
  if (
    typeof candidate.referral_code !== 'string' ||
    typeof candidate.referral_link !== 'string' ||
    typeof candidate.referral_count !== 'number' ||
    !Number.isFinite(candidate.referral_count)
  ) {
    return null
  }
  return {
    referral_code: candidate.referral_code,
    referral_count: Math.max(0, candidate.referral_count),
    referral_link: candidate.referral_link,
  }
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
    }
    const controller = new AbortController()
    serverOperationRef.current = operation
    setUi((current) => ({ ...current, data: null, loading: true, generating: false }))

    void (async () => {
      try {
        const result = await authedFetch<ReferralData>(
          '/api/referral',
          'GET',
          operation.viewer.accessToken,
          undefined,
          15_000,
          {
            expectedUserId: operation.viewer.userId,
            expectedSessionGeneration: operation.viewer.sessionGeneration,
            signal: controller.signal,
          }
        )
        if (!operationIsCurrent(operation, serverOperationRef) || result.stale) return
        const nextData = result.ok ? readReferralData(result.data) : null
        if (nextData) setUi((current) => ({ ...current, data: nextData }))
      } catch {
        // Referral data is best-effort; the owner barrier still clears loading.
      } finally {
        if (operationIsCurrent(operation, serverOperationRef)) {
          setUi((current) => ({ ...current, loading: false }))
          serverOperationRef.current = null
        }
      }
    })()

    return () => {
      controller.abort()
      if (serverOperationRef.current?.id === operation.id) serverOperationRef.current = null
    }
    // Access-token rotation does not change the viewer-owned resource identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey])

  const generateCode = async () => {
    const viewer = captureSettingsViewer(authRef.current)
    if (!viewer || uiRef.current.generating || serverOperationRef.current) return
    const operation: ReferralOperation = {
      id: ++nextOperationIdRef.current,
      viewer,
    }
    serverOperationRef.current = operation
    setUi((current) => ({ ...current, generating: true }))
    try {
      const result = await authedFetch<Partial<ReferralData>>(
        '/api/referral',
        'POST',
        viewer.accessToken,
        undefined,
        15_000,
        {
          expectedUserId: viewer.userId,
          expectedSessionGeneration: viewer.sessionGeneration,
        }
      )
      if (!operationIsCurrent(operation, serverOperationRef) || result.stale || !result.ok) return
      const next = result.data
      if (
        next &&
        typeof next.referral_code === 'string' &&
        typeof next.referral_link === 'string'
      ) {
        setUi((current) => ({
          ...current,
          data: {
            referral_code: next.referral_code!,
            referral_link: next.referral_link!,
            referral_count: current.data?.referral_count ?? 0,
          },
        }))
      }
    } catch {
      // Intentionally swallowed
    } finally {
      if (operationIsCurrent(operation, serverOperationRef)) {
        setUi((current) => ({ ...current, generating: false }))
        serverOperationRef.current = null
      }
    }
  }

  const copyLink = async () => {
    const viewer = captureSettingsViewer(authRef.current)
    const link = uiRef.current.data?.referral_link
    if (!viewer || !link) return
    const operation: ReferralOperation = {
      id: ++nextOperationIdRef.current,
      viewer,
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
  if (ui.loading) return null

  const { data, copied, generating } = ui

  const progress = data ? Math.min(data.referral_count / REFERRAL_REWARD_THRESHOLD, 1) : 0
  const rewardEarned = data ? data.referral_count >= REFERRAL_REWARD_THRESHOLD : false

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

      {/* Referral link */}
      {data?.referral_code ? (
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
              value={data.referral_link}
              style={{
                flex: 1,
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
              onClick={copyLink}
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.lg,
                border: 'none',
                background: copied ? tokens.colors.accent.success : tokens.colors.accent.primary,
                color: '#fff',
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
        </div>
      ) : (
        <button
          onClick={generateCode}
          disabled={generating}
          style={{
            padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
            borderRadius: tokens.radius.lg,
            border: 'none',
            background: tokens.colors.accent.primary,
            color: '#fff',
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

      {/* Progress */}
      {data && (
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
              {t('referralReferredCount').replace('{count}', String(data.referral_count))}
            </span>
            <span
              style={{
                fontSize: tokens.typography.fontSize.sm,
                color: rewardEarned ? tokens.colors.accent.success : tokens.colors.text.tertiary,
                fontWeight: rewardEarned
                  ? tokens.typography.fontWeight.semibold
                  : tokens.typography.fontWeight.normal,
              }}
            >
              {rewardEarned
                ? t('referralRewardUnlocked')
                : `${data.referral_count}/${REFERRAL_REWARD_THRESHOLD}`}
            </span>
          </div>
          {/* Progress bar */}
          <div
            style={{
              height: 6,
              borderRadius: 3,
              background: tokens.glass.bg.medium,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${progress * 100}%`,
                borderRadius: 3,
                background: rewardEarned
                  ? tokens.colors.accent.success
                  : `linear-gradient(90deg, ${tokens.colors.accent.primary}, ${tokens.colors.accent.brand || tokens.colors.accent.primary})`,
                transition: 'width 0.3s ease',
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
