'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { Box, Text, Button } from '@/app/components/Base'
import { tokens } from '@/lib/design-tokens'

const EXCHANGES = [
  { id: 'binance', name: 'Binance', icon: '🟡' },
] as const

export default function ExchangeQuickConnect() {
  const router = useRouter()
  const [userId, setUserId] = useState<string | null>(null)
  const [hasConnection, setHasConnection] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const uid = data.user?.id ?? null
      setUserId(uid)
      if (uid) {
        checkConnection(uid)
      } else {
        setLoading(false)
      }
    })
  }, [])

  const checkConnection = async (uid: string) => {
    try {
      const { data } = await supabase
        .from('user_exchange_connections')
        .select('id')
        .eq('user_id', uid)
        .eq('is_active', true)
        .limit(1)

      setHasConnection(!!data && data.length > 0)
    } catch (err) {
      console.error('[ExchangeQuickConnect] 检查连接失败:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleConnect = (exchange: string) => {
    if (!userId) {
      router.push('/login')
      return
    }

    // 跳转到授权引导页面
    router.push(`/exchange/auth?exchange=${exchange}`)
  }

  if (loading) {
    return null
  }

  // 如果已登录但未绑定，显示快速绑定按钮
  if (userId && !hasConnection) {
    return (
      <Box
        style={{
          padding: tokens.spacing[4],
          borderRadius: tokens.radius.xl,
          background: tokens.colors.bg.secondary,
          border: `1px solid ${tokens.colors.border.primary}`,
          marginBottom: tokens.spacing[6],
        }}
      >
        <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: tokens.spacing[3] }}>
          <Box>
            <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[1] }}>
              绑定交易所账号
            </Text>
            <Text size="sm" color="tertiary">
              绑定后可以查看详细的交易统计数据
            </Text>
          </Box>
          <Box style={{ display: 'flex', gap: tokens.spacing[2], flexWrap: 'wrap' }}>
            {EXCHANGES.map((exchange) => (
              <Button
                key={exchange.id}
                variant="primary"
                size="sm"
                onClick={() => handleConnect(exchange.id)}
              >
                {exchange.icon} 绑定 {exchange.name}
              </Button>
            ))}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => router.push('/settings')}
            >
              前往设置
            </Button>
          </Box>
        </Box>
      </Box>
    )
  }

  return null
}

