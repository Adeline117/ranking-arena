'use client'

import { useState, useEffect } from 'react'
import { supabase as _supabase } from '@/lib/supabase/client'
import type { SupabaseClient } from '@supabase/supabase-js'
const supabase = _supabase as SupabaseClient
import { Box, Text, Button } from '@/app/components/base'
import { tokens } from '@/lib/design-tokens'
import type { ExchangeConnection } from '@/lib/exchange'
import ExchangeLogo from '../ui/ExchangeLogo'
import { useLanguage } from '../Providers/LanguageProvider'
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
  { id: 'htx', name: 'HTX' },
  { id: 'weex', name: 'Weex' },
  { id: 'coinex', name: 'CoinEx' },
] as const

export default function ExchangeConnectionManager({ userId }: ExchangeConnectionProps) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const { showConfirm } = useDialog()
  const [connections, setConnections] = useState<ExchangeConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState<string | null>(null)

  useEffect(() => {
    loadConnections()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadConnections is defined in closure, not a stable ref
  }, [userId])

  const loadConnections = async () => {
    try {
      setLoading(true)
      setError(null)

      // 检查用户是否已登录
       
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        setError(t('pleaseLogin'))
        setConnections([])
        return
      }

      // 确保使用正确的用户ID
      const actualUserId = user.id
      if (userId !== actualUserId) {
        // intentionally empty
      }

      const { data, error: fetchError } = await supabase
        .from('user_exchange_connections')
        .select('id, exchange, status, is_active, label, created_at, last_synced_at, updated_at, user_id')
        .eq('user_id', actualUserId)
        .order('created_at', { ascending: false })

      if (fetchError) {
        const errorMsg = fetchError.code === 'PGRST301'
          ? t('serviceTemporarilyUnavailable')
          : t('loadConnectionsFailed')
        setError(errorMsg)
        setConnections([])
        showToast(errorMsg, 'error')
        return
      }

      setConnections(data || [])
      setError(null)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : t('loadConnectionsFailed')
      setError(errorMsg)
      setConnections([])
      showToast(errorMsg, 'error')
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
        showToast(t('pleaseLogin'), 'warning')
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
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : t('syncError'), 'error')
    } finally {
      setSyncing(null)
    }
  }

  const handleDisconnect = async (exchange: string) => {
    const confirmed = await showConfirm(t('disconnect'), t('confirmDisconnect').replace('{exchange}', exchange))
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

  if (error) {
    return (
      <Box style={{ padding: tokens.spacing[4], display: 'flex', flexDirection: 'column', gap: tokens.spacing[3], alignItems: 'center' }}>
        <Text style={{ textAlign: 'center', color: tokens.colors.accent.error }}>{error}</Text>
        <Button
          onClick={loadConnections}
          size="sm"
          style={{ marginTop: tokens.spacing[2] }}
        >
          {t('retry')}
        </Button>
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
                      background: connection.last_sync_status === 'success' ? `${tokens.colors.accent.success}15` :
                                  connection.last_sync_status === 'error' ? `${tokens.colors.accent.error}15` :
                                  tokens.colors.bg.tertiary,
                      fontSize: tokens.typography.fontSize.xs,
                      color: connection.last_sync_status === 'success' ? tokens.colors.accent.success :
                             connection.last_sync_status === 'error' ? tokens.colors.accent.error :
                             tokens.colors.text.secondary,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    {connection.last_sync_status === 'success' && (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
                    )}
                    {connection.last_sync_status === 'error' && (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                    )}
                    {connection.last_sync_status === 'pending' && (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                    )}
                    {connection.last_sync_status === 'success' ? t('connected') :
                     connection.last_sync_status === 'error' ? t('syncFailed') :
                     connection.last_sync_status === 'pending' ? t('syncing') : t('connected')}
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
                  <ExchangeLogo exchange={exchange.id} size={20} />
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
                  background: 'var(--color-accent-error-10)',
                  border: '1px solid var(--color-red-border)',
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

