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

export default function ClaimTraderButton({ traderId, handle, userId, source = 'binance' }: ClaimTraderButtonProps) {
  const router = useRouter()
  const { showToast } = useToast()
  const { showConfirm } = useDialog()
  const { t } = useLanguage()
  const [loading, setLoading] = useState(false)
  const [claimed, setClaimed] = useState(false)
  const [hasConnection, setHasConnection] = useState(false)

  useEffect(() => {
    let alive = true

    async function checkConnection(): Promise<void> {
      try {
         
        const { data: { user } } = await supabase.auth.getUser()
        if (!alive) return
        if (!user) {
          setHasConnection(false)
          return
        }

        const actualUserId = user.id
        if (userId !== actualUserId) {
          // intentionally empty
        }

        const { data } = await supabase
          .from('user_exchange_connections')
          .select('id, exchange, is_active')
          .eq('user_id', actualUserId)
          .eq('exchange', source)
          .eq('is_active', true)
          .maybeSingle()

        if (alive) setHasConnection(!!data)
      } catch (err: unknown) {
        if (err instanceof Error) {
          logger.error('[ClaimTrader] Connection check failed:', {
            message: err.message,
            userId,
            source,
          })
        }
        if (alive) setHasConnection(false)
      }
    }

    checkConnection()
    return () => { alive = false }
  }, [userId, source])

  const handleClaim = async () => {
    if (!hasConnection) {
      const goToSettings = await showConfirm(
        t('needBindExchange'),
        `${t('needBindExchangeDesc')}\n${t('bindExchangeFirst').replace('{exchange}', source.toUpperCase())}\n${t('goToSettingsQuestion')}`
      )
      if (goToSettings) {
        router.push('/settings')
      }
      return
    }

    const confirmed = await showConfirm(
      t('confirmClaim'),
      `${t('confirmClaimDesc').replace('{handle}', handle)}\n${t('verifyOwnership')}`
    )
    if (!confirmed) {
      return
    }

    // Check session before entering loading state to avoid leaked loading on missing auth
     
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) {
      showToast(t('pleaseLoginFirst'), 'warning')
      return
    }

    setLoading(true)
    try {
      const verifyResponse = await fetch('/api/exchange/verify-ownership', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({
          exchange: source,
          traderId,
          source,
        }),
      })

      const verifyResult = await verifyResponse.json()

      if (!verifyResponse.ok) {
        if (verifyResult.needConnect) {
          const goToSettings = await showConfirm(
            t('needBindExchange'),
            verifyResult.message + '\n' + t('goToSettingsQuestion')
          )
          if (goToSettings) {
            router.push('/settings')
          }
        } else {
          showToast(verifyResult.message || t('verifyFailed'), 'error')
        }
        return
      }

      if (!verifyResult.verified) {
        showToast(t('verifyFailedInvalid'), 'error')
        return
      }

      // Verification passed -- create auto-approved claim record
      const { error } = await supabase
        .from('trader_claims')
        .insert({
          trader_id: traderId,
          user_id: userId,
          handle,
          source,
          status: 'approved',
          verified_at: new Date().toISOString(),
        })

      if (error) {
        if (error.code === '23505') {
          showToast(t('claimAlreadySubmitted'), 'warning')
        } else {
          throw error
        }
      } else {
        setClaimed(true)
        showToast(t('claimSuccess'), 'success')
        window.location.reload()
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : t('unknownError')
      showToast(t('claimFailed') + ': ' + errorMessage, 'error')
    } finally {
      setLoading(false)
    }
  }

  if (claimed) {
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
