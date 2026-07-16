'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { tokens, alpha } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import { useToast } from '@/app/components/ui/Toast'
import { useApiCheckout } from '@/lib/hooks/useApiCheckout'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { authedFetch } from '@/lib/api/client'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { formatDateLocalized } from '@/lib/utils/format'
import { SectionCard, getInputStyle } from './shared'
import {
  captureSettingsViewer,
  isSettingsViewerCurrent,
  type SettingsViewerSnapshot,
} from '../hooks/settings-viewer-scope'

interface ApiKey {
  id: string
  name: string
  key: string
  tier: string
  daily_limit: number
  request_count_today: number
  active: boolean
  last_used_at: string | null
  created_at: string
  revoked_at: string | null
}

type ApiKeyStateOwner = Pick<SettingsViewerSnapshot, 'viewerKey' | 'sessionGeneration' | 'userId'>

type ApiKeyLoadOutcome = 'idle' | 'loading' | 'ready' | 'failed'

function apiKeyStateOwnerFor(viewer: SettingsViewerSnapshot): ApiKeyStateOwner {
  return {
    viewerKey: viewer.viewerKey,
    sessionGeneration: viewer.sessionGeneration,
    userId: viewer.userId,
  }
}

function apiKeyStateOwnerMatches(
  owner: ApiKeyStateOwner | null,
  viewer: SettingsViewerSnapshot | null
): boolean {
  return (
    owner !== null &&
    viewer !== null &&
    owner.viewerKey === viewer.viewerKey &&
    owner.sessionGeneration === viewer.sessionGeneration &&
    owner.userId === viewer.userId
  )
}

const TIER_LABELS: Record<string, { labelKey: string; color: string; limitKey: string }> = {
  free: { labelKey: 'free', color: 'var(--color-text-tertiary)', limitKey: 'apiTierLimitFree' },
  starter: {
    labelKey: 'apiTierStarter',
    color: 'var(--color-brand)',
    limitKey: 'apiTierLimitStarter',
  },
  pro: { labelKey: 'pro', color: 'var(--color-accent-success)', limitKey: 'unlimitedLabel' },
}

export function ApiKeysSection() {
  const { t } = useLanguage()
  const { showToast } = useToast()
  // /api/user/api-keys is wrapped in withAuth, which only reads the
  // Authorization Bearer header — these calls 401'd without it.
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const {
    checkout: apiCheckout,
    isLoading: checkoutLoading,
    error: checkoutError,
  } = useApiCheckout()
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [justCreatedKey, setJustCreatedKey] = useState<string | null>(null)
  const [stateOwner, setStateOwner] = useState<ApiKeyStateOwner | null>(null)
  const [loadOutcome, setLoadOutcome] = useState<ApiKeyLoadOutcome>('idle')
  const stateOwnerRef = useRef<ApiKeyStateOwner | null>(null)
  const loadOutcomeRef = useRef<ApiKeyLoadOutcome>('idle')
  const keysLoadGenerationRef = useRef(0)

  const fetchKeys = useCallback(async (expectedScope?: SettingsViewerSnapshot) => {
    const scope = expectedScope ?? captureSettingsViewer(authRef.current)
    if (!scope) {
      if (authRef.current.authChecked && !authRef.current.loading) setLoading(false)
      return
    }
    if (!isSettingsViewerCurrent(scope, authRef.current)) return
    const loadGeneration = ++keysLoadGenerationRef.current
    const loadIsCurrent = () =>
      keysLoadGenerationRef.current === loadGeneration &&
      isSettingsViewerCurrent(scope, authRef.current)

    const owner = apiKeyStateOwnerFor(scope)
    stateOwnerRef.current = owner
    loadOutcomeRef.current = 'loading'
    setStateOwner(owner)
    setLoadOutcome('loading')
    setKeys([])
    setLoading(true)

    try {
      const res = await authedFetch<{ data?: ApiKey[] }>(
        '/api/user/api-keys',
        'GET',
        scope.accessToken,
        undefined,
        15_000,
        {
          expectedUserId: scope.userId,
          expectedSessionGeneration: scope.sessionGeneration,
        }
      )
      if (!loadIsCurrent() || res.stale) return
      if (!res.ok) {
        setKeys([])
        loadOutcomeRef.current = 'failed'
        setLoadOutcome('failed')
        return
      }
      setKeys(res.data?.data ?? [])
      loadOutcomeRef.current = 'ready'
      setLoadOutcome('ready')
    } catch {
      if (!loadIsCurrent()) return
      setKeys([])
      loadOutcomeRef.current = 'failed'
      setLoadOutcome('failed')
    } finally {
      if (loadIsCurrent()) setLoading(false)
    }
  }, [])

  useEffect(() => {
    keysLoadGenerationRef.current += 1
    stateOwnerRef.current = null
    loadOutcomeRef.current = 'idle'
    setStateOwner(null)
    setLoadOutcome('idle')
    setKeys([])
    setLoading(auth.loading || !auth.authChecked || Boolean(auth.userId))
    setCreating(false)
    setNewKeyName('')
    setJustCreatedKey(null)
    if (auth.authChecked && !auth.loading && auth.userId) void fetchKeys()
  }, [auth.authChecked, auth.loading, auth.sessionGeneration, auth.userId, fetchKeys])

  const stateBelongsToViewer = (scope: SettingsViewerSnapshot): boolean =>
    loadOutcomeRef.current === 'ready' &&
    apiKeyStateOwnerMatches(stateOwnerRef.current, scope) &&
    isSettingsViewerCurrent(scope, authRef.current)

  const createKey = async () => {
    const scope = captureSettingsViewer(authRef.current)
    if (!scope || !stateBelongsToViewer(scope) || creating) return
    setCreating(true)
    try {
      const res = await authedFetch<{ data?: { key: string }; error?: string }>(
        '/api/user/api-keys',
        'POST',
        scope.accessToken,
        { name: newKeyName || 'Default' },
        15_000,
        {
          expectedUserId: scope.userId,
          expectedSessionGeneration: scope.sessionGeneration,
        }
      )
      if (!stateBelongsToViewer(scope) || res.stale) return
      if (!res.ok || !res.data?.data) {
        showToast(res.data?.error || t('apiKeyCreateFailed'), 'error')
        return
      }
      setJustCreatedKey(res.data.data.key)
      setNewKeyName('')
      await fetchKeys(scope)
      if (!isSettingsViewerCurrent(scope, authRef.current)) return
      showToast(t('apiKeyCreatedToast'), 'success')
    } finally {
      if (isSettingsViewerCurrent(scope, authRef.current)) setCreating(false)
    }
  }

  const revokeKey = async (id: string) => {
    const scope = captureSettingsViewer(authRef.current)
    if (!scope || !stateBelongsToViewer(scope) || !keys.some((key) => key.id === id && key.active))
      return
    const res = await authedFetch(
      '/api/user/api-keys',
      'PATCH',
      scope.accessToken,
      { id },
      15_000,
      {
        expectedUserId: scope.userId,
        expectedSessionGeneration: scope.sessionGeneration,
      }
    )
    if (!stateBelongsToViewer(scope) || res.stale) return
    if (!res.ok) {
      showToast(t('apiKeyRevokeFailed'), 'error')
      return
    }
    setKeys((prev) =>
      prev.map((k) =>
        k.id === id ? { ...k, active: false, revoked_at: new Date().toISOString() } : k
      )
    )
    showToast(t('apiKeyRevokedToast'), 'success')
  }

  const copyKey = async (key: string) => {
    const scope = captureSettingsViewer(authRef.current)
    if (
      !scope ||
      !stateBelongsToViewer(scope) ||
      (justCreatedKey !== key &&
        !keys.some((candidate) => candidate.active && candidate.key === key))
    ) {
      return
    }

    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(key)
      if (!stateBelongsToViewer(scope)) return
      showToast(t('copiedToClipboard'), 'success')
    } catch {
      if (!stateBelongsToViewer(scope)) return
      showToast(t('copyFailed'), 'error')
    }
  }

  const renderScope = captureSettingsViewer(auth)
  const stateOwnerIsCurrent = apiKeyStateOwnerMatches(stateOwner, renderScope)
  const stateReady = stateOwnerIsCurrent && loadOutcome === 'ready'
  const visibleKeys = stateReady ? keys : []
  const visibleNewKeyName = stateReady ? newKeyName : ''
  const visibleJustCreatedKey = stateReady ? justCreatedKey : null
  const visibleCreating = stateReady && creating
  const activeKeys = visibleKeys.filter((k) => k.active)
  const revokedKeys = visibleKeys.filter((k) => !k.active)
  const displayLoading =
    auth.loading ||
    !auth.authChecked ||
    loading ||
    Boolean(auth.userId && (!stateOwnerIsCurrent || loadOutcome === 'loading'))

  const handleUpgrade = (plan: 'starter' | 'pro') => {
    const scope = captureSettingsViewer(authRef.current)
    if (!scope || !stateBelongsToViewer(scope)) return
    void apiCheckout(plan)
  }

  const dismissCreatedKey = () => {
    const scope = captureSettingsViewer(authRef.current)
    if (!scope || !stateBelongsToViewer(scope)) return
    setJustCreatedKey(null)
  }

  return (
    <SectionCard id="api-keys" title={t('apiKeysSection')} description={t('apiKeysDesc')}>
      {/* Just-created key banner */}
      {visibleJustCreatedKey && (
        <Box
          style={{
            padding: tokens.spacing[4],
            borderRadius: tokens.radius.md,
            background: alpha(tokens.colors.accent.success, 10),
            border: `1px solid ${alpha(tokens.colors.accent.success, 30)}`,
            marginBottom: tokens.spacing[4],
          }}
        >
          <Text
            size="sm"
            weight="bold"
            style={{ marginBottom: tokens.spacing[1], color: 'var(--color-accent-success)' }}
          >
            {t('apiKeyCopyNowWarning')}
          </Text>
          <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
            <code
              style={{
                flex: 1,
                padding: tokens.spacing[2],
                borderRadius: tokens.radius.sm,
                background: 'var(--color-bg-tertiary)',
                fontFamily: tokens.typography.fontFamily.mono.join(', '),
                fontSize: 13,
                wordBreak: 'break-all',
              }}
            >
              {visibleJustCreatedKey}
            </code>
            <Button size="sm" onClick={() => void copyKey(visibleJustCreatedKey)}>
              {t('copy')}
            </Button>
          </div>
          <button
            onClick={dismissCreatedKey}
            style={{
              marginTop: tokens.spacing[2],
              background: 'none',
              border: 'none',
              color: 'var(--color-text-tertiary)',
              cursor: 'pointer',
              fontSize: 12,
              padding: 0,
            }}
          >
            {t('dismiss')}
          </button>
        </Box>
      )}

      {/* Current tier + upgrade */}
      <ApiTierBanner
        currentTier={activeKeys[0]?.tier || 'free'}
        onUpgrade={handleUpgrade}
        isLoading={checkoutLoading || !stateReady}
        error={checkoutError}
      />

      {/* Create new key */}
      <Box style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[4] }}>
        <input
          type="text"
          placeholder={t('apiKeyNamePlaceholder')}
          value={visibleNewKeyName}
          onChange={(e) => {
            const scope = captureSettingsViewer(authRef.current)
            if (!scope || !stateBelongsToViewer(scope)) return
            setNewKeyName(e.target.value)
          }}
          disabled={!stateReady}
          maxLength={50}
          style={{
            ...getInputStyle(),
            flex: 1,
          }}
        />
        <Button
          onClick={createKey}
          disabled={!stateReady || visibleCreating || activeKeys.length >= 5}
          size="sm"
          variant="primary"
        >
          {visibleCreating ? t('apiKeyCreating') : t('apiKeyCreate')}
        </Button>
      </Box>

      {activeKeys.length >= 5 && (
        <Text
          size="xs"
          style={{ color: 'var(--color-accent-warning)', marginBottom: tokens.spacing[3] }}
        >
          {t('apiKeyMaxReached')}
        </Text>
      )}

      {/* Key list */}
      {displayLoading ? (
        <Text size="sm" style={{ color: 'var(--color-text-tertiary)' }}>
          {t('loading')}
        </Text>
      ) : activeKeys.length === 0 && revokedKeys.length === 0 ? (
        <Text size="sm" style={{ color: 'var(--color-text-tertiary)' }}>
          {t('apiKeyEmpty')}
        </Text>
      ) : (
        <>
          {activeKeys.map((k) => (
            <KeyRow key={k.id} apiKey={k} onRevoke={revokeKey} onCopy={copyKey} />
          ))}
          {revokedKeys.length > 0 && (
            <div style={{ marginTop: tokens.spacing[4] }}>
              <Text
                size="xs"
                weight="bold"
                style={{ color: 'var(--color-text-tertiary)', marginBottom: tokens.spacing[2] }}
              >
                {t('apiKeyRevokedSection')}
              </Text>
              {revokedKeys.map((k) => (
                <KeyRow key={k.id} apiKey={k} onRevoke={revokeKey} onCopy={copyKey} />
              ))}
            </div>
          )}
        </>
      )}

      {/* Usage chart */}
      {activeKeys.length > 0 && <UsageChart />}

      {/* Link to docs */}
      <div
        style={{
          marginTop: tokens.spacing[4],
          paddingTop: tokens.spacing[3],
          borderTop: '1px solid var(--color-border-primary)',
        }}
      >
        <a
          href="/api-docs"
          style={{
            fontSize: 13,
            color: 'var(--color-brand)',
            textDecoration: 'none',
          }}
        >
          {t('apiKeyViewDocs')} →
        </a>
      </div>
    </SectionCard>
  )
}

type UsageData = {
  keys: { id: string; name: string }[]
  daily: { api_key_id: string; date: string; request_count: number }[]
  totals: Record<string, number>
}

function UsageChart() {
  const { t } = useLanguage()
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const [usage, setUsage] = useState<UsageData | null>(null)

  useEffect(() => {
    setUsage(null)
    const scope = captureSettingsViewer(authRef.current)
    if (!scope) return
    let cancelled = false

    void (async () => {
      try {
        const res = await authedFetch<{ data?: UsageData }>(
          '/api/user/api-keys/usage?days=30',
          'GET',
          scope.accessToken,
          undefined,
          15_000,
          {
            expectedUserId: scope.userId,
            expectedSessionGeneration: scope.sessionGeneration,
          }
        )
        if (cancelled || res.stale || !isSettingsViewerCurrent(scope, authRef.current) || !res.ok)
          return
        setUsage(res.data?.data ?? null)
      } catch {
        // Usage history is supplementary; identity-bound failure stays empty.
      }
    })()

    return () => {
      cancelled = true
    }
  }, [auth.authChecked, auth.loading, auth.sessionGeneration, auth.userId])

  if (!usage || usage.daily.length === 0) {
    return (
      <div
        style={{
          marginTop: tokens.spacing[4],
          paddingTop: tokens.spacing[3],
          borderTop: '1px solid var(--color-border-primary)',
        }}
      >
        <Text
          size="xs"
          weight="bold"
          style={{ color: 'var(--color-text-tertiary)', marginBottom: tokens.spacing[2] }}
        >
          {t('apiKeyUsage30d')}
        </Text>
        <Text size="xs" style={{ color: 'var(--color-text-tertiary)' }}>
          {t('apiKeyNoUsage')}
        </Text>
      </div>
    )
  }

  // Aggregate daily totals across all keys
  const dailyTotals: Record<string, number> = {}
  for (const row of usage.daily) {
    dailyTotals[row.date] = (dailyTotals[row.date] || 0) + row.request_count
  }

  // Fill in missing days with 0
  const dates: string[] = []
  const now = new Date()
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    dates.push(d.toISOString().slice(0, 10))
  }

  const values = dates.map((d) => dailyTotals[d] || 0)
  const maxVal = Math.max(...values, 1)
  const totalRequests = values.reduce((a, b) => a + b, 0)

  return (
    <div
      style={{
        marginTop: tokens.spacing[4],
        paddingTop: tokens.spacing[3],
        borderTop: '1px solid var(--color-border-primary)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: tokens.spacing[3],
        }}
      >
        <Text size="xs" weight="bold" style={{ color: 'var(--color-text-tertiary)' }}>
          {t('apiKeyUsage30d')}
        </Text>
        <Text size="xs" style={{ color: 'var(--color-text-secondary)' }}>
          {totalRequests.toLocaleString()} {t('apiKeyTotalRequests')}
        </Text>
      </div>

      {/* Bar chart */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 2,
          height: 60,
          padding: `0 ${tokens.spacing[1]}`,
        }}
      >
        {values.map((v, i) => (
          <div
            key={dates[i]}
            title={`${dates[i]}: ${v} ${t('apiKeyRequests')}`}
            style={{
              flex: 1,
              height: Math.max((v / maxVal) * 56, v > 0 ? 2 : 0),
              background: v > 0 ? 'var(--color-brand)' : 'var(--color-bg-tertiary)',
              borderRadius: 2,
              transition: 'height 0.2s ease',
            }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
        <Text size="xs" style={{ color: 'var(--color-text-tertiary)', fontSize: 10 }}>
          {dates[0]}
        </Text>
        <Text size="xs" style={{ color: 'var(--color-text-tertiary)', fontSize: 10 }}>
          {t('today')}
        </Text>
      </div>

      {/* Per-key breakdown */}
      {usage.keys.length > 1 && (
        <div style={{ marginTop: tokens.spacing[3] }}>
          {usage.keys.map((k) => (
            <div
              key={k.id}
              style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}
            >
              <Text size="xs" style={{ color: 'var(--color-text-secondary)' }}>
                {k.name}
              </Text>
              <Text
                size="xs"
                style={{
                  color: 'var(--color-text-tertiary)',
                  fontFamily: tokens.typography.fontFamily.mono.join(', '),
                }}
              >
                {(usage.totals[k.id] || 0).toLocaleString()}
              </Text>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ApiTierBanner({
  currentTier,
  onUpgrade,
  isLoading,
  error,
}: {
  currentTier: string
  onUpgrade: (plan: 'starter' | 'pro') => void
  isLoading: boolean
  error: string | null
}) {
  const { t } = useLanguage()
  const tier = TIER_LABELS[currentTier] || TIER_LABELS.free

  return (
    <Box
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: tokens.spacing[3],
        borderRadius: tokens.radius.md,
        background: 'var(--color-bg-tertiary)',
        marginBottom: tokens.spacing[4],
      }}
    >
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <Text size="sm" weight="bold">
            {t('apiPlanLabel')}
          </Text>
          <span
            style={{
              padding: '2px 8px',
              borderRadius: tokens.radius.sm,
              background: `${alpha(tier.color, 13)}`,
              color: tier.color,
              fontSize: 12,
              fontWeight: tokens.typography.fontWeight.bold,
            }}
          >
            {t(tier.labelKey)}
          </span>
          <Text size="xs" style={{ color: 'var(--color-text-tertiary)' }}>
            {t(tier.limitKey)}
          </Text>
        </div>
        {error && (
          <Text size="xs" style={{ color: 'var(--color-accent-danger)', marginTop: 4 }}>
            {error}
          </Text>
        )}
      </div>
      {currentTier !== 'pro' && (
        <div style={{ display: 'flex', gap: tokens.spacing[2] }}>
          {currentTier === 'free' && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => onUpgrade('starter')}
              disabled={isLoading}
            >
              {isLoading ? t('loading') : t('apiUpgradeStarter')}
            </Button>
          )}
          <Button
            size="sm"
            variant={currentTier === 'free' ? 'ghost' : 'primary'}
            onClick={() => onUpgrade('pro')}
            disabled={isLoading}
          >
            {isLoading ? t('loading') : t('upgradeToPro')}
          </Button>
        </div>
      )}
    </Box>
  )
}

function KeyRow({
  apiKey,
  onRevoke,
  onCopy,
}: {
  apiKey: ApiKey
  onRevoke: (id: string) => void
  onCopy: (key: string) => void
}) {
  const { t, language } = useLanguage()
  const created = formatDateLocalized(apiKey.created_at, language)
  const lastUsed = apiKey.last_used_at
    ? formatDateLocalized(apiKey.last_used_at, language)
    : t('apiKeyNever')

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[3],
        padding: `${tokens.spacing[3]} 0`,
        borderBottom: '1px solid var(--color-border-primary)',
        opacity: apiKey.active ? 1 : 0.5,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <Text size="sm" weight="bold" style={{ whiteSpace: 'nowrap' }}>
            {apiKey.name}
          </Text>
          <code
            style={{
              fontSize: 12,
              fontFamily: tokens.typography.fontFamily.mono.join(', '),
              color: 'var(--color-text-tertiary)',
            }}
          >
            {apiKey.key}
          </code>
        </div>
        <div style={{ display: 'flex', gap: tokens.spacing[3], marginTop: 2 }}>
          <Text size="xs" style={{ color: 'var(--color-text-tertiary)' }}>
            {t('apiKeyCreatedLabel')} {created}
          </Text>
          <Text size="xs" style={{ color: 'var(--color-text-tertiary)' }}>
            {t('apiKeyLastUsed')}: {lastUsed}
          </Text>
          {apiKey.active && (
            <Text size="xs" style={{ color: 'var(--color-text-tertiary)' }}>
              {apiKey.request_count_today}/{apiKey.daily_limit === 0 ? '∞' : apiKey.daily_limit}{' '}
              {t('apiKeyTodaySuffix')}
            </Text>
          )}
        </div>
      </div>

      {apiKey.active && (
        <div style={{ display: 'flex', gap: tokens.spacing[2], flexShrink: 0 }}>
          <Button size="sm" variant="ghost" onClick={() => onCopy(apiKey.key)}>
            {t('copy')}
          </Button>
          <Button size="sm" variant="danger" onClick={() => onRevoke(apiKey.id)}>
            {t('revoke')}
          </Button>
        </div>
      )}
    </div>
  )
}
