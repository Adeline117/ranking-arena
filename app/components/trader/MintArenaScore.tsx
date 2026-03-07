'use client'

/**
 * Mint Arena Score Button
 * Allows verified traders to create an on-chain attestation of their Arena Score.
 * Uses EAS (Ethereum Attestation Service) on Base chain via Privy wallet.
 */

import { useState, useEffect } from 'react'
import { usePrivy, useWallets } from '@privy-io/react-auth'
import { Button } from '../base'
import { useToast } from '../ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import { getCsrfHeaders } from '@/lib/api/client'
import { fireAndForget } from '@/lib/utils/logger'
import { ARENA_SCORE_SCHEMA_UID } from '@/lib/eas/config'

interface MintArenaScoreProps {
  traderHandle: string
  arenaScore: number | null
  isVerified: boolean
  traderSource?: string
}

export default function MintArenaScore({ traderHandle, arenaScore, isVerified, traderSource }: MintArenaScoreProps) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const { authenticated, login } = usePrivy()
  const { wallets } = useWallets()
  const [loading, setLoading] = useState(false)
  const [attestation, setAttestation] = useState<{ attestation_uid: string; tx_hash: string } | null>(null)

  useEffect(() => {
    fireAndForget(
      fetch(`/api/attestation/mint?handle=${encodeURIComponent(traderHandle)}`)
        .then(res => res.json())
        .then(data => {
          if (data.attestation) setAttestation(data.attestation)
        }),
      'MintArenaScore:checkAttestation'
    )
  }, [traderHandle])

  if (!isVerified || arenaScore == null) return null

  if (attestation) {
    return (
      <a
        href={`https://base.easscan.org/attestation/view/${attestation.attestation_uid}`}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
          borderRadius: tokens.radius.lg,
          background: 'rgba(34, 211, 238, 0.1)',
          border: '1px solid rgba(34, 211, 238, 0.3)',
          color: '#22d3ee',
          fontSize: tokens.typography.fontSize.sm,
          fontWeight: 600,
          textDecoration: 'none',
        }}
      >
        <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
          <path d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"/>
        </svg>
        {t('attestationExists')}
      </a>
    )
  }

  const handleMint = async () => {
    setLoading(true)
    try {
      // Step 1: Check auth
      if (!authenticated) {
        login()
        setLoading(false)
        return
      }

      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        showToast(t('pleaseLoginFirst'), 'warning')
        return
      }

      // Step 2: Get wallet
      const wallet = wallets[0]
      if (!wallet) {
        showToast(t('connectWalletFirst'), 'warning')
        return
      }

      // Step 3: Check if EAS schema is configured
      if (!ARENA_SCORE_SCHEMA_UID) {
        // Fallback: record intent without on-chain minting
        const response = await fetch('/api/attestation/mint', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
            ...getCsrfHeaders(),
          },
          body: JSON.stringify({
            attestation_uid: `pending_${wallet.address}_${Date.now()}`,
            tx_hash: 'pending',
            arena_score: arenaScore,
            chain_id: 8453,
            score_period: 'overall',
          }),
        })

        if (!response.ok) {
          const data = await response.json()
          throw new Error(data.error || t('mintFailed'))
        }

        const result = await response.json()
        setAttestation(result.attestation)
        showToast(t('mintSuccess'), 'success')
        return
      }

      // Step 4: Switch to Base chain if needed
      await wallet.switchChain(8453)
      const provider = await wallet.getEthereumProvider()

      // Step 5: Mint on-chain via EAS
      const { mintArenaScoreAttestation } = await import('@/lib/eas/mint')
      const mintResult = await mintArenaScoreAttestation({
        walletProvider: provider,
        traderAddress: wallet.address,
        arenaScore,
        source: traderSource || 'unknown',
        period: 'overall',
      })

      // Step 6: Record in our database
      const response = await fetch('/api/attestation/mint', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({
          attestation_uid: mintResult.attestationUid,
          tx_hash: mintResult.txHash,
          arena_score: arenaScore,
          chain_id: 8453,
          score_period: 'overall',
        }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || t('mintFailed'))
      }

      const apiResult = await response.json()
      setAttestation(apiResult.attestation)
      showToast(t('mintSuccess'), 'success')
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('mintFailed'), 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={handleMint}
      disabled={loading}
    >
      {loading ? '...' : t('mintArenaScore')}
    </Button>
  )
}
