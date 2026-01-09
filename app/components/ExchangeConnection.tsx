'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase/client'
import { Box, Text, Button } from '@/app/components/Base'
import { tokens } from '@/lib/design-tokens'
import type { ExchangeConnection } from '@/lib/exchange'

interface ExchangeConnectionProps {
  userId: string
}

const EXCHANGES = [
  { id: 'binance', name: 'Binance', icon: '🟡' },
  // { id: 'bybit', name: 'Bybit', icon: '🔵' },
  // { id: 'bitget', name: 'Bitget', icon: '🟢' },
] as const

export default function ExchangeConnectionManager({ userId }: ExchangeConnectionProps) {
  const [connections, setConnections] = useState<ExchangeConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [connecting, setConnecting] = useState<string | null>(null)
  const [syncing, setSyncing] = useState<string | null>(null)

  // 连接表单状态
  const [showForm, setShowForm] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [apiSecret, setApiSecret] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadConnections()
  }, [userId])

  const loadConnections = async () => {
    try {
      setLoading(true)
      const { data, error: fetchError } = await supabase
        .from('user_exchange_connections')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })

      if (fetchError) {
        console.error('[ExchangeConnection] 加载连接失败:', fetchError)
        return
      }

      setConnections(data || [])
    } catch (err) {
      console.error('[ExchangeConnection] 加载连接异常:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleConnect = async (exchange: string) => {
    if (!apiKey || !apiSecret) {
      setError('请输入API Key和Secret')
      return
    }

    setError(null)
    setConnecting(exchange)

    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        setError('请先登录')
        return
      }

      const response = await fetch('/api/exchange/connect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          exchange,
          apiKey,
          apiSecret,
        }),
      })

      const result = await response.json()

      if (!response.ok) {
        setError(result.error || '连接失败')
        return
      }

      // 连接成功，刷新列表
      await loadConnections()
      setShowForm(null)
      setApiKey('')
      setApiSecret('')
      alert('连接成功！正在同步数据...')

      // 自动触发同步
      setTimeout(() => {
        handleSync(exchange)
      }, 1000)
    } catch (err: any) {
      setError(err.message || '连接失败')
    } finally {
      setConnecting(null)
    }
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
        const isConnecting = connecting === exchange.id
        const isSyncing = syncing === exchange.id
        const showConnectForm = showForm === exchange.id

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
                <Text size="xl">{exchange.icon}</Text>
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
                  size="sm"
                  onClick={() => setShowForm(showConnectForm ? null : exchange.id)}
                >
                  {showConnectForm ? '取消' : '连接'}
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
                <Text size="xs" style={{ color: '#ff6b6b' }}>
                  同步错误：{connection.last_sync_error}
                </Text>
              </Box>
            )}

            {showConnectForm && (
              <Box
                style={{
                  padding: tokens.spacing[4],
                  borderRadius: tokens.radius.md,
                  background: tokens.colors.bg.primary,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  marginTop: tokens.spacing[4],
                }}
              >
                <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
                  输入API凭证
                </Text>
                <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[4] }}>
                  您的API Key和Secret将被加密存储，仅用于获取您的交易数据。
                  <br />
                  请在 {exchange.name} 创建API Key时，仅授予"读取"权限。
                </Text>

                {error && (
                  <Box
                    style={{
                      padding: tokens.spacing[2],
                      borderRadius: tokens.radius.md,
                      background: 'rgba(255, 0, 0, 0.1)',
                      border: '1px solid rgba(255, 0, 0, 0.3)',
                      marginBottom: tokens.spacing[3],
                    }}
                  >
                    <Text size="xs" style={{ color: '#ff6b6b' }}>{error}</Text>
                  </Box>
                )}

                <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
                  <Box>
                    <Text size="xs" weight="bold" style={{ marginBottom: tokens.spacing[1], display: 'block' }}>
                      API Key
                    </Text>
                    <input
                      type="text"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder="输入您的 API Key"
                      style={{
                        width: '100%',
                        padding: tokens.spacing[2],
                        borderRadius: tokens.radius.md,
                        border: `1px solid ${tokens.colors.border.primary}`,
                        background: tokens.colors.bg.secondary,
                        color: tokens.colors.text.primary,
                        fontSize: tokens.typography.fontSize.sm,
                        fontFamily: tokens.typography.fontFamily.sans.join(', '),
                        outline: 'none',
                      }}
                    />
                  </Box>

                  <Box>
                    <Text size="xs" weight="bold" style={{ marginBottom: tokens.spacing[1], display: 'block' }}>
                      API Secret
                    </Text>
                    <input
                      type="password"
                      value={apiSecret}
                      onChange={(e) => setApiSecret(e.target.value)}
                      placeholder="输入您的 API Secret"
                      style={{
                        width: '100%',
                        padding: tokens.spacing[2],
                        borderRadius: tokens.radius.md,
                        border: `1px solid ${tokens.colors.border.primary}`,
                        background: tokens.colors.bg.secondary,
                        color: tokens.colors.text.primary,
                        fontSize: tokens.typography.fontSize.sm,
                        fontFamily: tokens.typography.fontFamily.sans.join(', '),
                        outline: 'none',
                      }}
                    />
                  </Box>

                  <Button
                    variant="primary"
                    onClick={() => handleConnect(exchange.id)}
                    disabled={isConnecting || !apiKey || !apiSecret}
                  >
                    {isConnecting ? '连接中...' : '确认连接'}
                  </Button>
                </Box>
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

