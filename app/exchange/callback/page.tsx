'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { Box, Text, Button } from '@/app/components/base'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { getCsrfHeaders } from '@/lib/api/client'

function ExchangeCallbackPageContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const [exchange, setExchange] = useState<string | null>(null)
  const [email, setEmail] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [apiSecret, setApiSecret] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      if (!data.user) {
        router.push('/login')
        return
      }
    })

    const exchangeParam = searchParams.get('exchange')
    if (exchangeParam) {
      setExchange(exchangeParam)
    } else {
      router.push('/settings')
    }
  }, [searchParams, router])

  const handleConnect = async () => {
    if (!apiKey || !apiSecret) {
      setError('请输入API Key和Secret')
      return
    }

    if (!exchange) {
      setError('缺少交易所信息')
      return
    }

    setError(null)
    setConnecting(true)

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
          ...getCsrfHeaders()
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

      // 连接成功，跳转到设置页面
      alert('绑定成功！正在同步数据...')
      router.push('/settings')
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : '连接失败'
      setError(errorMessage)
    } finally {
      setConnecting(false)
    }
  }

  const exchangeName = exchange?.toUpperCase() || '交易所'

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      
      <Box style={{ maxWidth: 600, margin: '0 auto', padding: tokens.spacing[6] }}>
        <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[2] }}>
          完成 {exchangeName} 绑定
        </Text>
        <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[6] }}>
          请在下方输入您刚才创建的API Key和Secret
        </Text>

        <Box
          bg="secondary"
          p={6}
          radius="xl"
          border="primary"
        >
          {error && (
            <Box
              style={{
                padding: tokens.spacing[3],
                borderRadius: tokens.radius.md,
                background: 'rgba(255, 0, 0, 0.1)',
                border: '1px solid rgba(255, 0, 0, 0.3)',
                marginBottom: tokens.spacing[4],
              }}
            >
              <Text size="sm" style={{ color: '#ff6b6b' }}>{error}</Text>
            </Box>
          )}

          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
            <Box>
              <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2], display: 'block' }}>
                API Key
              </Text>
              <input
                type="text"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="粘贴您的 API Key"
                style={{
                  width: '100%',
                  padding: tokens.spacing[3],
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.primary,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.base,
                  fontFamily: tokens.typography.fontFamily.sans.join(', '),
                  outline: 'none',
                }}
                autoFocus
              />
            </Box>

            <Box>
              <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2], display: 'block' }}>
                API Secret
              </Text>
              <input
                type="password"
                value={apiSecret}
                onChange={(e) => setApiSecret(e.target.value)}
                placeholder="粘贴您的 API Secret"
                style={{
                  width: '100%',
                  padding: tokens.spacing[3],
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.primary,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.base,
                  fontFamily: tokens.typography.fontFamily.sans.join(', '),
                  outline: 'none',
                }}
              />
            </Box>

            <Box style={{ display: 'flex', gap: tokens.spacing[3] }}>
              <Button
                variant="primary"
                onClick={handleConnect}
                disabled={connecting || !apiKey || !apiSecret}
                style={{ flex: 1 }}
              >
                {connecting ? '绑定中...' : '完成绑定'}
              </Button>
              <Button
                variant="secondary"
                onClick={() => router.push('/settings')}
                disabled={connecting}
              >
                稍后绑定
              </Button>
            </Box>
          </Box>
        </Box>

        <Box
          style={{
            marginTop: tokens.spacing[4],
            padding: tokens.spacing[3],
            borderRadius: tokens.radius.md,
            background: tokens.colors.bg.secondary,
            border: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          <Text size="xs" color="tertiary">
            提示：如果还没有创建API Key，请返回 {exchangeName} 页面创建后再来绑定。
          </Text>
        </Box>
      </Box>
    </Box>
  )
}

export default function ExchangeCallbackPage() {
  return (
    <Suspense fallback={
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={null} />
        <Box style={{ maxWidth: 600, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Text size="lg">加载中...</Text>
        </Box>
      </Box>
    }>
      <ExchangeCallbackPageContent />
    </Suspense>
  )
}

