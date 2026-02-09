'use client'

/**
 * Trader Authorization Page
 * Allow traders to authorize their exchange accounts for real-time data display
 */

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/layout/TopNav'
import MobileBottomNav from '@/app/components/layout/MobileBottomNav'
import { Box } from '@/app/components/base'
import { tokens } from '@/lib/design-tokens'

const PLATFORMS = [
  { value: 'binance', label: 'Binance', requiresPassphrase: false },
  { value: 'binance_futures', label: 'Binance Futures', requiresPassphrase: false },
  { value: 'bybit', label: 'Bybit', requiresPassphrase: false },
  { value: 'okx', label: 'OKX', requiresPassphrase: true },
  { value: 'bitget', label: 'Bitget', requiresPassphrase: true },
]

const SYNC_FREQUENCIES = [
  { value: 'realtime', label: { zh: '实时同步', en: 'Real-time' } },
  { value: '5min', label: { zh: '5分钟', en: '5 minutes' } },
  { value: '15min', label: { zh: '15分钟', en: '15 minutes' } },
  { value: '1hour', label: { zh: '1小时', en: '1 hour' } },
]

export default function TraderAuthorizePage() {
  const { t: _t, language } = useLanguage()
  const router = useRouter()

  const [user, setUser] = useState<any>(null)
  const [platform, setPlatform] = useState('bybit')
  const [apiKey, setApiKey] = useState('')
  const [apiSecret, setApiSecret] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [label, setLabel] = useState('')
  const [syncFrequency, setSyncFrequency] = useState('realtime')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    // eslint-disable-next-line no-restricted-syntax -- TODO: migrate to useAuthSession()
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user)
    })
  }, [])

  const selectedPlatform = PLATFORMS.find((p) => p.value === platform)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!user) {
      setError(language === 'zh' ? '请先登录' : 'Please login first')
      return
    }

    setLoading(true)
    setError(null)

    try {
      // eslint-disable-next-line no-restricted-syntax -- TODO: migrate to useAuthSession()
      const { data: { session } } = await supabase.auth.getSession()

      const response = await fetch('/api/trader/authorize', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': session?.access_token ? `Bearer ${session.access_token}` : '',
        },
        body: JSON.stringify({
          platform,
          apiKey: apiKey.trim(),
          apiSecret: apiSecret.trim(),
          passphrase: passphrase.trim() || undefined,
          label: label.trim() || undefined,
          syncFrequency,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || data.details || 'Authorization failed')
      }

      setSuccess(true)

      // Clear form
      setApiKey('')
      setApiSecret('')
      setPassphrase('')
      setLabel('')

      // Redirect to settings after 2 seconds
      setTimeout(() => {
        router.push('/settings?tab=authorizations')
      }, 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  if (!user) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
        <TopNav />
        <Box style={{ padding: tokens.spacing[6] }}>
          <h1>{language === 'zh' ? '请先登录' : 'Please Login'}</h1>
          <p>
            {language === 'zh'
              ? '您需要先登录才能授权交易账户'
              : 'You need to login to authorize trading accounts'}
          </p>
        </Box>
        <MobileBottomNav />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <TopNav />

      <Box style={{ padding: tokens.spacing[6], maxWidth: '800px', margin: '0 auto', width: '100%' }}>
        <h1 style={{ fontSize: tokens.typography.fontSize['2xl'], marginBottom: tokens.spacing[3] }}>
          {language === 'zh' ? '授权展示实盘数据' : 'Authorize Real Trading Data'}
        </h1>

        <p style={{ color: tokens.colors.text.secondary, marginBottom: tokens.spacing[6] }}>
          {language === 'zh'
            ? '授权后，您的实盘交易数据将实时展示在排行榜中，获得更高的可信度和关注度。'
            : 'After authorization, your real trading data will be displayed on the leaderboard in real-time with higher credibility.'}
        </p>

        {/* Benefits */}
        <Box
          style={{
            padding: tokens.spacing[5],
            backgroundColor: tokens.colors.bg.secondary,
            borderRadius: tokens.radius.lg,
            marginBottom: tokens.spacing[6],
          }}
        >
          <h2 style={{ marginBottom: tokens.spacing[3], fontSize: tokens.typography.fontSize.lg }}>
            {language === 'zh' ? '授权后可享受：' : 'Benefits:'}
          </h2>
          <ul style={{ paddingLeft: tokens.spacing[5], lineHeight: 1.8 }}>
            <li>{language === 'zh' ? '实时持仓展示' : 'Real-time position display'}</li>
            <li>{language === 'zh' ? '更高排行榜权重' : 'Higher ranking weight'}</li>
            <li>{language === 'zh' ? '官方认证标识' : 'Official verification badge'}</li>
            <li>{language === 'zh' ? '优先推荐位' : 'Priority recommendation'}</li>
          </ul>
        </Box>

        {success && (
          <Box
            style={{
              padding: tokens.spacing[3],
              backgroundColor: tokens.colors.accent.success + '20',
              border: `1px solid ${tokens.colors.accent.success}`,
              borderRadius: tokens.radius.md,
              marginBottom: tokens.spacing[5],
            }}
          >
            <p style={{ color: tokens.colors.accent.success, margin: 0 }}>
              {language === 'zh'
                ? '授权成功！正在跳转到设置页面...'
                : 'Authorization successful! Redirecting to settings...'}
            </p>
          </Box>
        )}

        {error && (
          <Box
            style={{
              padding: tokens.spacing[3],
              backgroundColor: tokens.colors.accent.error + '20',
              border: `1px solid ${tokens.colors.accent.error}`,
              borderRadius: tokens.radius.md,
              marginBottom: tokens.spacing[5],
            }}
          >
            <p style={{ color: tokens.colors.accent.error, margin: 0 }}>{error}</p>
          </Box>
        )}

        <form onSubmit={handleSubmit}>
          {/* Platform Selection */}
          <Box style={{ marginBottom: tokens.spacing[5] }}>
            <label
              htmlFor="platform"
              style={{
                display: 'block',
                marginBottom: tokens.spacing[2],
                fontWeight: 500,
              }}
            >
              {language === 'zh' ? '选择交易所' : 'Select Exchange'}
            </label>
            <select
              id="platform"
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              style={{
                width: '100%',
                padding: tokens.spacing[3],
                fontSize: tokens.typography.fontSize.md,
                borderRadius: tokens.radius.md,
                border: `1px solid ${tokens.colors.border.primary}`,
                backgroundColor: tokens.colors.bg.primary,
                color: tokens.colors.text.primary,
              }}
            >
              {PLATFORMS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </Box>

          {/* API Key */}
          <Box style={{ marginBottom: tokens.spacing[5] }}>
            <label
              htmlFor="apiKey"
              style={{
                display: 'block',
                marginBottom: tokens.spacing[2],
                fontWeight: 500,
              }}
            >
              API Key *
            </label>
            <input
              id="apiKey"
              type="text"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              required
              placeholder={language === 'zh' ? '请输入API Key' : 'Enter API Key'}
              style={{
                width: '100%',
                padding: tokens.spacing[3],
                fontSize: tokens.typography.fontSize.md,
                borderRadius: tokens.radius.md,
                border: `1px solid ${tokens.colors.border.primary}`,
                backgroundColor: tokens.colors.bg.primary,
                color: tokens.colors.text.primary,
              }}
            />
          </Box>

          {/* API Secret */}
          <Box style={{ marginBottom: tokens.spacing[5] }}>
            <label
              htmlFor="apiSecret"
              style={{
                display: 'block',
                marginBottom: tokens.spacing[2],
                fontWeight: 500,
              }}
            >
              API Secret *
            </label>
            <input
              id="apiSecret"
              type="password"
              value={apiSecret}
              onChange={(e) => setApiSecret(e.target.value)}
              required
              placeholder={language === 'zh' ? '请输入API Secret' : 'Enter API Secret'}
              style={{
                width: '100%',
                padding: tokens.spacing[3],
                fontSize: tokens.typography.fontSize.md,
                borderRadius: tokens.radius.md,
                border: `1px solid ${tokens.colors.border.primary}`,
                backgroundColor: tokens.colors.bg.primary,
                color: tokens.colors.text.primary,
              }}
            />
          </Box>

          {/* Passphrase (if required) */}
          {selectedPlatform?.requiresPassphrase && (
            <Box style={{ marginBottom: tokens.spacing[5] }}>
              <label
                htmlFor="passphrase"
                style={{
                  display: 'block',
                  marginBottom: tokens.spacing[2],
                  fontWeight: 500,
                }}
              >
                {language === 'zh' ? '密码短语' : 'Passphrase'} *
              </label>
              <input
                id="passphrase"
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                required={selectedPlatform?.requiresPassphrase}
                placeholder={language === 'zh' ? '请输入密码短语' : 'Enter Passphrase'}
                style={{
                  width: '100%',
                  padding: tokens.spacing[3],
                  fontSize: tokens.typography.fontSize.md,
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  backgroundColor: tokens.colors.bg.primary,
                  color: tokens.colors.text.primary,
                }}
              />
            </Box>
          )}

          {/* Label */}
          <Box style={{ marginBottom: tokens.spacing[5] }}>
            <label
              htmlFor="label"
              style={{
                display: 'block',
                marginBottom: tokens.spacing[2],
                fontWeight: 500,
              }}
            >
              {language === 'zh' ? '备注名称（选填）' : 'Label (Optional)'}
            </label>
            <input
              id="label"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={language === 'zh' ? '例如：主账户' : 'e.g., Main Account'}
              style={{
                width: '100%',
                padding: tokens.spacing[3],
                fontSize: tokens.typography.fontSize.md,
                borderRadius: tokens.radius.md,
                border: `1px solid ${tokens.colors.border.primary}`,
                backgroundColor: tokens.colors.bg.primary,
                color: tokens.colors.text.primary,
              }}
            />
          </Box>

          {/* Sync Frequency */}
          <Box style={{ marginBottom: tokens.spacing[6] }}>
            <label
              htmlFor="syncFrequency"
              style={{
                display: 'block',
                marginBottom: tokens.spacing[2],
                fontWeight: 500,
              }}
            >
              {language === 'zh' ? '同步频率' : 'Sync Frequency'}
            </label>
            <select
              id="syncFrequency"
              value={syncFrequency}
              onChange={(e) => setSyncFrequency(e.target.value)}
              style={{
                width: '100%',
                padding: tokens.spacing[3],
                fontSize: tokens.typography.fontSize.md,
                borderRadius: tokens.radius.md,
                border: `1px solid ${tokens.colors.border.primary}`,
                backgroundColor: tokens.colors.bg.primary,
                color: tokens.colors.text.primary,
              }}
            >
              {SYNC_FREQUENCIES.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label[language]}
                </option>
              ))}
            </select>
          </Box>

          {/* Security Notice */}
          <Box
            style={{
              padding: tokens.spacing[3],
              backgroundColor: tokens.colors.accent.warning + '20',
              border: `1px solid ${tokens.colors.accent.warning}`,
              borderRadius: tokens.radius.md,
              marginBottom: tokens.spacing[6],
            }}
          >
            <p style={{ fontSize: tokens.typography.fontSize.sm, margin: 0, lineHeight: 1.6 }}>
              {language === 'zh'
                ? '您的API凭证将使用AES-256加密存储，仅用于读取交易数据，我们无法进行任何交易操作。建议创建只读权限的API Key。'
                : 'Your API credentials will be encrypted with AES-256 and used only to read trading data. We cannot perform any trading operations. We recommend creating read-only API keys.'}
            </p>
          </Box>

          {/* Submit Button */}
          <button
            type="submit"
            disabled={loading || success}
            style={{
              width: '100%',
              padding: tokens.spacing[3],
              fontSize: tokens.typography.fontSize.md,
              fontWeight: 600,
              borderRadius: tokens.radius.md,
              border: 'none',
              backgroundColor: loading || success ? tokens.colors.text.tertiary : tokens.colors.accent.primary,
              color: tokens.colors.white,
              cursor: loading || success ? 'not-allowed' : 'pointer',
              opacity: loading || success ? 0.6 : 1,
            }}
          >
            {loading
              ? language === 'zh'
                ? '验证中...'
                : 'Validating...'
              : success
                ? language === 'zh'
                  ? '授权成功！'
                  : 'Authorized!'
                : language === 'zh'
                  ? '授权展示数据'
                  : 'Authorize Data Display'}
          </button>
        </form>

        {/* How to Get API Key */}
        <Box style={{ marginTop: tokens.spacing[8] }}>
          <h2 style={{ marginBottom: tokens.spacing[3], fontSize: tokens.typography.fontSize.lg }}>
            {language === 'zh' ? '如何获取API Key?' : 'How to Get API Key?'}
          </h2>
          <ol style={{ paddingLeft: tokens.spacing[5], lineHeight: 1.8 }}>
            <li>
              {language === 'zh'
                ? '登录交易所账户，进入API管理页面'
                : 'Login to your exchange account and go to API management'}
            </li>
            <li>
              {language === 'zh' ? '创建新的API Key' : 'Create a new API Key'}
            </li>
            <li>
              {language === 'zh'
                ? '权限设置：只勾选"读取"权限，不要开启交易和提现权限'
                : 'Permissions: Only check "Read" permissions, do not enable trading or withdrawal'}
            </li>
            <li>
              {language === 'zh'
                ? '可选：设置IP白名单以提高安全性'
                : 'Optional: Set IP whitelist for better security'}
            </li>
            <li>
              {language === 'zh'
                ? '复制API Key和Secret，粘贴到本页面'
                : 'Copy API Key and Secret, paste them here'}
            </li>
          </ol>
        </Box>
      </Box>

      <MobileBottomNav />
    </div>
  )
}
