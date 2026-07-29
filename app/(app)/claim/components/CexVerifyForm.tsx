'use client'
import PasswordInput from '@/app/components/ui/PasswordInput'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { tokens, alpha, alpha as colorAlpha } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { Box, Text } from '@/app/components/base'
import { trackEvent } from '@/lib/analytics/track'
import { authedFetch } from '@/lib/api/client'
import { useToast } from '@/app/components/ui/Toast'
import { SearchResult, CEX_PLATFORMS } from './types'
import { buildTraderClaimLoginHref } from '@/lib/auth/trader-claim-login'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import {
  captureSettingsViewer,
  isSettingsViewerCurrent,
  type SettingsViewerSnapshot,
} from '@/app/(app)/settings/hooks/settings-viewer-scope'

type CexVerifyFormProps = {
  trader: SearchResult
  onSuccess: () => void
}

type ClaimOperation = {
  controller: AbortController
  viewer: SettingsViewerSnapshot
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function responseMessage(value: unknown, fallback: string): string {
  if (!isRecord(value)) return fallback
  if (typeof value.message === 'string' && value.message.trim()) return value.message.trim()
  if (typeof value.error === 'string' && value.error.trim()) return value.error.trim()
  if (
    isRecord(value.error) &&
    typeof value.error.message === 'string' &&
    value.error.message.trim()
  ) {
    return value.error.message.trim()
  }
  return fallback
}

function readVerifiedUid(value: unknown): string | null {
  if (
    !isRecord(value) ||
    value.success !== true ||
    value.verified !== true ||
    typeof value.uid !== 'string' ||
    !value.uid.trim()
  ) {
    return null
  }
  return value.uid.trim()
}

function isClaimAcknowledgement(
  value: unknown,
  expected: {
    source: string
    traderId: string
    userId: string
  }
): boolean {
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)) return false
  const claim = value.data.claim
  return (
    isRecord(claim) &&
    claim.user_id === expected.userId &&
    claim.trader_id === expected.traderId &&
    claim.source === expected.source.toLowerCase() &&
    claim.status === 'reviewing' &&
    claim.verification_method === 'api_key' &&
    value.data.auto_approved === false
  )
}

export function CexVerifyForm(props: CexVerifyFormProps) {
  const auth = useAuthSession()
  const viewer = captureSettingsViewer(auth)
  const scopeKey = `${auth.viewerKey}\u0000${auth.sessionGeneration}\u0000${props.trader.source}\u0000${props.trader.source_trader_id}`

  return <ViewerScopedCexVerifyForm key={scopeKey} {...props} viewer={viewer} />
}

function ViewerScopedCexVerifyForm({
  trader,
  onSuccess,
  viewer,
}: CexVerifyFormProps & {
  viewer: SettingsViewerSnapshot | null
}) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const router = useRouter()
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const viewerRef = useRef(viewer)
  viewerRef.current = viewer
  const mountedRef = useRef(false)
  const operationRef = useRef<ClaimOperation | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [apiSecret, setApiSecret] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [loading, setLoading] = useState(false)
  const [verifiedUid, setVerifiedUid] = useState<string | null>(null)

  const platform = CEX_PLATFORMS.find((p) => trader.source.startsWith(p.value.split('_')[0]))
  const needsPassphrase = platform?.requiresPassphrase ?? false
  const operationIsCurrent = (operation: ClaimOperation): boolean =>
    mountedRef.current &&
    operationRef.current === operation &&
    isSettingsViewerCurrent(operation.viewer, authRef.current)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      operationRef.current?.controller.abort()
      operationRef.current = null
    }
  }, [])

  const redirectToLogin = () => {
    showToast(t('loginExpiredPleaseRelogin'), 'error')
    router.push(
      buildTraderClaimLoginHref({
        traderId: trader.source_trader_id,
        source: trader.source,
        handle: trader.handle,
      })
    )
  }

  const handleVerify = async () => {
    if (loading) return // Guard against double-click race condition
    if (!verifiedUid && (!apiKey.trim() || !apiSecret.trim())) {
      showToast(t('fillApiKeySecret'), 'warning')
      return
    }

    const operationViewer = viewerRef.current
    if (!operationViewer || !isSettingsViewerCurrent(operationViewer, authRef.current)) {
      if (authRef.current.authChecked && !authRef.current.loading && !authRef.current.userId) {
        redirectToLogin()
      }
      return
    }

    const operation: ClaimOperation = {
      controller: new AbortController(),
      viewer: operationViewer,
    }
    operationRef.current = operation
    setLoading(true)
    try {
      // Step 1: Verify ownership (skip if already verified)
      let uid = verifiedUid
      if (!uid) {
        const verifyResult = await authedFetch<unknown>(
          '/api/exchange/verify-ownership',
          'POST',
          operation.viewer.accessToken,
          {
            exchange: trader.source,
            traderId: trader.source_trader_id,
            source: trader.source,
            apiKey: apiKey.trim(),
            apiSecret: apiSecret.trim(),
            passphrase: passphrase.trim() || undefined,
          },
          45_000,
          {
            expectedUserId: operation.viewer.userId,
            expectedSessionGeneration: operation.viewer.sessionGeneration,
            signal: operation.controller.signal,
          }
        )
        if (verifyResult.stale || !operationIsCurrent(operation)) return
        if (verifyResult.status === 401) {
          redirectToLogin()
          return
        }

        const acknowledgedUid = verifyResult.ok ? readVerifiedUid(verifyResult.data) : null
        if (!acknowledgedUid) {
          // The exchange's raw (English) error is passed through — prefix it with
          // a localized "Exchange returned:" so a zh/ja/ko user knows the message
          // is upstream, not a mistranslation. Fall back to our own mismatch copy.
          const message = responseMessage(verifyResult.data, '')
          showToast(
            message ? `${t('claimExchangeErrorPrefix')} ${message}` : t('claimApiKeyMismatch'),
            'error'
          )
          return
        }

        uid = acknowledgedUid
        setVerifiedUid(uid)
      }

      // Step 2: Submit the verified claim for owner review
      const claimResult = await authedFetch<unknown>(
        '/api/traders/claim',
        'POST',
        operation.viewer.accessToken,
        {
          trader_id: trader.source_trader_id,
          source: trader.source,
          verification_method: 'api_key',
          verification_data: {
            verified_uid: uid,
          },
        },
        30_000,
        {
          expectedUserId: operation.viewer.userId,
          expectedSessionGeneration: operation.viewer.sessionGeneration,
          signal: operation.controller.signal,
        }
      )
      if (claimResult.stale || !operationIsCurrent(operation)) return
      if (claimResult.status === 401) {
        redirectToLogin()
        return
      }
      if (
        !claimResult.ok ||
        !isClaimAcknowledgement(claimResult.data, {
          source: trader.source,
          traderId: trader.source_trader_id,
          userId: operation.viewer.userId,
        })
      ) {
        showToast(responseMessage(claimResult.data, t('claimFailed')), 'error')
        return
      }

      trackEvent('claim_trader', { method: 'cex_api_key' })
      showToast(t('claimSubmitted'), 'success')
      onSuccess()
    } catch (_error) {
      if (operationIsCurrent(operation)) showToast(t('claimFailed'), 'error')
    } finally {
      if (operationRef.current === operation) operationRef.current = null
      if (mountedRef.current && isSettingsViewerCurrent(operation.viewer, authRef.current)) {
        setLoading(false)
      }
    }
  }

  const authPending = !viewer && (!auth.authChecked || auth.loading || Boolean(auth.userId))

  return (
    <Box style={{ maxWidth: '500px', margin: '0 auto' }}>
      <h3 style={{ marginBottom: tokens.spacing[3] }}>{t('claimApiKeyVerifyTitle')}</h3>
      <p
        style={{
          color: tokens.colors.text.secondary,
          marginBottom: tokens.spacing[4],
          fontSize: tokens.typography.fontSize.sm,
        }}
      >
        {t('claimApiKeyVerifyDesc')}
      </p>

      <Box
        style={{
          padding: tokens.spacing[3],
          backgroundColor: colorAlpha(tokens.colors.accent.primary, 8),
          border: `1px solid ${alpha(tokens.colors.accent.primary, 25)}`,
          borderRadius: tokens.radius.md,
          marginBottom: tokens.spacing[4],
        }}
      >
        <Text
          style={{
            fontSize: tokens.typography.fontSize.xs,
            color: tokens.colors.text.secondary,
            lineHeight: 1.5,
            fontWeight: tokens.typography.fontWeight.semibold,
          }}
        >
          {t('claimReadOnlyWarning')}
        </Text>
      </Box>

      <Box style={{ marginBottom: tokens.spacing[3] }}>
        <label
          style={{
            display: 'block',
            marginBottom: tokens.spacing[1],
            fontWeight: tokens.typography.fontWeight.medium,
            fontSize: tokens.typography.fontSize.sm,
          }}
        >
          {t('apiKey')}
        </label>
        <input
          type="text"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={t('enterApiKeyPlaceholder')}
          style={{
            width: '100%',
            padding: tokens.spacing[3],
            borderRadius: tokens.radius.md,
            border: `1px solid ${tokens.colors.border.primary}`,
            backgroundColor: tokens.colors.bg.primary,
            color: tokens.colors.text.primary,
          }}
        />
      </Box>

      <Box style={{ marginBottom: tokens.spacing[3] }}>
        <label
          style={{
            display: 'block',
            marginBottom: tokens.spacing[1],
            fontWeight: tokens.typography.fontWeight.medium,
            fontSize: tokens.typography.fontSize.sm,
          }}
        >
          {t('apiSecret')}
        </label>
        <PasswordInput
          value={apiSecret}
          onChange={(e) => setApiSecret(e.target.value)}
          placeholder={t('enterApiSecretPlaceholder')}
          style={{
            width: '100%',
            padding: tokens.spacing[3],
            borderRadius: tokens.radius.md,
            border: `1px solid ${tokens.colors.border.primary}`,
            backgroundColor: tokens.colors.bg.primary,
            color: tokens.colors.text.primary,
          }}
        />
      </Box>

      {needsPassphrase && (
        <Box style={{ marginBottom: tokens.spacing[3] }}>
          <label
            style={{
              display: 'block',
              marginBottom: tokens.spacing[1],
              fontWeight: tokens.typography.fontWeight.medium,
              fontSize: tokens.typography.fontSize.sm,
            }}
          >
            {t('passphraseLabel')}
          </label>
          <PasswordInput
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder={t('enterPassphrasePlaceholder')}
            style={{
              width: '100%',
              padding: tokens.spacing[3],
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.colors.border.primary}`,
              backgroundColor: tokens.colors.bg.primary,
              color: tokens.colors.text.primary,
            }}
          />
        </Box>
      )}

      <Box
        style={{
          padding: tokens.spacing[3],
          backgroundColor: colorAlpha(tokens.colors.accent.warning, 8),
          border: `1px solid ${alpha(tokens.colors.accent.warning, 25)}`,
          borderRadius: tokens.radius.md,
          marginBottom: tokens.spacing[4],
        }}
      >
        <Text
          style={{
            fontSize: tokens.typography.fontSize.xs,
            color: tokens.colors.text.secondary,
            lineHeight: 1.5,
          }}
        >
          {t('claimFormSafeNote')}
        </Text>
      </Box>

      <button
        onClick={handleVerify}
        disabled={loading || authPending}
        style={{
          width: '100%',
          padding: tokens.spacing[3],
          fontSize: tokens.typography.fontSize.md,
          fontWeight: tokens.typography.fontWeight.semibold,
          borderRadius: tokens.radius.md,
          border: 'none',
          backgroundColor:
            loading || authPending ? tokens.colors.text.tertiary : tokens.colors.accent.primary,
          color: tokens.colors.white,
          cursor: loading || authPending ? 'not-allowed' : 'pointer',
          opacity: loading || authPending ? 0.6 : 1,
        }}
      >
        {loading ? t('verifying') : t('claimVerifyAndClaim')}
      </button>
    </Box>
  )
}
