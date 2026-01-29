'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { Button } from '../base'
import { getCsrfHeaders } from '@/lib/api/client'
import { useToast } from '../ui/Toast'
import { useDialog } from '../ui/Dialog'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

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
  const [_checking, setChecking] = useState(true)

  // 检查用户是否已绑定交易所账号
  useEffect(() => {
    checkConnection()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, source])

  const checkConnection = async () => {
    try {
      // 检查用户是否已登录
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        console.warn('[ClaimTrader] 用户未登录')
        setHasConnection(false)
        setChecking(false)
        return
      }

      // 确保使用正确的用户ID
      const actualUserId = user.id
      if (userId !== actualUserId) {
        console.warn('[ClaimTrader] 用户ID不匹配:', { provided: userId, actual: actualUserId })
      }

      // 使用 maybeSingle() 查询连接状态
      // 注意：maybeSingle() 在没有找到记录时会返回 { data: null, error: {} }
      // 这是正常行为，不需要记录错误
      const { data } = await supabase
        .from('user_exchange_connections')
        .select('id, exchange, is_active')
        .eq('user_id', actualUserId)
        .eq('exchange', source)
        .eq('is_active', true)
        .maybeSingle()

      // 设置连接状态：有数据则已连接，无数据则未连接
      setHasConnection(!!data)
    } catch (err: any) {
      // 检查是否有实际的错误内容
      const hasErrorContent = !!(err?.message || err?.code || err?.stack)
      if (hasErrorContent) {
        console.error('[ClaimTrader] 检查连接异常:', {
          error: err,
          message: err?.message,
          stack: err?.stack,
          userId,
          source,
        })
      }
      setHasConnection(false)
    } finally {
      setChecking(false)
    }
  }

  const handleClaim = async () => {
    // 1. 检查是否已绑定交易所账号
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

    // 2. 确认认领
    const confirmed = await showConfirm(
      t('confirmClaim'),
      `${t('confirmClaimDesc').replace('{handle}', handle)}\n${t('verifyOwnership')}`
    )
    if (!confirmed) {
      return
    }

    // 3. 获取用户token（在 setLoading 之前检查，避免 loading 状态泄漏）
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) {
      showToast(t('pleaseLoginFirst'), 'warning')
      return
    }

    setLoading(true)
    try {
      // 4. 验证账号所有权
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

      // 5. 验证通过，创建认领记录（自动批准）
      const { error } = await supabase
        .from('trader_claims')
        .insert({
          trader_id: traderId,
          user_id: userId,
          handle: handle,
          source: source,
          status: 'approved', // 验证通过后自动批准
          verified_at: new Date().toISOString(),
        })

      if (error) {
        if (error.code === '23505') {
          // 已存在认领申请
          showToast(t('claimAlreadySubmitted'), 'warning')
        } else {
          throw error
        }
      } else {
        setClaimed(true)
        showToast(t('claimSuccess'), 'success')
        // 刷新页面
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





