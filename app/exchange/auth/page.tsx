'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { Box, Text, Button } from '@/app/components/base'
import ExchangeLogo from '@/app/components/ui/ExchangeLogo'
import { useToast } from '@/app/components/ui/Toast'

const EXCHANGES = [
  { id: 'binance', name: 'Binance', oauthSupported: true },
  { id: 'bybit', name: 'Bybit', oauthSupported: true },
  { id: 'bitget', name: 'Bitget', oauthSupported: false },
  { id: 'mexc', name: 'MEXC', oauthSupported: false },
  { id: 'coinex', name: 'CoinEx', oauthSupported: false },
] as const

function ExchangeAuthContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { showToast } = useToast()
  const exchangeParam = searchParams.get('exchange')
  const [userId, setUserId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) {
        router.push('/login?redirect=/exchange/auth')
        return
      }
      setUserId(data.user.id)
    })
  }, [router])

  const handleOAuth = async (exchange: string) => {
    if (!userId) {
      showToast('请先登录', 'warning')
      router.push('/login')
      return
    }

    setLoading(true)
    setError(null)

    try {
      // 获取 OAuth 授权 URL
      const response = await fetch(`/api/exchange/oauth/authorize?exchange=${exchange}&userId=${userId}`)
      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Failed to get OAuth URL')
      }

      // 重定向到交易所 OAuth 页面
      window.location.href = data.authUrl
    } catch (err: any) {
      setError(err.message || '授权失败')
      setLoading(false)
    }
  }

  const handleApiKey = (exchange: string) => {
    router.push(`/exchange/auth/api-key?exchange=${exchange}`)
  }

  if (!userId) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={null} />
        <Box style={{ maxWidth: 600, margin: '0 auto', padding: tokens.spacing[10] }}>
          <Text size="lg">加载中...</Text>
        </Box>
      </Box>
    )
  }

  const selectedExchange = EXCHANGES.find(e => e.id === exchangeParam)

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={null} />
      
      <Box style={{ maxWidth: 600, margin: '0 auto', padding: tokens.spacing[10] }}>
        <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[6] }}>
          绑定交易所账号
        </Text>

        {error && (
          <Box
            style={{
              padding: tokens.spacing[4],
              borderRadius: tokens.radius.md,
              background: '#ff7c7c20',
              border: '1px solid #ff7c7c',
              marginBottom: tokens.spacing[4],
            }}
          >
            <Text size="sm" style={{ color: '#ff7c7c' }}>
              {error}
            </Text>
          </Box>
        )}

        {selectedExchange ? (
          <Box
            bg="secondary"
            p={6}
            radius="xl"
            border="primary"
            style={{ marginBottom: tokens.spacing[4] }}
          >
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], marginBottom: tokens.spacing[4] }}>
              <ExchangeLogo exchange={selectedExchange.id as any} size={32} />
              <Text size="lg" weight="bold">
                {selectedExchange.name}
              </Text>
            </Box>

            <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[4] }}>
              选择授权方式：
            </Text>

            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
              {selectedExchange.oauthSupported ? (
                <Button
                  variant="primary"
                  onClick={() => handleOAuth(selectedExchange.id)}
                  disabled={loading}
                  fullWidth
                >
                  {loading ? '授权中...' : `使用 OAuth 授权 ${selectedExchange.name}`}
                </Button>
              ) : (
                <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
                  {selectedExchange.name} 暂不支持 OAuth 授权
                </Text>
              )}
              
              <Button
                variant="secondary"
                onClick={() => handleApiKey(selectedExchange.id)}
                fullWidth
              >
                使用 API Key 授权
              </Button>
            </Box>
          </Box>
        ) : (
          <Box
            bg="secondary"
            p={6}
            radius="xl"
            border="primary"
            style={{ marginBottom: tokens.spacing[4] }}
          >
            <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[4] }}>
              选择要绑定的交易所：
            </Text>

            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
              {EXCHANGES.map((exchange) => (
                <Button
                  key={exchange.id}
                  variant="secondary"
                  onClick={() => router.push(`/exchange/auth?exchange=${exchange.id}`)}
                  style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}
                >
                  <ExchangeLogo exchange={exchange.id as any} size={20} />
                  {exchange.name}
                </Button>
              ))}
            </Box>
          </Box>
        )}

        <Button
          variant="text"
          onClick={() => router.push('/settings')}
          style={{ marginTop: tokens.spacing[4] }}
        >
          ← 返回设置
        </Button>
      </Box>
    </Box>
  )
}

export default function ExchangeAuthPage() {
  return (
    <Suspense fallback={
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={null} />
        <Box style={{ maxWidth: 600, margin: '0 auto', padding: tokens.spacing[10] }}>
          <Text size="lg">加载中...</Text>
        </Box>
      </Box>
    }>
      <ExchangeAuthContent />
    </Suspense>
  )
}
