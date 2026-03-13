'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { Button } from '../base'
import { getCsrfHeaders } from '@/lib/api/client'
import { useToast } from '../ui/Toast'
import { useDialog } from '../ui/Dialog'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { logger } from '@/lib/logger'

interface ClaimTraderButtonProps {
  traderId: string
  handle: string
  userId: string
  source?: string // 'binance', 'bybit', etc.
}

/**
 * DEX platforms whose traders are identified by wallet address.
 * These use wallet signature verification instead of API key.
 */
const DEX_WALLET_PLATFORMS = [
  'hyperliquid', 'gmx', 'gains', 'aevo', 'kwenta', 'vertex', 'dydx',
  'jupiter_perps', 'drift',
]

function isDexPlatform(source: string): boolean {
  return DEX_WALLET_PLATFORMS.some(p => source.toLowerCase().startsWith(p))
}

export default function ClaimTraderButton({ traderId, handle, userId, source = 'binance' }: ClaimTraderButtonProps) {
  const router = useRouter()
  const { showToast } = useToast()
  const { showConfirm } = useDialog()
  const { t } = useLanguage()
  const [loading, setLoading] = useState(false)
  const [claimed, setClaimed] = useState(false)
  const [claimStatus, setClaimStatus] = useState<string | null>(null)

  useEffect(() => {
    let alive = true

    async function checkClaimStatus(): Promise<void> {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (!alive || !session) return

        const res = await fetch('/api/traders/claim', {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })

        if (res.ok) {
          const data = await res.json()
          if (alive) {
            if (data.is_verified) {
              setClaimStatus('verified')
            } else if (data.claim?.status) {
              setClaimStatus(data.claim.status)
            }
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error) {
          logger.error('[ClaimTrader] Status check failed:', {
            message: err.message,
            userId,
            source,
          })
        }
      }
    }

    checkClaimStatus()
    return () => { alive = false }
  }, [userId, source])

  const handleClaim = async () => {
    // For DEX platforms, redirect to the claim page with wallet flow
    if (isDexPlatform(source)) {
      router.push(`/claim?trader=${encodeURIComponent(traderId)}&source=${encodeURIComponent(source)}&handle=${encodeURIComponent(handle)}`)
      return
    }

    const confirmed = await showConfirm(
      t('confirmClaim'),
      `${t('confirmClaimDesc').replace('{handle}', handle)}\n${t('verifyOwnership')}`
    )
    if (!confirmed) return

    // Check session
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) {
      showToast(t('pleaseLoginFirst'), 'warning')
      return
    }

    // For CEX platforms, redirect to claim page with API key flow
    router.push(`/claim?trader=${encodeURIComponent(traderId)}&source=${encodeURIComponent(source)}&handle=${encodeURIComponent(handle)}&step=verify`)
  }

  if (claimed || claimStatus === 'verified') {
    return (
      <Button variant="ghost" size="sm" disabled>
        {t('claimSubmitted')}
      </Button>
    )
  }

  if (claimStatus === 'pending' || claimStatus === 'reviewing') {
    return (
      <Button variant="ghost" size="sm" disabled>
        {t('claimSubmitted')}
      </Button>
    )
  }

  return (
    <Button
      variant="primary"
      size="sm"
      onClick={handleClaim}
      disabled={loading}
    >
      {loading ? t('claiming') : t('claimTrader')}
    </Button>
  )
}
