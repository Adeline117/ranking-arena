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

export default function TraderAuthorizePage() {
  const { t, language } = useLanguage()
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

  const SYNC_FREQUENCIES = [
    { value: 'realtime', label: t('syncRealtime') },
    { value: '5min', label: t('sync5min') },
    { value: '15min', label: t('sync15min') },
    { value: '1hour', label: t('sync1hour') },
  ]

  useEffect(() => {
     
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user)
    })
  }, [])

  const selectedPlatform = PLATFORMS.find((p) => p.value === platform)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!user) {
      setError(t('pleaseLoginFirst'))
      return
    }

    if (!apiKey.trim() || !apiSecret.trim()) {
      setError(t('fillApiKeySecret'))
      return
    }

    setLoading(true)
    setError(null)

    try {
       
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

      setApiKey('')
      setApiSecret('')
      setPassphrase('')
      setLabel('')

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
          <h1>{t('pleaseLoginTitle')}</h1>
          <p>{t('loginToAuthorize')}</p>
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
          {t('authorizeRealData')}
        </h1>

        <p style={{ color: tokens.colors.text.secondary, marginBottom: tokens.spacing[6] }}>
          {t('authorizeDesc')}
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
            {t('authBenefitsTitle')}
          </h2>
          <ul style={{ paddingLeft: tokens.spacing[5], lineHeight: 1.8 }}>
            <li>{t('authBenefitRealtime')}</li>
            <li>{t('authBenefitWeight')}</li>
            <li>{t('authBenefitBadge')}</li>
            <li>{t('authBenefitPriority')}</li>
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
              {t('authSuccessRedirecting')}
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
              {t('selectExchangeLabel')}
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
              placeholder={t('enterApiKeyPlaceholder')}
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
              placeholder={t('enterApiSecretPlaceholder')}
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
                {t('passphraseLabel')} *
              </label>
              <input
                id="passphrase"
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                required={selectedPlatform?.requiresPassphrase}
                placeholder={t('enterPassphrasePlaceholder')}
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
              {t('labelOptional')}
            </label>
            <input
              id="label"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('labelPlaceholder')}
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
              {t('syncFrequencyLabel')}
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
                  {f.label}
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
              {t('securityNoticeText')}
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
              ? t('validating')
              : success
                ? t('authorizedSuccess')
                : t('authorizeDataDisplay')}
          </button>
        </form>

        {/* How to Get API Key */}
        <Box style={{ marginTop: tokens.spacing[8] }}>
          <h2 style={{ marginBottom: tokens.spacing[3], fontSize: tokens.typography.fontSize.lg }}>
            {t('howToGetApiKey')}
          </h2>
          <ol style={{ paddingLeft: tokens.spacing[5], lineHeight: 1.8 }}>
            <li>{t('apiStep1')}</li>
            <li>{t('apiStep2')}</li>
            <li>{t('apiStep3')}</li>
            <li>{t('apiStep4')}</li>
            <li>{t('apiStep5')}</li>
          </ol>
        </Box>
      </Box>

      <MobileBottomNav />
    </div>
  )
}
