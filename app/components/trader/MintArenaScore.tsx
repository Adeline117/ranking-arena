'use client'

/**
 * Mint Arena Score Button
 * Allows verified traders to create an on-chain attestation of their Arena Score.
 * The actual minting happens client-side; this component handles the UI flow.
 */

import { useState, useEffect } from 'react'
import { Button } from '../base'
import { useToast } from '../ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import { getCsrfHeaders } from '@/lib/api/client'

interface MintArenaScoreProps {
  traderHandle: string
  arenaScore: number | null
  isVerified: boolean
}

export default function MintArenaScore({ traderHandle, arenaScore, isVerified }: MintArenaScoreProps) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const [loading, setLoading] = useState(false)
  const [attestation, setAttestation] = useState<{ attestation_uid: string; tx_hash: string } | null>(null)

  useEffect(() => {
    // Check if attestation exists
    fetch(`/api/attestation/mint?handle=${encodeURIComponent(traderHandle)}`)
      .then(res => res.json())
      .then(data => {
        if (data.attestation) setAttestation(data.attestation)
      })
      .catch(() => {})
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
      // In a full implementation, this would call ethers/viem to mint an EAS attestation
      // For now, we create a placeholder that can be replaced with actual on-chain minting
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        showToast(t('pleaseLoginFirst'), 'warning')
        return
      }

      // TODO: Replace with actual EAS minting via wallet
      // For now, record intent
      const response = await fetch('/api/attestation/mint', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({
          attestation_uid: `pending_${Date.now()}`,
          tx_hash: `pending_${Date.now()}`,
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
