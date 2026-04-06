'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { supabase } from '@/lib/supabase/client'
import { Box, Text } from '@/app/components/base'
import { getCsrfHeaders } from '@/lib/api/client'
import { useToast } from '@/app/components/ui/Toast'
import { SearchResult, isSolanaDex } from './types'
import { trackEvent } from '@/lib/analytics/track'

declare global {
  interface Window {
    phantom?: { solana?: SolanaProvider }
    solana?: SolanaProvider
  }
}

interface SolanaProvider {
  isPhantom?: boolean
  signMessage?: (message: Uint8Array, encoding?: string) => Promise<{ signature: Uint8Array }>
  connect: () => Promise<{ publicKey: { toString: () => string } }>
}

export function DexVerifyForm({
  trader,
  onSuccess,
}: {
  trader: SearchResult
  onSuccess: () => void
}) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const [loading, setLoading] = useState(false)

  const isSolana = isSolanaDex(trader.source)

  const handleWalletVerify = async () => {
    setLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        showToast(t('pleaseLoginFirst'), 'warning')
        return
      }

      let walletAddress: string
      let signature: string
      const timestamp = Date.now()
      const message = `I am claiming trader profile ${trader.source_trader_id} on Arena. Timestamp: ${timestamp}`

      if (isSolana) {
        // Solana wallet signing (Phantom, Solflare, etc.)
        const solanaProvider = window.phantom?.solana ?? window.solana
        if (!solanaProvider?.signMessage) {
          showToast(t('claimSolanaWalletRequired'), 'warning')
          return
        }

        const connectTimeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Wallet connection timed out. Please try again.')), 30000)
        )
        const resp = await Promise.race([solanaProvider.connect(), connectTimeout])
        walletAddress = resp.publicKey.toString()

        if (walletAddress.toLowerCase() !== trader.source_trader_id.toLowerCase()) {
          showToast(t('claimWalletMismatch'), 'error')
          return
        }

        const encodedMessage = new TextEncoder().encode(message)
        const signedMessage = await solanaProvider.signMessage(encodedMessage, 'utf8')
        // Convert Uint8Array signature to base64 for transmission
        signature = Buffer.from(signedMessage.signature).toString('base64')
      } else {
        // EVM wallet signing
        if (!window.ethereum) {
          showToast(t('claimWalletConnectFirst'), 'warning')
          return
        }

        const ethTimeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Wallet connection timed out. Please try again.')), 30000)
        )
        const accounts = await Promise.race([
          window.ethereum.request({ method: 'eth_requestAccounts' }),
          ethTimeout,
        ]) as string[]
        walletAddress = accounts[0]

        if (!walletAddress) {
          showToast(t('claimWalletConnectFirst'), 'warning')
          return
        }

        if (walletAddress.toLowerCase() !== trader.source_trader_id.toLowerCase()) {
          showToast(t('claimWalletMismatch'), 'error')
          return
        }

        signature = await window.ethereum.request({
          method: 'personal_sign',
          params: [message, walletAddress],
        }) as string
      }

      // Verify on server
      const verifyRes = await fetch('/api/traders/claim/verify-wallet', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({
          wallet_address: walletAddress,
          signature,
          message,
          platform: trader.source,
          trader_key: trader.source_trader_id,
        }),
      })

      const verifyData = await verifyRes.json()

      if (!verifyRes.ok || !verifyData.data?.verified) {
        showToast(verifyData.error || t('claimWalletSignFailed'), 'error')
        return
      }

      // Submit claim
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
          verification_method: 'signature',
          verification_data: {
            wallet_address: walletAddress,
            signature,
            message,
          },
        }),
      })

      const claimData = await claimRes.json()

      if (!claimRes.ok) {
        showToast(claimData.error || t('claimFailed'), 'error')
        return
      }

      trackEvent('claim_trader', { method: 'dex_wallet' })
      showToast(t('claimVerifiedAutoApproved'), 'success')
      onSuccess()
    } catch (error) {
      const msg = error instanceof Error ? error.message : ''
      if (msg.includes('User rejected') || msg.includes('user rejected') || msg.includes('timed out')) {
        // User cancelled wallet interaction or timeout
        setLoading(false)
        if (msg.includes('timed out')) {
          showToast(t('claimWalletTimeout') || 'Wallet connection timed out', 'warning')
        }
        return
      }
      showToast(t('claimWalletSignFailed'), 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Box style={{ maxWidth: '500px', margin: '0 auto', textAlign: 'center' }}>
      <h3 style={{ marginBottom: tokens.spacing[3] }}>{t('claimWalletVerifyTitle')}</h3>
      <p style={{ color: tokens.colors.text.secondary, marginBottom: tokens.spacing[4], fontSize: tokens.typography.fontSize.sm }}>
        {t('claimWalletVerifyDesc')}
      </p>

      <Box style={{
        padding: tokens.spacing[4],
        backgroundColor: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.lg,
        marginBottom: tokens.spacing[4],
      }}>
        <Text style={{ fontSize: tokens.typography.fontSize.sm, color: tokens.colors.text.tertiary }}>
          Wallet to verify:
        </Text>
        <Text style={{
          fontFamily: 'monospace',
          fontSize: tokens.typography.fontSize.sm,
          wordBreak: 'break-all',
          color: tokens.colors.text.primary,
          marginTop: tokens.spacing[1],
        }}>
          {trader.source_trader_id}
        </Text>
      </Box>

      <button
        onClick={handleWalletVerify}
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
        {loading ? t('claimWalletSigning') : t('claimWalletSignMessage')}
      </button>
    </Box>
  )
}
