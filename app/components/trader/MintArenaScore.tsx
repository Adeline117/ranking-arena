'use client'

/**
 * Mint Arena Score Button
 * Allows verified traders to create an on-chain attestation of their Arena Score.
 * The server-side Arena attester key signs the EAS attestation on Base.
 */

import { useState, useEffect } from 'react'
import { Button } from '../base'
import { useToast } from '../ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import { getCsrfHeaders } from '@/lib/api/client'
import { fireAndForget } from '@/lib/utils/logger'

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
    const isOnChain = attestation.tx_hash && attestation.tx_hash !== 'pending'
    return (
      <a
        href={isOnChain
          ? `https://base.easscan.org/attestation/view/${attestation.attestation_uid}`
          : undefined
        }
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
          borderRadius: tokens.radius.lg,
          background: isOnChain ? 'rgba(34, 211, 238, 0.1)' : 'rgba(251, 191, 36, 0.1)',
          border: `1px solid ${isOnChain ? 'rgba(34, 211, 238, 0.3)' : 'rgba(251, 191, 36, 0.3)'}`,
          color: isOnChain ? '#22d3ee' : '#fbbf24',
          fontSize: tokens.typography.fontSize.sm,
          fontWeight: 600,
          textDecoration: 'none',
          cursor: isOnChain ? 'pointer' : 'default',
        }}
      >
        <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
          <path d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"/>
        </svg>
        {isOnChain ? t('attestationExists') : t('attestationPending')}
      </a>
    )
  }

  const handleMint = async () => {
    setLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        showToast(t('pleaseLoginFirst'), 'warning')
        return
      }

      const response = await fetch('/api/attestation/mint', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
          ...getCsrfHeaders(),
        },
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
