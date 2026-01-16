'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { Box, Text, Button } from '@/app/components/Base'
import { tokens } from '@/lib/design-tokens'
import ExchangeLogo from './UI/ExchangeLogo'
import { useLanguage } from './Utils/LanguageProvider'

const EXCHANGES = [
  { id: 'binance', name: 'Binance' },
  { id: 'bybit', name: 'Bybit' },
  { id: 'bitget', name: 'Bitget' },
  { id: 'mexc', name: 'MEXC' },
  { id: 'coinex', name: 'CoinEx' },
] as const

export default function ExchangeQuickConnect() {
  const router = useRouter()
  const { t } = useLanguage()
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

  const handleConnect = async (exchange: string) => {
    if (!userId) {
      try {
        router.push('/login')
      } catch (err) {
        console.error('[ExchangeQuickConnect] 导航失败:', err)
        // 回退到 window.location
        window.location.href = '/login'
      }
      return
    }

    // 跳转到授权引导页面
    try {
      router.push(`/exchange/auth?exchange=${exchange}`)
    } catch (err) {
      console.error('[ExchangeQuickConnect] 导航失败:', err)
      window.location.href = `/exchange/auth?exchange=${exchange}`
    }
  }

  if (loading) {
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
            <Box
              style={{
                width: '200px',
                height: '20px',
                background: tokens.colors.bg.primary,
                borderRadius: tokens.radius.md,
                marginBottom: tokens.spacing[1],
                animation: 'pulse 1.5s ease-in-out infinite',
              }}
            />
            <Box
              style={{
                width: '150px',
                height: '16px',
                background: tokens.colors.bg.primary,
                borderRadius: tokens.radius.md,
                animation: 'pulse 1.5s ease-in-out infinite',
              }}
            />
          </Box>
          <Box style={{ display: 'flex', gap: tokens.spacing[2], flexWrap: 'wrap' }}>
            {Array.from({ length: 3 }).map((_, i) => (
              <Box
                key={i}
                style={{
                  width: '100px',
                  height: '32px',
                  background: tokens.colors.bg.primary,
                  borderRadius: tokens.radius.md,
                  animation: 'pulse 1.5s ease-in-out infinite',
                }}
              />
            ))}
          </Box>
        </Box>
      </Box>
    )
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
              {t('bindExchangeAccount')}
            </Text>
            <Text size="sm" color="tertiary">
              {t('bindExchangeDescription')}
            </Text>
          </Box>
          <Box style={{ display: 'flex', gap: tokens.spacing[2], flexWrap: 'wrap' }}>
            {EXCHANGES.map((exchange) => (
              <Button
                key={exchange.id}
                variant="primary"
                size="sm"
                onClick={() => handleConnect(exchange.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: tokens.spacing[2],
                }}
              >
                <ExchangeLogo exchange={exchange.id as any} size={18} />
                {t('bindExchange')} {exchange.name}
              </Button>
            ))}
            <Button
              variant="secondary"
              size="sm"
              onClick={async () => {
                try {
                  router.push('/settings')
                } catch (err) {
                  console.error('[ExchangeQuickConnect] 导航失败:', err)
                  window.location.href = '/settings'
                }
              }}
            >
              {t('goToSettings')}
            </Button>
          </Box>
        </Box>
      </Box>
    )
  }

  return null
}

