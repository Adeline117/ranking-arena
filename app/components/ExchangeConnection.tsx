'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase/client'
import { Box, Text, Button } from '@/app/components/Base'
import { tokens } from '@/lib/design-tokens'
import type { ExchangeConnection } from '@/lib/exchange'
import ExchangeLogo from './UI/ExchangeLogo'

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
    } catch (err: any) {
      console.error('[ExchangeConnection] 加载连接异常:', {
        error: err,
        message: err?.message,
        stack: err?.stack,
        userId,
      })
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
        alert('请先登录')
        return
      }

      const response = await fetch('/api/exchange/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ exchange }),
      })

      const result = await response.json()

      if (!response.ok) {
        alert(result.error || '同步失败')
        return
      }

      alert('数据同步成功！')
      await loadConnections()
    } catch (err: any) {
      alert(err.message || '同步失败')
    } finally {
      setSyncing(null)
    }
  }

  const handleDisconnect = async (exchange: string) => {
    if (!confirm(`确定要断开 ${exchange} 的连接吗？`)) {
      return
    }

    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        alert('请先登录')
        return
      }

      const response = await fetch('/api/exchange/disconnect', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ exchange }),
      })

      const result = await response.json()

      if (!response.ok) {
        alert(result.error || '断开连接失败')
        return
      }

      alert('已断开连接')
      await loadConnections()
    } catch (err: any) {
      alert(err.message || '断开连接失败')
    }
  }

  if (loading) {
    return (
      <Box style={{ padding: tokens.spacing[4] }}>
        <Text color="tertiary">加载中...</Text>
      </Box>
    )
  }

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
      <Text size="lg" weight="black">
        绑定交易所账号
      </Text>
      <Text size="sm" color="tertiary">
        绑定您的交易所账号后，可以查看详细的交易统计数据
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
                <ExchangeLogo exchange={exchange.id as any} size={32} />
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
                    {connection.last_sync_status === 'success' ? '✅ 已连接' : 
                     connection.last_sync_status === 'error' ? '❌ 同步失败' : 
                     connection.last_sync_status === 'pending' ? '⏳ 同步中' : '已连接'}
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
                    {isSyncing ? '同步中...' : '刷新数据'}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleDisconnect(exchange.id)}
                  >
                    断开
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
                  绑定 {exchange.name}
                </Button>
              )}
            </Box>

            {connection && connection.last_sync_at && (
              <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
                最后同步：{new Date(connection.last_sync_at).toLocaleString('zh-CN')}
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
                  同步错误：{connection.last_sync_error}
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
                  点击按钮将跳转到 {exchange.name} 登录页面，登录成功后系统将自动获取您的交易数据。
                </Text>
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

