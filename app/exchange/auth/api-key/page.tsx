'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { Box, Text, Button } from '@/app/components/base'
import ExchangeLogo from '@/app/components/ui/ExchangeLogo'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import { getCsrfHeaders } from '@/lib/api/client'

// 交易所配置
const EXCHANGE_CONFIGS = {
  binance: {
    name: 'Binance',
    apiManagementUrl: 'https://www.binance.com/en/my/settings/api-management',
    needsPassphrase: false,
    steps: {
      zh: [
        { title: '登录 Binance', desc: '访问 Binance 官网，登录您的账户' },
        { title: '进入 API 管理', desc: '点击右上角头像 → 选择「API 管理」' },
        { title: '创建 API Key', desc: '点击「创建 API」，选择「系统生成」，设置标签名称' },
        { title: '设置只读权限', desc: '只勾选「启用读取」，不要勾选其他权限，完成后复制 API Key 和 Secret' },
      ],
      en: [
        { title: 'Login to Binance', desc: 'Visit Binance website and login to your account' },
        { title: 'Go to API Management', desc: 'Click avatar on top right → Select "API Management"' },
        { title: 'Create API Key', desc: 'Click "Create API", select "System Generated", set a label' },
        { title: 'Set Read-Only Permission', desc: 'Only check "Enable Reading", do not check other permissions. Copy API Key and Secret' },
      ],
    },
  },
  bybit: {
    name: 'Bybit',
    apiManagementUrl: 'https://www.bybit.com/user/api-management',
    needsPassphrase: false,
    steps: {
      zh: [
        { title: '登录 Bybit', desc: '访问 Bybit 官网，登录您的账户' },
        { title: '进入 API 管理', desc: '点击右上角头像 → 选择「API」' },
        { title: '创建 API Key', desc: '点击「创建新密钥」，选择「系统生成 API 密钥」' },
        { title: '设置只读权限', desc: '选择「只读」权限类型，完成安全验证后复制 API Key 和 Secret' },
      ],
      en: [
        { title: 'Login to Bybit', desc: 'Visit Bybit website and login to your account' },
        { title: 'Go to API Management', desc: 'Click avatar on top right → Select "API"' },
        { title: 'Create API Key', desc: 'Click "Create New Key", select "System-generated API Keys"' },
        { title: 'Set Read-Only Permission', desc: 'Select "Read-Only" permission type. Copy API Key and Secret after verification' },
      ],
    },
  },
  bitget: {
    name: 'Bitget',
    apiManagementUrl: 'https://www.bitget.com/account/api',
    needsPassphrase: true,
    steps: {
      zh: [
        { title: '登录 Bitget', desc: '访问 Bitget 官网，登录您的账户' },
        { title: '进入 API 管理', desc: '点击右上角头像 → 「API 管理」' },
        { title: '创建 API Key', desc: '点击「创建 API」，设置备注名和密码短语（Passphrase）' },
        { title: '设置只读权限', desc: '只勾选「只读」权限，完成验证后复制 API Key、Secret 和 Passphrase' },
      ],
      en: [
        { title: 'Login to Bitget', desc: 'Visit Bitget website and login to your account' },
        { title: 'Go to API Management', desc: 'Click avatar on top right → "API Management"' },
        { title: 'Create API Key', desc: 'Click "Create API", set a remark and Passphrase' },
        { title: 'Set Read-Only Permission', desc: 'Only check "Read-Only" permission. Copy API Key, Secret and Passphrase after verification' },
      ],
    },
  },
  mexc: {
    name: 'MEXC',
    apiManagementUrl: 'https://www.mexc.com/user/openapi',
    needsPassphrase: false,
    steps: {
      zh: [
        { title: '登录 MEXC', desc: '访问 MEXC 官网，登录您的账户' },
        { title: '进入 API 管理', desc: '点击右上角头像 → 「API 管理」' },
        { title: '创建 API Key', desc: '点击「创建 API」，输入备注名称' },
        { title: '设置只读权限', desc: '选择「只读」权限，完成安全验证后复制 API Key 和 Secret' },
      ],
      en: [
        { title: 'Login to MEXC', desc: 'Visit MEXC website and login to your account' },
        { title: 'Go to API Management', desc: 'Click avatar on top right → "API Management"' },
        { title: 'Create API Key', desc: 'Click "Create API", enter a remark' },
        { title: 'Set Read-Only Permission', desc: 'Select "Read-Only" permission. Copy API Key and Secret after verification' },
      ],
    },
  },
  coinex: {
    name: 'CoinEx',
    apiManagementUrl: 'https://www.coinex.com/apikey',
    needsPassphrase: false,
    steps: {
      zh: [
        { title: '登录 CoinEx', desc: '访问 CoinEx 官网，登录您的账户' },
        { title: '进入 API 管理', desc: '点击右上角头像 → 「API 管理」' },
        { title: '创建 API Key', desc: '点击「创建 API Key」，输入备注' },
        { title: '设置只读权限', desc: '只勾选「查询」权限，完成验证后复制 API Key 和 Secret' },
      ],
      en: [
        { title: 'Login to CoinEx', desc: 'Visit CoinEx website and login to your account' },
        { title: 'Go to API Management', desc: 'Click avatar on top right → "API Management"' },
        { title: 'Create API Key', desc: 'Click "Create API Key", enter a remark' },
        { title: 'Set Read-Only Permission', desc: 'Only check "Query" permission. Copy API Key and Secret after verification' },
      ],
    },
  },
} as const

type ExchangeId = keyof typeof EXCHANGE_CONFIGS

function ApiKeyAuthContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { t, language } = useLanguage()
  const { showToast } = useToast()
  const exchangeParam = searchParams.get('exchange') as ExchangeId | null

  const [userId, setUserId] = useState<string | null>(null)
  const [selectedExchange, setSelectedExchange] = useState<ExchangeId | null>(exchangeParam)
  const [apiKey, setApiKey] = useState('')
  const [apiSecret, setApiSecret] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 注入响应式网格样式
  useEffect(() => {
    if (typeof document === 'undefined') return
    const styleId = 'api-key-grid-style'
    if (document.getElementById(styleId)) return
    const style = document.createElement('style')
    style.id = styleId
    style.textContent = '@media (min-width: 768px) { .api-key-grid { grid-template-columns: 1fr 1fr !important; } }'
    document.head.appendChild(style)
  }, [])

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) {
        router.push('/login?redirect=/exchange/auth/api-key')
        return
      }
      setUserId(data.user.id)
    })
  }, [router])

  useEffect(() => {
    if (exchangeParam && exchangeParam in EXCHANGE_CONFIGS) {
      setSelectedExchange(exchangeParam)
    }
  }, [exchangeParam])

  const handlePaste = async (field: 'apiKey' | 'apiSecret' | 'passphrase') => {
    try {
      const text = await navigator.clipboard.readText()
      if (field === 'apiKey') setApiKey(text.trim())
      else if (field === 'apiSecret') setApiSecret(text.trim())
      else setPassphrase(text.trim())
      showToast(language === 'zh' ? '已粘贴' : 'Pasted', 'success')
    } catch {
      showToast(language === 'zh' ? '无法访问剪贴板' : 'Cannot access clipboard', 'error')
    }
  }

  const handleSubmit = async () => {
    if (!selectedExchange || !apiKey || !apiSecret) {
      setError(language === 'zh' ? '请填写所有必填项' : 'Please fill in all required fields')
      return
    }

    const config = EXCHANGE_CONFIGS[selectedExchange]
    if (config.needsPassphrase && !passphrase) {
      setError(language === 'zh' ? '请填写 Passphrase' : 'Please enter Passphrase')
      return
    }

    setLoading(true)
    setError(null)

    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        showToast(t('pleaseLogin'), 'warning')
        router.push('/login')
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
          exchange: selectedExchange,
          apiKey,
          apiSecret,
          passphrase: config.needsPassphrase ? passphrase : undefined,
        }),
      })

      const result = await response.json()

      if (!response.ok) {
        setError(result.error || (language === 'zh' ? '绑定失败' : 'Binding failed'))
        return
      }

      showToast(t('bindSuccess'), 'success')
      router.push('/settings')
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : (language === 'zh' ? '绑定失败' : 'Binding failed')
      setError(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  if (!userId) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={null} />
        <Box style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Text size="lg">{t('loading')}</Text>
        </Box>
      </Box>
    )
  }

  const config = selectedExchange ? EXCHANGE_CONFIGS[selectedExchange] : null
  const steps = config ? config.steps[language as 'zh' | 'en'] || config.steps.zh : []

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={null} />

      <Box style={{ maxWidth: 960, margin: '0 auto', padding: tokens.spacing[6] }}>
        {/* 标题 */}
        <Box style={{ marginBottom: tokens.spacing[6] }}>
          <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[2] }}>
            {language === 'zh' ? '使用 API Key 绑定交易所' : 'Bind Exchange with API Key'}
          </Text>
          <Text size="sm" color="secondary">
            {language === 'zh' 
              ? '按照以下步骤创建只读 API Key，安全地同步您的交易数据' 
              : 'Follow the steps below to create a read-only API Key and sync your trading data securely'}
          </Text>
        </Box>

        {/* 交易所选择 */}
        {!selectedExchange && (
          <Box
            bg="secondary"
            p={6}
            radius="xl"
            border="primary"
            style={{ marginBottom: tokens.spacing[6] }}
          >
            <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>
              {language === 'zh' ? '选择交易所' : 'Select Exchange'}
            </Text>
            <Box style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacing[3] }}>
              {(Object.keys(EXCHANGE_CONFIGS) as ExchangeId[]).map((id) => (
                <Button
                  key={id}
                  variant="secondary"
                  onClick={() => {
                    setSelectedExchange(id)
                    router.push(`/exchange/auth/api-key?exchange=${id}`)
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: tokens.spacing[2],
                    padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                  }}
                >
                  <ExchangeLogo exchange={id as any} size={24} />
                  {EXCHANGE_CONFIGS[id].name}
                </Button>
              ))}
            </Box>
          </Box>
        )}

        {/* 主内容区 */}
        {selectedExchange && config && (
          <Box style={{ display: 'grid', gridTemplateColumns: '1fr', gap: tokens.spacing[6] }}>
            {/* 移动端优先：上下布局，桌面端会通过 CSS 变成左右布局 */}
            <Box className="api-key-grid" style={{ display: 'grid', gridTemplateColumns: '1fr', gap: tokens.spacing[6] }}>
              {/* 左侧：步骤引导 */}
              <Box>
                {/* 交易所标题 */}
                <Box
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: tokens.spacing[3],
                    marginBottom: tokens.spacing[4],
                  }}
                >
                  <ExchangeLogo exchange={selectedExchange as any} size={32} />
                  <Text size="xl" weight="bold">{config.name}</Text>
                  <Button
                    variant="text"
                    size="sm"
                    onClick={() => {
                      setSelectedExchange(null)
                      setApiKey('')
                      setApiSecret('')
                      setPassphrase('')
                      setError(null)
                      router.push('/exchange/auth/api-key')
                    }}
                    style={{ marginLeft: 'auto' }}
                  >
                    {language === 'zh' ? '更换' : 'Change'}
                  </Button>
                </Box>

                {/* 步骤列表 */}
                <Box
                  bg="secondary"
                  p={5}
                  radius="xl"
                  border="primary"
                  style={{ marginBottom: tokens.spacing[4] }}
                >
                  <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: tokens.spacing[4] }}>
                    <Text size="lg" weight="bold">
                      {language === 'zh' ? '操作步骤' : 'Steps'}
                    </Text>
                    <Text size="xs" color="tertiary">
                      {language === 'zh' ? '约 2 分钟' : '~2 minutes'}
                    </Text>
                  </Box>

                  <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
                    {steps.map((step, index) => (
                      <Box key={index} style={{ display: 'flex', gap: tokens.spacing[3] }}>
                        {/* 步骤数字 */}
                        <Box
                          style={{
                            width: 28,
                            height: 28,
                            borderRadius: '50%',
                            background: tokens.colors.accent.primary,
                            color: '#fff',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: tokens.typography.fontSize.sm,
                            fontWeight: 700,
                            flexShrink: 0,
                          }}
                        >
                          {index + 1}
                        </Box>
                        {/* 步骤内容 */}
                        <Box style={{ flex: 1 }}>
                          <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[1] }}>
                            {step.title}
                          </Text>
                          <Text size="xs" color="secondary">
                            {step.desc}
                          </Text>
                        </Box>
                      </Box>
                    ))}
                  </Box>

                  {/* 打开交易所按钮 */}
                  <Button
                    variant="secondary"
                    fullWidth
                    onClick={() => window.open(config.apiManagementUrl, '_blank')}
                    style={{ marginTop: tokens.spacing[4] }}
                  >
                    {language === 'zh' ? `打开 ${config.name} API 管理页面` : `Open ${config.name} API Management`}
                  </Button>
                </Box>

                {/* 视频教程（预留） */}
                <Box
                  style={{
                    padding: tokens.spacing[3],
                    borderRadius: tokens.radius.lg,
                    background: `${tokens.colors.accent.primary}15`,
                    border: `1px solid ${tokens.colors.accent.primary}30`,
                  }}
                >
                  <Text size="sm" color="secondary">
                    {language === 'zh' ? '视频教程即将上线' : 'Video tutorial coming soon'}
                  </Text>
                </Box>
              </Box>

              {/* 右侧：输入表单 */}
              <Box>
                {/* 安全提示 */}
                <Box
                  style={{
                    padding: tokens.spacing[4],
                    borderRadius: tokens.radius.xl,
                    background: `${tokens.colors.accent.success}15`,
                    border: `1px solid ${tokens.colors.accent.success}40`,
                    marginBottom: tokens.spacing[4],
                  }}
                >
                  <Box style={{ display: 'flex', alignItems: 'flex-start', gap: tokens.spacing[3] }}>
                    <Box style={{ 
                      width: 28, 
                      height: 28, 
                      borderRadius: '50%', 
                      background: tokens.colors.accent.success + '30',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.accent.success} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
                      </svg>
                    </Box>
                    <Box>
                      <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2], color: tokens.colors.accent.success }}>
                        {language === 'zh' ? '安全提示' : 'Security Notice'}
                      </Text>
                      <Text size="xs" color="secondary" style={{ lineHeight: 1.6 }}>
                        {language === 'zh' ? (
                          <>• 只需勾选「只读/读取」权限，无法进行任何交易操作<br />
                          • API Key 不能提币、不能下单<br />
                          • 您可以随时在交易所撤销授权</>
                        ) : (
                          <>• Only &ldquo;Read-Only&rdquo; permission is needed, no trading operations possible<br />
                          • API Key cannot withdraw or place orders<br />
                          • You can revoke access anytime from the exchange</>
                        )}
                      </Text>
                    </Box>
                  </Box>
                </Box>

                {/* 输入表单 */}
                <Box
                  bg="secondary"
                  p={5}
                  radius="xl"
                  border="primary"
                >
                  <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>
                    {language === 'zh' ? '填写 API 信息' : 'Enter API Information'}
                  </Text>

                  {error && (
                    <Box
                      style={{
                        padding: tokens.spacing[3],
                        borderRadius: tokens.radius.md,
                        background: `${tokens.colors.accent.error}20`,
                        border: `1px solid ${tokens.colors.accent.error}40`,
                        marginBottom: tokens.spacing[4],
                      }}
                    >
                      <Text size="sm" style={{ color: tokens.colors.accent.error }}>
                        {error}
                      </Text>
                    </Box>
                  )}

                  {/* API Key */}
                  <Box style={{ marginBottom: tokens.spacing[4] }}>
                    <Text size="sm" weight="semibold" style={{ marginBottom: tokens.spacing[2] }}>
                      API Key <span style={{ color: tokens.colors.accent.error }}>*</span>
                    </Text>
                    <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
                      <input
                        type="text"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder={language === 'zh' ? '粘贴您的 API Key' : 'Paste your API Key'}
                        style={{
                          flex: 1,
                          padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                          borderRadius: tokens.radius.lg,
                          border: `1px solid ${tokens.colors.border.primary}`,
                          background: tokens.colors.bg.primary,
                          color: tokens.colors.text.primary,
                          fontSize: tokens.typography.fontSize.sm,
                          outline: 'none',
                        }}
                      />
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handlePaste('apiKey')}
                        style={{ whiteSpace: 'nowrap' }}
                      >
                        {language === 'zh' ? '粘贴' : 'Paste'}
                      </Button>
                    </Box>
                  </Box>

                  {/* API Secret */}
                  <Box style={{ marginBottom: tokens.spacing[4] }}>
                    <Text size="sm" weight="semibold" style={{ marginBottom: tokens.spacing[2] }}>
                      API Secret <span style={{ color: tokens.colors.accent.error }}>*</span>
                    </Text>
                    <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
                      <input
                        type="password"
                        value={apiSecret}
                        onChange={(e) => setApiSecret(e.target.value)}
                        placeholder={language === 'zh' ? '粘贴您的 API Secret' : 'Paste your API Secret'}
                        style={{
                          flex: 1,
                          padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                          borderRadius: tokens.radius.lg,
                          border: `1px solid ${tokens.colors.border.primary}`,
                          background: tokens.colors.bg.primary,
                          color: tokens.colors.text.primary,
                          fontSize: tokens.typography.fontSize.sm,
                          outline: 'none',
                        }}
                      />
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handlePaste('apiSecret')}
                        style={{ whiteSpace: 'nowrap' }}
                      >
                        {language === 'zh' ? '粘贴' : 'Paste'}
                      </Button>
                    </Box>
                  </Box>

                  {/* Passphrase (仅 Bitget) */}
                  {config.needsPassphrase && (
                    <Box style={{ marginBottom: tokens.spacing[4] }}>
                      <Text size="sm" weight="semibold" style={{ marginBottom: tokens.spacing[2] }}>
                        Passphrase <span style={{ color: tokens.colors.accent.error }}>*</span>
                      </Text>
                      <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
                        <input
                          type="password"
                          value={passphrase}
                          onChange={(e) => setPassphrase(e.target.value)}
                          placeholder={language === 'zh' ? '粘贴您的 Passphrase' : 'Paste your Passphrase'}
                          style={{
                            flex: 1,
                            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                            borderRadius: tokens.radius.lg,
                            border: `1px solid ${tokens.colors.border.primary}`,
                            background: tokens.colors.bg.primary,
                            color: tokens.colors.text.primary,
                            fontSize: tokens.typography.fontSize.sm,
                            outline: 'none',
                          }}
                        />
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handlePaste('passphrase')}
                          style={{ whiteSpace: 'nowrap' }}
                        >
                          {language === 'zh' ? '粘贴' : 'Paste'}
                        </Button>
                      </Box>
                      <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[2] }}>
                        {language === 'zh' 
                          ? 'Bitget 需要您在创建 API 时设置的密码短语' 
                          : 'Bitget requires the passphrase you set when creating the API'}
                      </Text>
                    </Box>
                  )}

                  {/* 提交按钮 */}
                  <Button
                    variant="primary"
                    fullWidth
                    onClick={handleSubmit}
                    disabled={loading || !apiKey || !apiSecret || (config.needsPassphrase && !passphrase)}
                    style={{ marginTop: tokens.spacing[2] }}
                  >
                    {loading 
                      ? (language === 'zh' ? '验证中...' : 'Verifying...') 
                      : (language === 'zh' ? `绑定 ${config.name}` : `Bind ${config.name}`)}
                  </Button>
                </Box>
              </Box>
            </Box>
          </Box>
        )}

        {/* 返回按钮 */}
        <Box style={{ marginTop: tokens.spacing[6] }}>
          <Button
            variant="text"
            onClick={() => router.push('/settings')}
          >
            ← {t('returnToSettings')}
          </Button>
        </Box>
      </Box>
    </Box>
  )
}

export default function ApiKeyAuthPage() {
  return (
    <Suspense fallback={
      <Box style={{ minHeight: '100vh', background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
        <TopNav email={null} />
        <Box style={{ maxWidth: 900, margin: '0 auto', padding: '24px' }}>
          <Text size="lg">加载中...</Text>
        </Box>
      </Box>
    }>
      <ApiKeyAuthContent />
    </Suspense>
  )
}


