'use client'
import PasswordInput from '@/app/components/ui/PasswordInput'

import { useCallback, useEffect, useState, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { bootstrapClientAuth } from '@/lib/auth/client-auth-bootstrap'
import { tokens, alpha, alpha as colorAlpha } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import ExchangeLogo from '@/app/components/ui/ExchangeLogo'
import ErrorState from '@/app/components/ui/ErrorState'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import { getCsrfHeaders } from '@/lib/api/client'
import { EXCHANGE_CONFIGS, type ExchangeId } from './exchange-configs'

function ApiKeyAuthContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const push = router.push
  const { t, language } = useLanguage()
  const { showToast } = useToast()
  const exchangeParam = searchParams.get('exchange') as ExchangeId | null

  const [userId, setUserId] = useState<string | null>(null)
  const [authStatus, setAuthStatus] = useState<'loading' | 'ready' | 'error'>('loading')
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
    style.textContent =
      '@media (min-width: 768px) { .api-key-grid { grid-template-columns: 1fr 1fr !important; } }'
    document.head.appendChild(style)
  }, [])

  const loadAuth = useCallback(async () => {
    setAuthStatus('loading')
    const result = await bootstrapClientAuth(supabase.auth)

    if (result.status === 'signed-out') {
      push('/login?redirect=/exchange/auth/api-key')
      return
    }
    if (result.status === 'error') {
      setAuthStatus('error')
      return
    }

    setUserId(result.user.id)
    setAuthStatus('ready')
  }, [push])

  useEffect(() => {
    void loadAuth()
  }, [loadAuth])

  // This page is an INTERNAL step of the /exchange/auth flow — always reached
  // with a chosen ?exchange=. If someone lands here bare (or with an unknown
  // exchange), funnel them back to the single entry point (the method chooser)
  // instead of showing a second, parallel exchange picker.
  useEffect(() => {
    if (exchangeParam && exchangeParam in EXCHANGE_CONFIGS) {
      setSelectedExchange(exchangeParam)
    } else {
      router.replace('/exchange/auth')
    }
  }, [exchangeParam, router])

  const handlePaste = async (field: 'apiKey' | 'apiSecret' | 'passphrase') => {
    try {
      const text = await navigator.clipboard.readText()
      if (field === 'apiKey') setApiKey(text.trim())
      else if (field === 'apiSecret') setApiSecret(text.trim())
      else setPassphrase(text.trim())
      showToast(t('pasted'), 'success')
    } catch {
      showToast(t('cannotAccessClipboard'), 'error')
    }
  }

  const handleSubmit = async () => {
    if (!selectedExchange || !apiKey || !apiSecret) {
      setError(t('fillAllRequired'))
      return
    }

    const config = EXCHANGE_CONFIGS[selectedExchange]
    if (config.needsPassphrase && !passphrase) {
      setError(t('fillPassphrase'))
      return
    }

    setLoading(true)
    setError(null)

    try {
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession()
      if (sessionError) {
        setError(t('loadFailedRetryShort'))
        return
      }
      if (!session) {
        showToast(t('pleaseLogin'), 'warning')
        router.push('/login?redirect=/exchange')
        return
      }

      const response = await fetch('/api/exchange/connect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({
          exchange: selectedExchange,
          apiKey,
          apiSecret,
          passphrase: config.needsPassphrase ? passphrase : undefined,
        }),
      })

      const result = await response.json().catch(() => null)

      if (!response.ok) {
        // 就地渲染字段级错误 + 保留用户输入,绝不 throw 到 error boundary。
        // 区分「你的 key 有问题(改 key)」vs「服务端临时错误(可重试)」两类文案。
        // result.error 强制转字符串,防后端返回对象时 <Text>{error}</Text> 渲染崩溃触发整页错误边界。
        const rawMsg = typeof result?.error === 'string' ? result.error.trim() : ''
        if (response.status >= 500) {
          setError(t('bindServerErrorRetry'))
        } else if (rawMsg && rawMsg !== 'Invalid input') {
          // 交易所/后端返回的具体原因(密钥无效/缺只读权限/IP 白名单)
          setError(rawMsg)
        } else {
          setError(t('invalidApiKeyCredentials'))
        }
        return
      }

      showToast(t('bindSuccess'), 'success')
      router.push('/settings')
    } catch {
      // 网络/解析异常 = 服务端临时问题,可重试(输入保留)
      setError(t('bindServerErrorRetry'))
    } finally {
      setLoading(false)
    }
  }

  if (authStatus === 'error') {
    return (
      <Box
        style={{
          minHeight: '100vh',
          background: tokens.colors.bg.primary,
          color: tokens.colors.text.primary,
        }}
      >
        <Box style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[6] }}>
          <ErrorState
            title={t('somethingWentWrong')}
            description={t('loadFailedRetryShort')}
            retry={() => void loadAuth()}
            variant="compact"
          />
        </Box>
      </Box>
    )
  }

  if (authStatus === 'loading' || !userId) {
    return (
      <Box
        style={{
          minHeight: '100vh',
          background: tokens.colors.bg.primary,
          color: tokens.colors.text.primary,
        }}
      >
        <Box style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Text size="lg">{t('loading')}</Text>
        </Box>
      </Box>
    )
  }

  const config = selectedExchange ? EXCHANGE_CONFIGS[selectedExchange] : null
  const steps = config
    ? config.steps[language as 'zh' | 'en' | 'ja' | 'ko'] || config.steps.en || config.steps.zh
    : []

  return (
    <Box
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
      }}
    >
      <Box style={{ maxWidth: 960, margin: '0 auto', padding: tokens.spacing[6] }}>
        {/* 标题 */}
        <Box style={{ marginBottom: tokens.spacing[6] }}>
          <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[2] }}>
            {t('apiKeyBindTitle')}
          </Text>
          <Text size="sm" color="secondary">
            {t('apiKeyBindDesc')}
          </Text>
        </Box>

        {/* 主内容区 — exchange is always pre-selected via ?exchange= from the
            /exchange/auth chooser; a bare visit redirects there (see effect above) */}
        {selectedExchange && config && (
          <Box style={{ display: 'grid', gridTemplateColumns: '1fr', gap: tokens.spacing[6] }}>
            {/* 移动端优先：上下布局，桌面端会通过 CSS 变成左右布局 */}
            <Box
              className="api-key-grid"
              style={{ display: 'grid', gridTemplateColumns: '1fr', gap: tokens.spacing[6] }}
            >
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
                  <ExchangeLogo exchange={selectedExchange} size={32} />
                  <Text size="xl" weight="bold">
                    {config.name}
                  </Text>
                  <Button
                    variant="text"
                    size="sm"
                    onClick={() => {
                      // Return to the single entry point (method chooser) rather
                      // than a second in-page picker.
                      setApiKey('')
                      setApiSecret('')
                      setPassphrase('')
                      setError(null)
                      router.push('/exchange/auth')
                    }}
                    style={{ marginLeft: 'auto' }}
                  >
                    {t('changeExchange')}
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
                  <Box
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginBottom: tokens.spacing[4],
                    }}
                  >
                    <Text size="lg" weight="bold">
                      {t('operationStepsLabel')}
                    </Text>
                    <Text size="xs" color="tertiary">
                      {t('estimatedTime')}
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
                            color: tokens.colors.white,
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
                    {t('openApiManagement').replace('{exchange}', config.name)}
                  </Button>
                </Box>

                {/* 视频教程（预留） */}
                <Box
                  style={{
                    padding: tokens.spacing[3],
                    borderRadius: tokens.radius.lg,
                    background: `${alpha(tokens.colors.accent.primary, 8)}`,
                    border: `1px solid ${alpha(tokens.colors.accent.primary, 19)}`,
                  }}
                >
                  <Text size="sm" color="secondary">
                    {t('videoComingSoon')}
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
                    background: `${alpha(tokens.colors.accent.success, 8)}`,
                    border: `1px solid ${alpha(tokens.colors.accent.success, 25)}`,
                    marginBottom: tokens.spacing[4],
                  }}
                >
                  <Box
                    style={{ display: 'flex', alignItems: 'flex-start', gap: tokens.spacing[3] }}
                  >
                    <Box
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: '50%',
                        background: colorAlpha(tokens.colors.accent.success, 19),
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke={tokens.colors.accent.success}
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
                      </svg>
                    </Box>
                    <Box>
                      <Text
                        size="sm"
                        weight="bold"
                        style={{
                          marginBottom: tokens.spacing[2],
                          color: tokens.colors.accent.success,
                        }}
                      >
                        {t('securityNoticeTitle')}
                      </Text>
                      <Text size="xs" color="secondary" style={{ lineHeight: 1.6 }}>
                        {`• ${t('securityTip1')}`}
                        <br />
                        {`• ${t('securityTip2')}`}
                        <br />
                        {`• ${t('securityTip3')}`}
                      </Text>
                    </Box>
                  </Box>
                </Box>

                {/* 输入表单 */}
                <Box bg="secondary" p={5} radius="xl" border="primary">
                  <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>
                    {t('enterApiInfo')}
                  </Text>

                  {error && (
                    <Box
                      style={{
                        padding: tokens.spacing[3],
                        borderRadius: tokens.radius.md,
                        background: `${alpha(tokens.colors.accent.error, 13)}`,
                        border: `1px solid ${alpha(tokens.colors.accent.error, 25)}`,
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
                        placeholder={t('pasteYourApiKey')}
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
                        {t('paste')}
                      </Button>
                    </Box>
                  </Box>

                  {/* API Secret */}
                  <Box style={{ marginBottom: tokens.spacing[4] }}>
                    <Text size="sm" weight="semibold" style={{ marginBottom: tokens.spacing[2] }}>
                      API Secret <span style={{ color: tokens.colors.accent.error }}>*</span>
                    </Text>
                    <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
                      <PasswordInput
                        value={apiSecret}
                        onChange={(e) => setApiSecret(e.target.value)}
                        placeholder={t('pasteYourApiSecret')}
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
                        {t('paste')}
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
                        <PasswordInput
                          value={passphrase}
                          onChange={(e) => setPassphrase(e.target.value)}
                          placeholder={t('pasteYourPassphrase')}
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
                          {t('paste')}
                        </Button>
                      </Box>
                      <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[2] }}>
                        {t('passphraseHint')}
                      </Text>
                    </Box>
                  )}

                  {/* 提交按钮 */}
                  <Button
                    variant="primary"
                    fullWidth
                    onClick={handleSubmit}
                    disabled={
                      loading || !apiKey || !apiSecret || (config.needsPassphrase && !passphrase)
                    }
                    style={{ marginTop: tokens.spacing[2] }}
                  >
                    {loading
                      ? t('verifying')
                      : t('bindExchangeName').replace('{exchange}', config.name)}
                  </Button>
                </Box>
              </Box>
            </Box>
          </Box>
        )}

        {/* 返回按钮 */}
        <Box style={{ marginTop: tokens.spacing[6] }}>
          <Button variant="text" onClick={() => router.push('/settings')}>
            ← {t('returnToSettings')}
          </Button>
        </Box>
      </Box>
    </Box>
  )
}

export default function ApiKeyAuthPage() {
  const { t } = useLanguage()
  return (
    <Suspense
      fallback={
        <Box
          style={{
            minHeight: '100vh',
            background: 'var(--bg-primary)',
            color: 'var(--text-primary)',
          }}
        >
          <Box style={{ maxWidth: 900, margin: '0 auto', padding: '24px' }}>
            <Text size="lg">{t('loading')}</Text>
          </Box>
        </Box>
      }
    >
      <ApiKeyAuthContent />
    </Suspense>
  )
}
