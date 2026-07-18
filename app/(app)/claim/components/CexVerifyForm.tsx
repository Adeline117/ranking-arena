'use client'
import PasswordInput from '@/app/components/ui/PasswordInput'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { tokens, alpha, alpha as colorAlpha } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { supabase } from '@/lib/supabase/client'
import { Box, Text } from '@/app/components/base'
import { trackEvent } from '@/lib/analytics/track'
import { getCsrfHeaders } from '@/lib/api/client'
import { useToast } from '@/app/components/ui/Toast'
import { SearchResult, CEX_PLATFORMS } from './types'
import { buildTraderClaimLoginHref } from '@/lib/auth/trader-claim-login'

export function CexVerifyForm({
  trader,
  onSuccess,
}: {
  trader: SearchResult
  onSuccess: () => void
}) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const router = useRouter()
  const [apiKey, setApiKey] = useState('')
  const [apiSecret, setApiSecret] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [loading, setLoading] = useState(false)
  const [verifiedUid, setVerifiedUid] = useState<string | null>(null)

  const platform = CEX_PLATFORMS.find((p) => trader.source.startsWith(p.value.split('_')[0]))
  const needsPassphrase = platform?.requiresPassphrase ?? false
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

    setLoading(true)
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      if (!session) {
        redirectToLogin()
        return
      }

      // Step 1: Verify ownership (skip if already verified)
      let uid = verifiedUid
      if (!uid) {
        const verifyRes = await fetch('/api/exchange/verify-ownership', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
            ...getCsrfHeaders(),
          },
          body: JSON.stringify({
            exchange: trader.source,
            traderId: trader.source_trader_id,
            source: trader.source,
            apiKey: apiKey.trim(),
            apiSecret: apiSecret.trim(),
            passphrase: passphrase.trim() || undefined,
          }),
        })

        const verifyData: { verified?: boolean; message?: string; uid?: string } = await verifyRes
          .json()
          .catch(() => ({}))

        if (verifyRes.status === 401) {
          redirectToLogin()
          return
        }

        if (!verifyRes.ok || !verifyData.verified || !verifyData.uid) {
          // The exchange's raw (English) error is passed through — prefix it with
          // a localized "Exchange returned:" so a zh/ja/ko user knows the message
          // is upstream, not a mistranslation. Fall back to our own mismatch copy.
          showToast(
            verifyData.message
              ? `${t('claimExchangeErrorPrefix')} ${verifyData.message}`
              : t('claimApiKeyMismatch'),
            'error'
          )
          return
        }

        uid = verifyData.uid
        setVerifiedUid(uid)
      }

      // Step 2: Submit the verified claim for owner review
      const claimRes = await fetch('/api/traders/claim', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({
          trader_id: trader.source_trader_id,
          source: trader.source,
          verification_method: 'api_key',
          verification_data: {
            verified_uid: uid,
          },
        }),
      })

      const claimData: { error?: string } = await claimRes.json().catch(() => ({}))

      if (!claimRes.ok) {
        if (claimRes.status === 401) {
          redirectToLogin()
          return
        }
        showToast(claimData.error || t('claimFailed'), 'error')
        return
      }

      trackEvent('claim_trader', { method: 'cex_api_key' })
      showToast(t('claimSubmitted'), 'success')
      onSuccess()
    } catch (_error) {
      showToast(t('claimFailed'), 'error')
    } finally {
      setLoading(false)
    }
  }

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
            fontWeight: 600,
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
            fontWeight: 500,
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
            fontWeight: 500,
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
              fontWeight: 500,
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
        disabled={loading}
        style={{
          width: '100%',
          padding: tokens.spacing[3],
          fontSize: tokens.typography.fontSize.md,
          fontWeight: 600,
          borderRadius: tokens.radius.md,
          border: 'none',
          backgroundColor: loading ? tokens.colors.text.tertiary : tokens.colors.accent.primary,
          color: '#fff',
          cursor: loading ? 'not-allowed' : 'pointer',
          opacity: loading ? 0.6 : 1,
        }}
      >
        {loading ? t('verifying') : t('claimVerifyAndClaim')}
      </button>
    </Box>
  )
}
