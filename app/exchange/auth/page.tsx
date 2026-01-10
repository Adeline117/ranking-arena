'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { Box, Text, Button } from '@/app/components/Base'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/Layout/TopNav'
import ExchangeLogo from '@/app/components/UI/ExchangeLogo'
import { useLanguage } from '@/app/components/Utils/LanguageProvider'

const EXCHANGE_INFO: Record<string, { name: string; authUrl: string; steps: string[] }> = {
  binance: {
    name: 'Binance',
    authUrl: 'https://www.binance.com/en/my/settings/api-management',
    steps: [
      '登录您的Binance账号',
      '点击"创建API"按钮',
      '选择"系统生成API密钥"',
      '设置API标签（如：Ranking Arena）',
      '完成安全验证（邮箱/短信/Google Authenticator）',
      '创建成功后，复制API Key和Secret',
      '返回此页面完成绑定',
    ],
  },
  bybit: {
    name: 'Bybit',
    authUrl: 'https://www.bybit.com/app/user/api-management',
    steps: [
      '登录您的Bybit账号',
      '进入API管理页面',
      '点击"创建新的API Key"',
      '设置API权限（仅选择"读取"权限）',
      '完成安全验证',
      '复制API Key和Secret',
      '返回此页面完成绑定',
    ],
  },
  bitget: {
    name: 'Bitget',
    authUrl: 'https://www.bitget.com/zh-CN/user/api',
    steps: [
      '登录您的Bitget账号',
      '进入API管理页面',
      '点击"创建API"按钮',
      '设置API权限（仅选择"读取"权限）',
      '完成安全验证',
      '创建成功后，复制API Key和Secret',
      '返回此页面完成绑定',
    ],
  },
  mexc: {
    name: 'MEXC',
    authUrl: 'https://www.mexc.com/user/api',
    steps: [
      '登录您的MEXC账号',
      '进入API管理页面',
      '点击"创建API Key"',
      '设置API权限（仅选择"读取"权限）',
      '完成安全验证',
      '创建成功后，复制API Key和Secret',
      '返回此页面完成绑定',
    ],
  },
  coinex: {
    name: 'CoinEx',
    authUrl: 'https://www.coinex.com/api',
    steps: [
      '登录您的CoinEx账号',
      '进入API管理页面',
      '点击"创建API"',
      '设置API权限（仅选择"读取"权限）',
      '完成安全验证',
      '创建成功后，复制API Key和Secret',
      '返回此页面完成绑定',
    ],
  },
}

function ExchangeAuthPageContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { t } = useLanguage()
  const [exchange, setExchange] = useState<string | null>(null)
  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [step, setStep] = useState<'auth' | 'input'>('auth')
  const [apiKey, setApiKey] = useState('')
  const [apiSecret, setApiSecret] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setUserId(data.user?.id ?? null)
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

  const handleOpenAuth = () => {
    if (!exchange) return
    
    const info = EXCHANGE_INFO[exchange.toLowerCase()]
    if (!info) return

    // 在新窗口中打开交易所页面
    const authWindow = window.open(
      info.authUrl,
      'exchange_auth',
      'width=1200,height=800,scrollbars=yes,resizable=yes'
    )

    if (!authWindow) {
      alert('无法打开新窗口，请检查浏览器弹窗设置')
      return
    }

    // 切换到输入步骤
    setStep('input')
  }

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

      // 连接成功，自动触发同步
      const syncResponse = await fetch('/api/exchange/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ exchange }),
      })

      if (syncResponse.ok) {
        alert(t('bindSuccess'))
      } else {
        alert(t('bindSuccessSyncing'))
      }

      // 跳转到设置页面
      router.push('/settings')
    } catch (err: any) {
      setError(err.message || t('syncError'))
    } finally {
      setConnecting(false)
    }
  }

  if (!exchange) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 600, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Text size="lg">加载中...</Text>
        </Box>
      </Box>
    )
  }

  const info = EXCHANGE_INFO[exchange.toLowerCase()]
  if (!info) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 600, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Text size="lg" weight="bold">{t('unsupportedExchange')}</Text>
          <Button variant="secondary" onClick={() => router.push('/settings')} style={{ marginTop: tokens.spacing[4] }}>
            {t('returnToSettings')}
          </Button>
        </Box>
      </Box>
    )
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      
      <Box style={{ maxWidth: 700, margin: '0 auto', padding: tokens.spacing[6] }}>
        {step === 'auth' ? (
          <>
            <Box style={{ marginBottom: tokens.spacing[6] }}>
              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], marginBottom: tokens.spacing[2] }}>
                <ExchangeLogo exchange={exchange.toLowerCase() as any} size={32} />
                <Text size="2xl" weight="black">
                  {t('bindExchange')} {info.name} {t('account')}
                </Text>
              </Box>
              <Text size="sm" color="tertiary">
                {t('clickToOpenLogin')?.replace('{exchange}', info.name) || `点击按钮将在新窗口中打开 ${info.name} 登录页面`}
              </Text>
            </Box>

            <Box
              bg="secondary"
              p={6}
              radius="xl"
              border="primary"
              style={{ marginBottom: tokens.spacing[6] }}
            >
              <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>
                {t('operationSteps')}
              </Text>
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
                {info.steps.map((stepText, index) => (
                  <Box
                    key={index}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: tokens.spacing[3],
                      padding: tokens.spacing[3],
                      borderRadius: tokens.radius.md,
                      background: tokens.colors.bg.primary,
                    }}
                  >
                    <Box
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: tokens.radius.full,
                        background: tokens.colors.accent.primary,
                        color: tokens.colors.black || '#000000',
                        display: 'grid',
                        placeItems: 'center',
                        fontSize: tokens.typography.fontSize.xs,
                        fontWeight: tokens.typography.fontWeight.black,
                        flexShrink: 0,
                      }}
                    >
                      {index + 1}
                    </Box>
                    <Text size="sm" style={{ flex: 1, lineHeight: 1.6 }}>
                      {stepText}
                    </Text>
                  </Box>
                ))}
              </Box>
            </Box>

            <Box style={{ display: 'flex', gap: tokens.spacing[3] }}>
              <Button
                variant="primary"
                onClick={handleOpenAuth}
                style={{ 
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: tokens.spacing[2],
                }}
              >
                <ExchangeLogo exchange={exchange.toLowerCase() as any} size={20} />
                {t('openLoginPage').replace('{exchange}', info.name)}
              </Button>
              <Button
                variant="secondary"
                onClick={() => router.push('/settings')}
              >
                {t('cancel')}
              </Button>
            </Box>
          </>
        ) : (
          <>
            <Box style={{ marginBottom: tokens.spacing[6] }}>
              <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[2] }}>
                {t('completeBindTitle').replace('{exchange}', info.name)}
              </Text>
              <Text size="sm" color="tertiary">
                {t('completeBindDescription')}
              </Text>
            </Box>

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
                    placeholder={t('pasteApiKey')}
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
                    placeholder={t('pasteApiSecret')}
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
                    {connecting ? t('binding') : t('completeBind')}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => setStep('auth')}
                    disabled={connecting}
                  >
                    {t('back')}
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
                💡 提示：如果还没有创建API Key，请在新窗口中完成创建后再输入。
              </Text>
            </Box>
          </>
        )}
      </Box>
    </Box>
  )
}

export default function ExchangeAuthPage() {
  return (
    <Suspense fallback={
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={null} />
        <Box style={{ maxWidth: 600, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Text size="lg">加载中...</Text>
        </Box>
      </Box>
    }>
      <ExchangeAuthPageContent />
    </Suspense>
  )
}

