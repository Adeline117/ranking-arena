'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { Box, Text, Button } from '@/app/components/base'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { useToast } from '@/app/components/ui/Toast'

function ExchangeAuthorizePageContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { showToast } = useToast()
  const [exchange, setExchange] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [instructions, setInstructions] = useState<string[]>([])
  const [email, setEmail] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
    })

    const exchangeParam = searchParams.get('exchange')
    if (!exchangeParam) {
      router.push('/settings')
      return
    }

    setExchange(exchangeParam)
    loadAuthUrl(exchangeParam)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, router])

  const loadAuthUrl = async (ex: string) => {
    try {
      setLoading(true)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        router.push('/login')
        return
      }

      const response = await fetch(`/api/exchange/authorize?exchange=${ex}&userId=${session.user.id}`)
      const result = await response.json()

      if (!response.ok) {
        showToast(result.error || '加载授权页面失败', 'error')
        router.push('/settings')
        return
      }

      setAuthUrl(result.authUrl)
      setInstructions(result.instructions || [])
    } catch (error: unknown) {
      console.error('[ExchangeAuthorize] 加载失败:', error)
      showToast('加载失败，请重试', 'error')
      router.push('/settings')
    } finally {
      setLoading(false)
    }
  }

  const handleOpenAuth = () => {
    if (!authUrl) return
    
    // 在新窗口中打开授权页面
    window.open(authUrl, '_blank', 'width=800,height=600')
  }

  const handleBack = () => {
    router.push('/settings')
  }

  if (loading) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Text size="lg">加载中...</Text>
        </Box>
      </Box>
    )
  }

  const exchangeName = exchange?.toUpperCase() || '交易所'

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      
      <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6] }}>
        <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[6] }}>
          绑定 {exchangeName} 账号
        </Text>

        <Box
          bg="secondary"
          p={6}
          radius="xl"
          border="primary"
          style={{ marginBottom: tokens.spacing[6] }}
        >
          <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>
            授权步骤
          </Text>

          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3], marginBottom: tokens.spacing[6] }}>
            {instructions.map((instruction, index) => (
              <Box
                key={index}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: tokens.spacing[2],
                  padding: tokens.spacing[3],
                  borderRadius: tokens.radius.md,
                  background: tokens.colors.bg.primary,
                }}
              >
                <Text size="sm" weight="bold" style={{ color: tokens.colors.text.secondary, minWidth: 20 }}>
                  {index + 1}.
                </Text>
                <Text size="sm" style={{ flex: 1 }}>
                  {instruction}
                </Text>
              </Box>
            ))}
          </Box>

          <Box style={{ display: 'flex', gap: tokens.spacing[3] }}>
            <Button
              variant="primary"
              onClick={handleOpenAuth}
            >
              打开 {exchangeName} 授权页面
            </Button>
            <Button
              variant="secondary"
              onClick={handleBack}
            >
              返回设置
            </Button>
          </Box>
        </Box>

        <Box
          bg="secondary"
          p={6}
          radius="xl"
          border="primary"
        >
          <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>
            重要提示
          </Text>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
            <Text size="sm" color="tertiary">
              • 请确保只授予&ldquo;读取&rdquo;权限，不要授予&ldquo;交易&rdquo;或&ldquo;提现&rdquo;权限
            </Text>
            <Text size="sm" color="tertiary">
              • 您的API Key和Secret将被加密存储，仅用于获取您的交易数据
            </Text>
            <Text size="sm" color="tertiary">
              • 如果您已经创建了API Key，可以直接在设置页面输入
            </Text>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

export default function ExchangeAuthorizePage() {
  return (
    <Suspense fallback={
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={null} />
        <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Text size="lg">加载中...</Text>
        </Box>
      </Box>
    }>
      <ExchangeAuthorizePageContent />
    </Suspense>
  )
}

