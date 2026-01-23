'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import Card from '@/app/components/ui/Card'
import ExchangeLogo from '@/app/components/ui/ExchangeLogo'
import Link from 'next/link'
import { getCsrfHeaders } from '@/lib/api/client'
import type { Exchange } from '@/lib/exchange'
import { useToast } from '@/app/components/ui/Toast'

interface TradingData {
  total_trades: number
  avg_profit: number
  avg_loss: number
  profitable_trades_pct: number
  avg_holding_time_days: number
  profitable_holding_time_days: number
}

interface ExchangeConnection {
  id: string
  exchange: Exchange
  is_active: boolean
  last_sync_at: string | null
  last_sync_status: string | null
}

export default function AccountRequiredStats({ userId }: { userId: string }) {
  const { showToast } = useToast()
  const [connections, setConnections] = useState<ExchangeConnection[]>([])
  const [tradingData, setTradingData] = useState<Record<string, TradingData>>({})
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState<Record<string, boolean>>({})

  useEffect(() => {
    loadData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  const loadData = async () => {
    try {
      // 获取连接
      const { data: connData } = await supabase
        .from('user_exchange_connections')
        .select('id, exchange, is_active, last_sync_at, last_sync_status')
        .eq('user_id', userId)
        .eq('is_active', true)

      setConnections(connData || [])

      // 获取交易数据
      if (connData && connData.length > 0) {
        const exchanges = connData.map(c => c.exchange)
        const { data: tradingDataList } = await supabase
          .from('user_trading_data')
          .select('exchange, total_trades, avg_profit, avg_loss, profitable_trades_pct, avg_holding_time_days, profitable_holding_time_days')
          .eq('user_id', userId)
          .in('exchange', exchanges)
          .order('period_end', { ascending: false })

        const dataMap: Record<string, TradingData> = {}
        tradingDataList?.forEach((item) => {
          if (item && typeof item === 'object' && 'exchange' in item && !dataMap[item.exchange as string]) {
            dataMap[item.exchange as string] = item as TradingData
          }
        })
        setTradingData(dataMap)
      }
    } catch (_err) {
      // 静默处理错误，不影响 UI
    } finally {
      setLoading(false)
    }
  }

  const handleSync = async (exchange: string) => {
    setSyncing({ ...syncing, [exchange]: true })
    try {
      const response = await fetch('/api/exchange/sync', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          ...getCsrfHeaders()
        },
        body: JSON.stringify({ userId, exchange }),
      })

      if (!response.ok) {
        const error = await response.json()
        showToast('同步失败: ' + (error.error || 'Unknown error'), 'error')
        return
      }

      // 重新加载数据
      await loadData()
      showToast('同步成功！', 'success')
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : '同步失败'
      showToast('同步失败: ' + errorMessage, 'error')
    } finally {
      setSyncing({ ...syncing, [exchange]: false })
    }
  }

  if (loading) {
    return (
      <Card title="账户必需数据">
        <Text size="sm" color="tertiary">加载中...</Text>
      </Card>
    )
  }

  if (connections.length === 0) {
    return (
      <Card title="账户必需数据">
        <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[4] }}>
          绑定交易所账号后，可查看详细的交易数据和分析指标。
        </Text>
        <Link href="/exchange/auth">
          <Button variant="primary" size="sm">
            + 绑定交易所
          </Button>
        </Link>
      </Card>
    )
  }

  return (
    <Card title="账户必需数据">
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
        {connections.map((conn) => {
          const data = tradingData[conn.exchange]
          return (
            <Box
              key={conn.id}
              style={{
                padding: tokens.spacing[4],
                borderRadius: tokens.radius.xl,
                background: tokens.colors.bg.secondary,
                border: `1px solid ${tokens.colors.border.primary}`,
              }}
            >
              <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[3] }}>
                <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                  <ExchangeLogo exchange={conn.exchange} size={24} />
                  <Text size="md" weight="bold" style={{ textTransform: 'capitalize' }}>
                    {conn.exchange}
                  </Text>
                </Box>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handleSync(conn.exchange)}
                  disabled={syncing[conn.exchange]}
                >
                  {syncing[conn.exchange] ? '同步中...' : '同步数据'}
                </Button>
              </Box>

              {data ? (
                <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: tokens.spacing[3] }}>
                  <Box>
                    <Text size="xs" color="tertiary">总交易次数</Text>
                    <Text size="lg" weight="bold">{data.total_trades}</Text>
                  </Box>
                  <Box>
                    <Text size="xs" color="tertiary">盈利交易百分比</Text>
                    <Text size="lg" weight="bold">{data.profitable_trades_pct.toFixed(1)}%</Text>
                  </Box>
                  <Box>
                    <Text size="xs" color="tertiary">平均盈利</Text>
                    <Text size="lg" weight="bold" style={{ color: '#7CFFB2' }}>
                      ${data.avg_profit.toFixed(2)}
                    </Text>
                  </Box>
                  <Box>
                    <Text size="xs" color="tertiary">平均亏损</Text>
                    <Text size="lg" weight="bold" style={{ color: '#ff7c7c' }}>
                      ${Math.abs(data.avg_loss).toFixed(2)}
                    </Text>
                  </Box>
                  <Box>
                    <Text size="xs" color="tertiary">平均持仓时间</Text>
                    <Text size="lg" weight="bold">{data.avg_holding_time_days.toFixed(1)} 天</Text>
                  </Box>
                  {conn.last_sync_at && (
                    <Box>
                      <Text size="xs" color="tertiary">最后同步</Text>
                      <Text size="sm" color="secondary">
                        {new Date(conn.last_sync_at).toLocaleString('zh-CN')}
                      </Text>
                    </Box>
                  )}
                </Box>
              ) : (
                <Box style={{ textAlign: 'center', padding: tokens.spacing[4] }}>
                  <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
                    暂无交易数据
                  </Text>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleSync(conn.exchange)}
                    disabled={syncing[conn.exchange]}
                  >
                    {syncing[conn.exchange] ? '同步中...' : '立即同步'}
                  </Button>
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    </Card>
  )
}

