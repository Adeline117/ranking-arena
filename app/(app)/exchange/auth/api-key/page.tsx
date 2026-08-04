'use client'
import PasswordInput from '@/app/components/ui/PasswordInput'

import { useEffect, useRef, useState, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { tokens, alpha, alpha as colorAlpha } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import ExchangeLogo from '@/app/components/ui/ExchangeLogo'
import ErrorState from '@/app/components/ui/ErrorState'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import { authedFetch } from '@/lib/api/client'
import { useAuthSession, type AuthSessionReturn } from '@/lib/hooks/useAuthSession'
import {
  captureExchangeViewer,
  isExchangeViewerCurrent,
  type ExchangeViewerSnapshot,
} from '@/lib/exchange/viewer-scope'
import { readExchangeConnectAcknowledgement } from '@/lib/exchange/connection-mutation-contract'
import { EXCHANGE_CONFIGS, type ExchangeId } from './exchange-configs'

type SecretField = 'apiKey' | 'apiSecret' | 'passphrase'

type FormOwner = Pick<ExchangeViewerSnapshot, 'viewerKey' | 'sessionGeneration' | 'userId'>

type SubmitOperation = {
  id: number
  viewer: ExchangeViewerSnapshot
  exchange: ExchangeId
  controller: AbortController
}

type ConnectExchangeResponse = {
  error?: unknown
}

function capturePageViewer(auth: AuthSessionReturn): ExchangeViewerSnapshot | null {
  return auth.userId ? captureExchangeViewer(auth, auth.userId) : null
}

function sameFormViewer(owner: FormOwner | null, viewer: ExchangeViewerSnapshot | null): boolean {
  return (
    owner !== null &&
    viewer !== null &&
    owner.viewerKey === viewer.viewerKey &&
    owner.sessionGeneration === viewer.sessionGeneration &&
    owner.userId === viewer.userId
  )
}

export function ApiKeyAuthContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { t, language } = useLanguage()
  const { showToast } = useToast()
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const exchangeParam = searchParams.get('exchange') as ExchangeId | null

  const [selectedExchange, setSelectedExchange] = useState<ExchangeId | null>(exchangeParam)
  const [rawApiKey, setApiKey] = useState('')
  const [rawApiSecret, setApiSecret] = useState('')
  const [rawPassphrase, setPassphrase] = useState('')
  const [rawLoading, setLoading] = useState(false)
  const [rawError, setError] = useState<string | null>(null)
  const [formOwner, setFormOwner] = useState<FormOwner | null>(null)
  const formOwnerRef = useRef<FormOwner | null>(null)
  const mountedRef = useRef(false)
  const submitOperationRef = useRef<SubmitOperation | null>(null)
  const nextSubmitOperationIdRef = useRef(0)
  const pasteOperationIdsRef = useRef<Record<SecretField, number>>({
    apiKey: 0,
    apiSecret: 0,
    passphrase: 0,
  })

  const renderViewer = capturePageViewer(auth)
  const formBelongsToViewer = sameFormViewer(formOwner, renderViewer)
  const apiKey = formBelongsToViewer ? rawApiKey : ''
  const apiSecret = formBelongsToViewer ? rawApiSecret : ''
  const passphrase = formBelongsToViewer ? rawPassphrase : ''
  const loading = formBelongsToViewer ? rawLoading : false
  const error = formBelongsToViewer ? rawError : null

  const ownForm = (viewer: ExchangeViewerSnapshot) => {
    const owner: FormOwner = {
      viewerKey: viewer.viewerKey,
      sessionGeneration: viewer.sessionGeneration,
      userId: viewer.userId,
    }
    formOwnerRef.current = owner
    setFormOwner(owner)
  }

  const viewerIsCurrent = (viewer: ExchangeViewerSnapshot): boolean =>
    mountedRef.current && isExchangeViewerCurrent(viewer, authRef.current, viewer.userId)

  const formIsCurrent = (viewer: ExchangeViewerSnapshot): boolean =>
    sameFormViewer(formOwnerRef.current, viewer) && viewerIsCurrent(viewer)

  const clearSecrets = () => {
    setApiKey('')
    setApiSecret('')
    setPassphrase('')
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      submitOperationRef.current?.controller.abort()
      submitOperationRef.current = null
    }
  }, [])

  useEffect(() => {
    const operation = submitOperationRef.current
    if (operation && !viewerIsCurrent(operation.viewer)) {
      operation.controller.abort()
      submitOperationRef.current = null
    }
    pasteOperationIdsRef.current.apiKey += 1
    pasteOperationIdsRef.current.apiSecret += 1
    pasteOperationIdsRef.current.passphrase += 1
    formOwnerRef.current = null
    setFormOwner(null)
    clearSecrets()
    setLoading(false)
    setError(null)
  }, [auth.authChecked, auth.loading, auth.sessionGeneration, auth.userId, auth.viewerKey])

  useEffect(() => {
    if (auth.authChecked && !auth.loading && !auth.userId) {
      router.push('/login?redirect=/exchange/auth/api-key')
    }
  }, [auth.authChecked, auth.loading, auth.userId, router])

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

  const updateSecret = (
    field: SecretField,
    value: string,
    viewer: ExchangeViewerSnapshot
  ): void => {
    if (!viewerIsCurrent(viewer)) return
    ownForm(viewer)
    if (field === 'apiKey') setApiKey(value)
    else if (field === 'apiSecret') setApiSecret(value)
    else setPassphrase(value)
  }

  const handlePaste = async (field: SecretField, viewer: ExchangeViewerSnapshot) => {
    if (!viewerIsCurrent(viewer)) return
    const operationId = ++pasteOperationIdsRef.current[field]
    const operationIsCurrent = () =>
      pasteOperationIdsRef.current[field] === operationId && viewerIsCurrent(viewer)

    try {
      const text = await navigator.clipboard.readText()
      if (!operationIsCurrent()) return
      updateSecret(field, text.trim(), viewer)
      if (!operationIsCurrent()) return
      showToast(t('pasted'), 'success')
    } catch {
      if (operationIsCurrent()) showToast(t('cannotAccessClipboard'), 'error')
    }
  }

  const handleSubmit = async (
    viewer: ExchangeViewerSnapshot,
    credentials: {
      exchange: ExchangeId | null
      apiKey: string
      apiSecret: string
      passphrase: string
    }
  ) => {
    if (!formIsCurrent(viewer)) return
    const { exchange, apiKey: submittedApiKey, apiSecret: submittedSecret } = credentials

    if (!exchange || !submittedApiKey || !submittedSecret) {
      setError(t('fillAllRequired'))
      return
    }

    const config = EXCHANGE_CONFIGS[exchange]
    if (config.needsPassphrase && !credentials.passphrase) {
      setError(t('fillPassphrase'))
      return
    }

    const activeOperation = submitOperationRef.current
    if (activeOperation && viewerIsCurrent(activeOperation.viewer)) return
    activeOperation?.controller.abort()

    const operation: SubmitOperation = {
      id: ++nextSubmitOperationIdRef.current,
      viewer,
      exchange,
      controller: new AbortController(),
    }
    submitOperationRef.current = operation
    ownForm(viewer)
    setLoading(true)
    setError(null)
    const operationIsCurrent = () =>
      submitOperationRef.current?.id === operation.id && viewerIsCurrent(viewer)

    let navigating = false
    try {
      const response = await authedFetch<ConnectExchangeResponse>(
        '/api/exchange/connect',
        'POST',
        viewer.accessToken,
        {
          exchange,
          apiKey: submittedApiKey,
          apiSecret: submittedSecret,
          passphrase: config.needsPassphrase ? credentials.passphrase : undefined,
        },
        30_000,
        {
          expectedUserId: viewer.userId,
          expectedSessionGeneration: viewer.sessionGeneration,
          signal: operation.controller.signal,
        }
      )
      if (!operationIsCurrent() || response.stale) return

      if (!response.ok) {
        if (response.status === 401) {
          showToast(t('pleaseLogin'), 'warning')
          if (!operationIsCurrent()) return
          navigating = true
          router.push('/login?redirect=/exchange')
          return
        }
        // 就地渲染字段级错误 + 保留用户输入,绝不 throw 到 error boundary。
        // 区分「你的 key 有问题(改 key)」vs「服务端临时错误(可重试)」两类文案。
        // result.error 强制转字符串,防后端返回对象时 <Text>{error}</Text> 渲染崩溃触发整页错误边界。
        const rawMsg = typeof response.data?.error === 'string' ? response.data.error.trim() : ''
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

      if (!readExchangeConnectAcknowledgement(response.data, viewer.userId, exchange)) {
        setError(t('bindServerErrorRetry'))
        return
      }

      // Both the success UI and navigation are viewer-owned irreversible effects.
      if (!operationIsCurrent()) return
      showToast(t('bindSuccess'), 'success')
      if (!operationIsCurrent()) return
      navigating = true
      clearSecrets()
      router.push('/settings')
    } catch {
      // 网络/解析异常 = 服务端临时问题,可重试(输入保留)
      if (operationIsCurrent()) setError(t('bindServerErrorRetry'))
    } finally {
      if (!navigating && operationIsCurrent()) {
        setLoading(false)
        submitOperationRef.current = null
      }
    }
  }

  const authResolved = auth.authChecked && !auth.loading
  if (authResolved && auth.userId && !renderViewer) {
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
            retry={() => void auth.refreshSession()}
            variant="compact"
          />
        </Box>
      </Box>
    )
  }

  if (!authResolved || !renderViewer) {
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
                            fontWeight: tokens.typography.fontWeight.bold,
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
                        onChange={(e) => updateSecret('apiKey', e.target.value, renderViewer)}
                        disabled={loading}
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
                        onClick={() => void handlePaste('apiKey', renderViewer)}
                        disabled={loading}
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
                        onChange={(e) => updateSecret('apiSecret', e.target.value, renderViewer)}
                        disabled={loading}
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
                        onClick={() => void handlePaste('apiSecret', renderViewer)}
                        disabled={loading}
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
                          onChange={(e) => updateSecret('passphrase', e.target.value, renderViewer)}
                          disabled={loading}
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
                          onClick={() => void handlePaste('passphrase', renderViewer)}
                          disabled={loading}
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
                    onClick={() =>
                      void handleSubmit(renderViewer, {
                        exchange: selectedExchange,
                        apiKey,
                        apiSecret,
                        passphrase,
                      })
                    }
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
