'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { supabase } from '@/lib/supabase/client'
import { Box, Text } from '@/app/components/base'
import { getCsrfHeaders } from '@/lib/api/client'
import { useToast } from '@/app/components/ui/Toast'
import { SearchResult, CEX_PLATFORMS } from './types'

export function CexVerifyForm({
  trader,
  onSuccess,
}: {
  trader: SearchResult
  onSuccess: () => void
}) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const [apiKey, setApiKey] = useState('')
  const [apiSecret, setApiSecret] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [loading, setLoading] = useState(false)

  const platform = CEX_PLATFORMS.find(p =>
    trader.source.startsWith(p.value.split('_')[0])
  )
  const needsPassphrase = platform?.requiresPassphrase ?? false

  const handleVerify = async () => {
    if (loading) return // Guard against double-click race condition
    if (!apiKey.trim() || !apiSecret.trim()) {
      showToast(t('fillApiKeySecret'), 'warning')
      return
    }

    setLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        showToast(t('pleaseLoginFirst'), 'warning')
        return
      }

      // Step 1: Verify ownership (matches UID with trader)
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

      const verifyData = await verifyRes.json()

      if (!verifyRes.ok || !verifyData.verified) {
        showToast(verifyData.message || t('claimApiKeyMismatch'), 'error')
        return
      }

      // Step 2: Submit claim (auto-approved after verification)
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
            verified_uid: verifyData.uid,
          },
        }),
      })

      const claimData = await claimRes.json()

      if (!claimRes.ok) {
        showToast(claimData.error || t('claimFailed'), 'error')
        return
      }

      showToast(t('claimVerifiedAutoApproved'), 'success')
      onSuccess()
    } catch (error) {
      showToast(t('claimFailed'), 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Box style={{ maxWidth: '500px', margin: '0 auto' }}>
      <h3 style={{ marginBottom: tokens.spacing[3] }}>{t('claimApiKeyVerifyTitle')}</h3>
      <p style={{ color: tokens.colors.text.secondary, marginBottom: tokens.spacing[4], fontSize: tokens.typography.fontSize.sm }}>
        {t('claimApiKeyVerifyDesc')}
      </p>

      <Box style={{
        padding: tokens.spacing[3],
        backgroundColor: tokens.colors.accent.primary + '15',
        border: `1px solid ${tokens.colors.accent.primary}40`,
        borderRadius: tokens.radius.md,
        marginBottom: tokens.spacing[4],
      }}>
        <Text style={{ fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.secondary, lineHeight: 1.5, fontWeight: 600 }}>
          {t('claimReadOnlyWarning')}
        </Text>
      </Box>

      <Box style={{ marginBottom: tokens.spacing[3] }}>
        <label style={{ display: 'block', marginBottom: tokens.spacing[1], fontWeight: 500, fontSize: tokens.typography.fontSize.sm }}>
          API Key
        </label>
        <input
          type="text"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="Enter your API Key"
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
        <label style={{ display: 'block', marginBottom: tokens.spacing[1], fontWeight: 500, fontSize: tokens.typography.fontSize.sm }}>
          API Secret
        </label>
        <input
          type="password"
          value={apiSecret}
          onChange={(e) => setApiSecret(e.target.value)}
          placeholder="Enter your API Secret"
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
          <label style={{ display: 'block', marginBottom: tokens.spacing[1], fontWeight: 500, fontSize: tokens.typography.fontSize.sm }}>
            Passphrase
          </label>
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="Enter your Passphrase"
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

      <Box style={{
        padding: tokens.spacing[3],
        backgroundColor: tokens.colors.accent.warning + '15',
        border: `1px solid ${tokens.colors.accent.warning}40`,
        borderRadius: tokens.radius.md,
        marginBottom: tokens.spacing[4],
      }}>
        <Text style={{ fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.secondary, lineHeight: 1.5 }}>
          {t('claimPageFaqSafeAnswer')}
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
        {loading ? t('verifying') : t('claimVerifyMethodApi')}
      </button>
    </Box>
  )
}
