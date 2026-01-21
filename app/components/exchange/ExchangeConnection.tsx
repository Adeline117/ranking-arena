'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase/client'
import { Box, Text, Button } from '@/app/components/base'
import { tokens } from '@/lib/design-tokens'
import type { ExchangeConnection } from '@/lib/exchange'
import ExchangeLogo from '../ui/ExchangeLogo'
import { useLanguage } from '../utils/LanguageProvider'
import { useToast } from '../ui/Toast'
import { useDialog } from '../ui/Dialog'
import { getCsrfHeaders } from '@/lib/api/client'

interface ExchangeConnectionProps {
  userId: string
}

const EXCHANGES = [
  { id: 'binance', name: 'Binance' },
  { id: 'bybit', name: 'Bybit' },
  { id: 'bitget', name: 'Bitget' },
  { id: 'mexc', name: 'MEXC' },
  { id: 'coinex', name: 'CoinEx' },
] as const

export default function ExchangeConnectionManager({ userId }: ExchangeConnectionProps) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const { showConfirm } = useDialog()
  const [connections, setConnections] = useState<ExchangeConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState<string | null>(null)

  useEffect(() => {
    loadConnections()
  }, [userId])

  const loadConnections = async () => {
    try {
      setLoading(true)
      
      // 检查用户是否已登录
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        console.warn('[ExchangeConnection] 用户未登录')
        setConnections([])
        return
      }

      // 确保使用正确的用户ID
      const actualUserId = user.id
      if (userId !== actualUserId) {
        console.warn('[ExchangeConnection] 用户ID不匹配:', { provided: userId, actual: actualUserId })
      }

      const { data, error: fetchError } = await supabase
        .from('user_exchange_connections')
        .select('*')
        .eq('user_id', actualUserId)
        .order('created_at', { ascending: false })

      if (fetchError) {
        console.error('[ExchangeConnection] 加载连接失败:', {
          error: fetchError,
          message: fetchError.message,
          details: fetchError.details,
          hint: fetchError.hint,
          code: fetchError.code,
          userId: actualUserId,
        })
        // 即使出错也设置空数组，避免显示错误状态
        setConnections([])
        return
      }

      setConnections(data || [])
    } catch (err) {
      // 静默处理错误，设置空数组
      setConnections([])
    } finally {
      setLoading(false)
    }
  }

  const handleStartAuth = (exchange: string) => {
    // 跳转到授权引导页面
    window.location.href = `/exchange/auth?exchange=${exchange}`
  }


  const handleSync = async (exchange: string) => {
    setSyncing(exchange)

    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        showToast('请先登录', 'warning')
        return
      }

      const response = await fetch('/api/exchange/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({ exchange }),
      })

      const result = await response.json()

      if (!response.ok) {
        showToast(result.error || t('syncError'), 'error')
        return
      }

      showToast(t('syncSuccess'), 'success')
      await loadConnections()
    } catch (err: any) {
      showToast(err.message || t('syncError'), 'error')
    } finally {
      setSyncing(null)
    }
  }

  const handleDisconnect = async (exchange: string) => {
    const confirmed = await showConfirm('断开连接', t('confirmDisconnect').replace('{exchange}', exchange))
    if (!confirmed) {
      return
    }

    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        showToast(t('pleaseLogin'), 'warning')
        return
      }

      const response = await fetch('/api/exchange/disconnect', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({ exchange }),
      })

      const result = await response.json()

      if (!response.ok) {
        showToast(result.error || t('disconnectFailed'), 'error')
        return
      }

      showToast(t('disconnected'), 'success')
      await loadConnections()
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : t('disconnectFailed')
      showToast(errorMessage, 'error')
    }
  }

  if (loading) {
    return (
      <Box style={{ padding: tokens.spacing[4] }}>
        <Text color="tertiary">{t('loading')}</Text>
      </Box>
    )
  }

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
      <Text size="lg" weight="black">
        {t('bindExchangeAccount')}
      </Text>
      <Text size="sm" color="tertiary">
        {t('bindExchangeAccountFull')}
      </Text>

      {EXCHANGES.map((exchange) => {
        const connection = connections.find(c => c.exchange === exchange.id && c.is_active)
        const isSyncing = syncing === exchange.id

        return (
          <Box
            key={exchange.id}
            bg="secondary"
            p={6}
            radius="xl"
            border="primary"
          >
            <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: tokens.spacing[4] }}>
              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
                <ExchangeLogo exchange={exchange.id as 'binance' | 'bybit' | 'bitget' | 'mexc' | 'coinex'} size={32} />
                <Text size="lg" weight="bold">{exchange.name}</Text>
                {connection && (
                  <Box
                    style={{
                      padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                      borderRadius: tokens.radius.sm,
                      background: tokens.colors.bg.tertiary,
                      fontSize: tokens.typography.fontSize.xs,
                      color: tokens.colors.text.secondary,
                    }}
                  >
                    {connection.last_sync_status === 'success' ? `✅ ${t('connected')}` : 
                     connection.last_sync_status === 'error' ? `❌ ${t('syncFailed')}` : 
                     connection.last_sync_status === 'pending' ? `⏳ ${t('syncing')}` : t('connected')}
                  </Box>
                )}
              </Box>

              {connection ? (
                <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleSync(exchange.id)}
                    disabled={isSyncing}
                  >
                    {isSyncing ? t('syncing') : t('refreshData')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleDisconnect(exchange.id)}
                  >
                    {t('disconnect')}
                  </Button>
                </Box>
              ) : (
                <Button
                  variant="primary"
                  size="md"
                  onClick={() => handleStartAuth(exchange.id)}
                  style={{
                    minWidth: 120,
                    display: 'flex',
                    alignItems: 'center',
                    gap: tokens.spacing[2],
                  }}
                >
                  <ExchangeLogo exchange={exchange.id as any} size={20} />
                  {t('bindExchange')} {exchange.name}
                </Button>
              )}
            </Box>

            {connection && connection.last_sync_at && (
              <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
                {t('lastSync')}{new Date(connection.last_sync_at).toLocaleString()}
              </Text>
            )}

            {connection && connection.last_sync_error && (
              <Box
                style={{
                  padding: tokens.spacing[2],
                  borderRadius: tokens.radius.md,
                  background: 'rgba(255, 0, 0, 0.1)',
                  border: '1px solid rgba(255, 0, 0, 0.3)',
                  marginBottom: tokens.spacing[2],
                }}
              >
                <Text size="xs" style={{ color: tokens.colors.accent.error }}>
                  {t('syncErrorMsg')}{connection.last_sync_error}
                </Text>
              </Box>
            )}

            {!connection && (
              <Box
                style={{
                  padding: tokens.spacing[3],
                  borderRadius: tokens.radius.md,
                  background: tokens.colors.bg.primary,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  marginTop: tokens.spacing[3],
                }}
              >
                <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[3] }}>
                  {t('clickToBind').replace('{exchange}', exchange.name)}
                </Text>
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

