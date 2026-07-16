'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { Button } from '../base'
import { useToast } from '../ui/Toast'
import { useDialog } from '../ui/Dialog'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { logger } from '@/lib/logger'
import { isDexWalletPlatform } from '@/lib/constants/wallet-platforms'
import { walletIdentitiesMatch } from '@/lib/validators/wallet-identity'

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
  'hyperliquid',
  'gmx',
  'gains',
  'aevo',
  'kwenta',
  'vertex',
  'dydx',
  'jupiter_perps',
  'drift',
]

function isDexPlatform(source: string): boolean {
  return DEX_WALLET_PLATFORMS.some((p) => source.toLowerCase().startsWith(p))
}

export default function ClaimTraderButton({
  traderId,
  handle,
  userId,
  source = 'binance',
}: ClaimTraderButtonProps) {
  const router = useRouter()
  const { showToast } = useToast()
  const { showConfirm } = useDialog()
  const { t } = useLanguage()
  const [loading, _setLoading] = useState(false)
  const [claimed, _setClaimed] = useState(false)
  const [claimStatus, setClaimStatus] = useState<string | null>(null)
  const [hasVerifiedAccounts, setHasVerifiedAccounts] = useState(false)
  const [thisTraderLinked, setThisTraderLinked] = useState(false)

  useEffect(() => {
    let alive = true

    async function checkClaimStatus(): Promise<void> {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession()
        if (!alive || !session) return

        const normalizedSource = source.toLowerCase()
        const matchesCurrentTrader = (candidate: { trader_id: string; source: string }): boolean =>
          candidate.source === normalizedSource &&
          (isDexWalletPlatform(normalizedSource)
            ? walletIdentitiesMatch(candidate.trader_id, traderId, normalizedSource)
            : candidate.trader_id === traderId)
        const query = new URLSearchParams({
          trader_id: traderId,
          source: normalizedSource,
        })
        const res = await fetch(`/api/traders/claim?${query.toString()}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })

        if (res.ok) {
          const payload = await res.json()
          const data = payload?.data
          if (!data || typeof data !== 'object') {
            throw new Error('Invalid claim status response')
          }
          if (alive) {
            const linked = Array.isArray(data.linked_traders) ? data.linked_traders : []
            const linkedCount = linked.length
            setHasVerifiedAccounts(linkedCount > 0 || data.is_verified === true)

            // Check if this specific trader is already linked
            const isLinked = linked.some(matchesCurrentTrader)
            setThisTraderLinked(isLinked)

            if (isLinked) {
              setClaimStatus('verified')
            } else if (
              data.claim &&
              matchesCurrentTrader(data.claim) &&
              typeof data.claim?.status === 'string'
            ) {
              setClaimStatus(data.claim.status)
            } else {
              setClaimStatus(null)
            }
          }
        } else {
          throw new Error(`Claim status request failed (${res.status})`)
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
    // Re-check when user returns to this tab (instead of polling every 30s)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && alive) {
        checkClaimStatus()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [userId, source, traderId])

  const handleClaim = async () => {
    // For DEX platforms, redirect to the claim page with wallet flow
    if (isDexPlatform(source)) {
      router.push(
        `/claim?trader=${encodeURIComponent(traderId)}&source=${encodeURIComponent(source)}&handle=${encodeURIComponent(handle)}`
      )
      return
    }

    const confirmTitle = hasVerifiedAccounts ? t('confirmLink') : t('confirmClaim')
    const confirmDesc = hasVerifiedAccounts
      ? t('confirmLinkDesc').replace('{handle}', handle)
      : `${t('confirmClaimDesc').replace('{handle}', handle)}\n${t('verifyOwnership')}`

    const confirmed = await showConfirm(confirmTitle, confirmDesc)
    if (!confirmed) return

    // Check session
    const {
      data: { session },
    } = await supabase.auth.getSession()
    if (!session) {
      showToast(t('pleaseLoginFirst'), 'warning')
      return
    }

    // For CEX platforms, redirect to claim page with API key flow
    router.push(
      `/claim?trader=${encodeURIComponent(traderId)}&source=${encodeURIComponent(source)}&handle=${encodeURIComponent(handle)}&step=verify`
    )
  }

  if (thisTraderLinked || claimed || claimStatus === 'verified') {
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

  // If user already has verified accounts, show "Link to Profile" instead of "Claim"
  const buttonLabel = hasVerifiedAccounts ? t('linkToProfile') : t('claimTrader')

  return (
    <Button variant="primary" size="sm" onClick={handleClaim} disabled={loading}>
      {loading ? t('claiming') : buttonLabel}
    </Button>
  )
}
