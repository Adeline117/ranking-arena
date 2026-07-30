'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { tokens, alpha } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import { useToast } from '@/app/components/ui/Toast'
import { useApiCheckout } from '@/lib/hooks/useApiCheckout'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { authedFetch } from '@/lib/api/client'
import { isTrustedStripeBillingPortalUrl } from '@/lib/stripe/hosted-url'
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
type ApiTier = 'free' | 'starter' | 'pro'
type ApiEntitlement = {
  tier: ApiTier
  hasStripeSubscription: boolean
}

type ApiPortalFlow = 'payment_method_update' | 'subscription_cancel'

type ApiPortalOperation = {
  id: number
  viewer: SettingsViewerSnapshot
  controller: AbortController
}

type ApiKeysSectionProps = {
  /** Test seam for the irreversible browser navigation to Stripe Portal. */
  redirectToPortal?: (url: string) => void
}

function defaultPortalRedirect(url: string): void {
  window.location.href = url
}

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

const FULL_API_KEY_PATTERN = /^arena_sk_[0-9a-f]{32}$/
const MASKED_API_KEY_PATTERN = /^arena_s\.\.\.[0-9a-f]{4}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const API_KEY_LIST_FIELDS = [
  'active',
  'created_at',
  'daily_limit',
  'id',
  'key',
  'last_used_at',
  'name',
  'request_count_today',
  'revoked_at',
  'tier',
].sort()
const API_KEY_LIMITS: Record<ApiTier, number> = { free: 100, starter: 10_000, pro: 0 }

function timestampOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)))
}

function parseListedApiKey(value: unknown): ApiKey | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const fields = Object.keys(row).sort()
  if (
    fields.length !== API_KEY_LIST_FIELDS.length ||
    !fields.every((field, index) => field === API_KEY_LIST_FIELDS[index])
  ) {
    return null
  }

  const tier = row.tier
  if (tier !== 'free' && tier !== 'starter' && tier !== 'pro') return null
  if (
    typeof row.id !== 'string' ||
    !UUID_PATTERN.test(row.id) ||
    typeof row.name !== 'string' ||
    row.name !== row.name.trim() ||
    row.name.length < 1 ||
    row.name.length > 50 ||
    typeof row.key !== 'string' ||
    !MASKED_API_KEY_PATTERN.test(row.key) ||
    row.daily_limit !== API_KEY_LIMITS[tier] ||
    typeof row.request_count_today !== 'number' ||
    !Number.isSafeInteger(row.request_count_today) ||
    row.request_count_today < 0 ||
    typeof row.active !== 'boolean' ||
    !timestampOrNull(row.last_used_at) ||
    typeof row.created_at !== 'string' ||
    !Number.isFinite(Date.parse(row.created_at)) ||
    !timestampOrNull(row.revoked_at)
  ) {
    return null
  }

  return {
    id: row.id,
    name: row.name,
    key: row.key,
    tier,
    daily_limit: row.daily_limit,
    request_count_today: row.request_count_today,
    active: row.active,
    last_used_at: row.last_used_at,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
  }
}

function parseApiKeyListPayload(
  value: unknown
): { keys: ApiKey[]; entitlement: ApiEntitlement } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const payload = value as Record<string, unknown>
  const payloadFields = Object.keys(payload).sort()
  if (
    payloadFields.length !== 2 ||
    payloadFields[0] !== 'data' ||
    payloadFields[1] !== 'entitlement' ||
    !Array.isArray(payload.data) ||
    !payload.entitlement ||
    typeof payload.entitlement !== 'object' ||
    Array.isArray(payload.entitlement)
  ) {
    return null
  }

  const entitlement = payload.entitlement as Record<string, unknown>
  const entitlementFields = Object.keys(entitlement).sort()
  const tier = entitlement.tier
  if (
    entitlementFields.length !== 2 ||
    entitlementFields[0] !== 'hasStripeSubscription' ||
    entitlementFields[1] !== 'tier' ||
    (tier !== 'free' && tier !== 'starter' && tier !== 'pro') ||
    typeof entitlement.hasStripeSubscription !== 'boolean' ||
    (tier === 'free' && entitlement.hasStripeSubscription)
  ) {
    return null
  }

  const keys: ApiKey[] = []
  for (const value of payload.data) {
    const key = parseListedApiKey(value)
    if (!key) return null
    keys.push(key)
  }
  return {
    keys,
    entitlement: {
      tier,
      hasStripeSubscription: entitlement.hasStripeSubscription,
    },
  }
}

export function ApiKeysSection({
  redirectToPortal = defaultPortalRedirect,
}: ApiKeysSectionProps = {}) {
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
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [newKeyName, setNewKeyName] = useState('')
  const [justCreatedKey, setJustCreatedKey] = useState<string | null>(null)
  const [entitlement, setEntitlement] = useState<ApiEntitlement | null>(null)
  const [portalFlow, setPortalFlow] = useState<ApiPortalFlow | null>(null)
  const [stateOwner, setStateOwner] = useState<ApiKeyStateOwner | null>(null)
  const [loadOutcome, setLoadOutcome] = useState<ApiKeyLoadOutcome>('idle')
  const stateOwnerRef = useRef<ApiKeyStateOwner | null>(null)
  const loadOutcomeRef = useRef<ApiKeyLoadOutcome>('idle')
  const keysLoadGenerationRef = useRef(0)
  const keyMutationRef = useRef<'create' | string | null>(null)
  const mountedRef = useRef(false)
  const portalOperationRef = useRef<ApiPortalOperation | null>(null)
  const nextPortalOperationIdRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      keyMutationRef.current = null
      portalOperationRef.current?.controller.abort()
      portalOperationRef.current = null
    }
  }, [])

  const fetchKeys = useCallback(
    async (
      expectedScope?: SettingsViewerSnapshot,
      options?: { preserveReadyState?: boolean }
    ): Promise<boolean> => {
      const scope = expectedScope ?? captureSettingsViewer(authRef.current)
      if (!scope) {
        if (authRef.current.authChecked && !authRef.current.loading) setLoading(false)
        return false
      }
      if (!isSettingsViewerCurrent(scope, authRef.current)) return false
      const preserveReadyState =
        options?.preserveReadyState === true &&
        mountedRef.current &&
        loadOutcomeRef.current === 'ready' &&
        apiKeyStateOwnerMatches(stateOwnerRef.current, scope)
      const loadGeneration = ++keysLoadGenerationRef.current
      const loadIsCurrent = () =>
        keysLoadGenerationRef.current === loadGeneration &&
        isSettingsViewerCurrent(scope, authRef.current)

      if (!preserveReadyState) {
        const owner = apiKeyStateOwnerFor(scope)
        stateOwnerRef.current = owner
        loadOutcomeRef.current = 'loading'
        setStateOwner(owner)
        setLoadOutcome('loading')
        setKeys([])
        setLoading(true)
      }

      try {
        const res = await authedFetch<{
          data?: ApiKey[]
          entitlement?: {
            tier?: unknown
            hasStripeSubscription?: unknown
          }
        }>('/api/user/api-keys', 'GET', scope.accessToken, undefined, 15_000, {
          expectedUserId: scope.userId,
          expectedSessionGeneration: scope.sessionGeneration,
        })
        if (!loadIsCurrent() || res.stale) return false
        const parsed = res.ok ? parseApiKeyListPayload(res.data) : null
        if (!parsed) {
          if (!preserveReadyState) {
            setKeys([])
            setEntitlement(null)
            loadOutcomeRef.current = 'failed'
            setLoadOutcome('failed')
          }
          return false
        }
        setKeys(parsed.keys)
        setEntitlement(parsed.entitlement)
        loadOutcomeRef.current = 'ready'
        setLoadOutcome('ready')
        return true
      } catch {
        if (!loadIsCurrent()) return false
        if (!preserveReadyState) {
          setKeys([])
          setEntitlement(null)
          loadOutcomeRef.current = 'failed'
          setLoadOutcome('failed')
        }
        return false
      } finally {
        if (loadIsCurrent() && !preserveReadyState) setLoading(false)
      }
    },
    []
  )

  useEffect(() => {
    const portalOperation = portalOperationRef.current
    if (portalOperation && !isSettingsViewerCurrent(portalOperation.viewer, authRef.current)) {
      portalOperation.controller.abort()
      portalOperationRef.current = null
    }
    keysLoadGenerationRef.current += 1
    stateOwnerRef.current = null
    loadOutcomeRef.current = 'idle'
    setStateOwner(null)
    setLoadOutcome('idle')
    setKeys([])
    setEntitlement(null)
    setLoading(auth.loading || !auth.authChecked || Boolean(auth.userId))
    setCreating(false)
    setRevokingId(null)
    keyMutationRef.current = null
    setNewKeyName('')
    setJustCreatedKey(null)
    setPortalFlow(null)
    if (auth.authChecked && !auth.loading && auth.userId) void fetchKeys()
  }, [auth.authChecked, auth.loading, auth.sessionGeneration, auth.userId, fetchKeys])

  const stateBelongsToViewer = (scope: SettingsViewerSnapshot): boolean =>
    mountedRef.current &&
    loadOutcomeRef.current === 'ready' &&
    apiKeyStateOwnerMatches(stateOwnerRef.current, scope) &&
    isSettingsViewerCurrent(scope, authRef.current)

  const createKey = async () => {
    const scope = captureSettingsViewer(authRef.current)
    if (!scope || !stateBelongsToViewer(scope) || creating || keyMutationRef.current !== null)
      return
    keyMutationRef.current = 'create'
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
      const createdKey = res.data?.data?.key
      if (
        !res.ok ||
        res.status !== 201 ||
        typeof createdKey !== 'string' ||
        !FULL_API_KEY_PATTERN.test(createdKey)
      ) {
        showToast(res.data?.error || t('apiKeyCreateFailed'), 'error')
        return
      }
      setJustCreatedKey(createdKey)
      setNewKeyName('')
      const refreshed = await fetchKeys(scope, { preserveReadyState: true })
      if (!isSettingsViewerCurrent(scope, authRef.current)) return
      showToast(t('apiKeyCreatedToast'), 'success')
      if (!refreshed) showToast(t('loadFailedRetryShort'), 'warning')
    } catch {
      if (stateBelongsToViewer(scope)) {
        showToast(t('networkError'), 'error')
      }
    } finally {
      if (isSettingsViewerCurrent(scope, authRef.current) && keyMutationRef.current === 'create') {
        keyMutationRef.current = null
        setCreating(false)
      }
    }
  }

  const revokeKey = async (id: string) => {
    const scope = captureSettingsViewer(authRef.current)
    if (
      !scope ||
      !stateBelongsToViewer(scope) ||
      revokingId !== null ||
      keyMutationRef.current !== null ||
      !keys.some((key) => key.id === id && key.active)
    )
      return
    keyMutationRef.current = id
    setRevokingId(id)
    try {
      const res = await authedFetch<{
        success?: unknown
        data?: { id?: unknown; active?: unknown; revoked_at?: unknown }
      }>('/api/user/api-keys', 'PATCH', scope.accessToken, { id }, 15_000, {
        expectedUserId: scope.userId,
        expectedSessionGeneration: scope.sessionGeneration,
      })
      if (!stateBelongsToViewer(scope) || res.stale) return
      const acknowledgement = res.data?.data
      const acknowledgedRevokedAt = acknowledgement?.revoked_at
      if (
        !res.ok ||
        res.data?.success !== true ||
        acknowledgement?.id !== id ||
        acknowledgement.active !== false ||
        typeof acknowledgedRevokedAt !== 'string' ||
        !Number.isFinite(Date.parse(acknowledgedRevokedAt))
      ) {
        showToast(t('apiKeyRevokeFailed'), 'error')
        return
      }
      setKeys((prev) =>
        prev.map((k) =>
          k.id === id ? { ...k, active: false, revoked_at: acknowledgedRevokedAt } : k
        )
      )
      showToast(t('apiKeyRevokedToast'), 'success')
    } catch {
      if (stateBelongsToViewer(scope)) {
        showToast(t('networkError'), 'error')
      }
    } finally {
      if (isSettingsViewerCurrent(scope, authRef.current) && keyMutationRef.current === id) {
        keyMutationRef.current = null
        setRevokingId(null)
      }
    }
  }

  const copyKey = async (key: string) => {
    const scope = captureSettingsViewer(authRef.current)
    if (!scope || !stateBelongsToViewer(scope) || justCreatedKey !== key) {
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
  const loadFailed = stateOwnerIsCurrent && loadOutcome === 'failed'
  const visibleKeys = stateReady ? keys : []
  const visibleNewKeyName = stateReady ? newKeyName : ''
  const visibleJustCreatedKey = stateReady ? justCreatedKey : null
  const visibleCreating = stateReady && creating
  const visibleRevokingId = stateReady ? revokingId : null
  const visibleEntitlement = stateReady ? entitlement : null
  const visiblePortalFlow = stateReady ? portalFlow : null
  const activeKeys = visibleKeys.filter((k) => k.active)
  const revokedKeys = visibleKeys.filter((k) => !k.active)
  const displayLoading =
    auth.loading ||
    !auth.authChecked ||
    loading ||
    Boolean(auth.userId && (!stateOwnerIsCurrent || loadOutcome === 'loading'))

  const handleUpgrade = (plan: 'starter' | 'pro', scope: SettingsViewerSnapshot) => {
    if (!stateBelongsToViewer(scope)) return
    void apiCheckout(plan)
  }

  const openApiPortal = async (
    flow: ApiPortalFlow,
    scope: SettingsViewerSnapshot,
    hasStripeSubscription: boolean
  ) => {
    if (!stateBelongsToViewer(scope) || !hasStripeSubscription) {
      return
    }

    const activeOperation = portalOperationRef.current
    if (activeOperation && isSettingsViewerCurrent(activeOperation.viewer, authRef.current)) return
    activeOperation?.controller.abort()

    const operation: ApiPortalOperation = {
      id: ++nextPortalOperationIdRef.current,
      viewer: scope,
      controller: new AbortController(),
    }
    portalOperationRef.current = operation
    setPortalFlow(flow)
    const operationIsCurrent = () =>
      portalOperationRef.current?.id === operation.id && stateBelongsToViewer(scope)

    let navigating = false
    try {
      const res = await authedFetch<{ url?: unknown; error?: unknown }>(
        '/api/stripe/portal',
        'POST',
        scope.accessToken,
        { flow, scope: 'api' },
        15_000,
        {
          expectedUserId: scope.userId,
          expectedSessionGeneration: scope.sessionGeneration,
          signal: operation.controller.signal,
        }
      )
      if (!operationIsCurrent() || res.stale) return
      if (res.ok && isTrustedStripeBillingPortalUrl(res.data?.url)) {
        // Last CAS immediately before the irreversible browser navigation.
        if (!operationIsCurrent()) return
        navigating = true
        redirectToPortal(res.data.url)
        return
      }
      showToast(t('paymentSystemComingSoon'), 'error')
    } catch {
      if (operationIsCurrent()) {
        showToast(t('operationFailedTryAgain'), 'error')
      }
    } finally {
      if (!navigating && operationIsCurrent()) {
        setPortalFlow(null)
        portalOperationRef.current = null
      }
    }
  }

  const dismissCreatedKey = () => {
    const scope = captureSettingsViewer(authRef.current)
    if (!scope || !stateBelongsToViewer(scope)) return
    setJustCreatedKey(null)
  }

  if (loadFailed) {
    return (
      <SectionCard id="api-keys" title={t('apiKeysSection')} description={t('apiKeysDesc')}>
        <Box
          className="api-key-load-error"
          role="alert"
          style={{
            padding: tokens.spacing[4],
            borderRadius: tokens.radius.md,
            border: `1px solid ${alpha(tokens.colors.accent.error, 20)}`,
            background: alpha(tokens.colors.accent.error, 5),
          }}
        >
          <Text size="sm" style={{ color: tokens.colors.accent.error }}>
            {t('loadFailedRetryShort')}
          </Text>
          <Button
            className="api-key-load-retry"
            size="sm"
            variant="secondary"
            onClick={() => {
              const scope = captureSettingsViewer(authRef.current)
              if (scope) void fetchKeys(scope)
            }}
          >
            {t('retry')}
          </Button>
        </Box>
      </SectionCard>
    )
  }

  return (
    <SectionCard id="api-keys" title={t('apiKeysSection')} description={t('apiKeysDesc')}>
      {/* Just-created key banner */}
      {visibleJustCreatedKey && (
        <Box
          className="api-created-key-banner"
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
          <div className="api-created-key-secret">
            <code
              className="api-created-key-code"
              style={{
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
            <Button
              className="api-created-key-copy"
              size="sm"
              onClick={() => void copyKey(visibleJustCreatedKey)}
            >
              {t('copy')}
            </Button>
          </div>
          <button
            className="api-created-key-dismiss"
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
        currentTier={visibleEntitlement?.tier || activeKeys[0]?.tier || 'free'}
        hasStripeSubscription={visibleEntitlement?.hasStripeSubscription === true}
        onUpgrade={(plan) => {
          if (renderScope) handleUpgrade(plan, renderScope)
        }}
        onOpenPortal={(flow) => {
          if (renderScope) {
            void openApiPortal(
              flow,
              renderScope,
              visibleEntitlement?.hasStripeSubscription === true
            )
          }
        }}
        isLoading={checkoutLoading || visiblePortalFlow !== null || !stateReady}
        error={checkoutError}
      />

      {/* Create new key */}
      <Box className="api-key-create-row" style={{ marginBottom: tokens.spacing[4] }}>
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
          className="api-key-create-button"
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
            <KeyRow
              key={k.id}
              apiKey={k}
              onRevoke={revokeKey}
              isRevoking={visibleRevokingId === k.id}
            />
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
                <KeyRow key={k.id} apiKey={k} onRevoke={revokeKey} isRevoking={false} />
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

type UsageLoadOutcome = 'loading' | 'ready' | 'failed'
const USAGE_KEY_FIELDS = ['id', 'name']
const USAGE_DAILY_FIELDS = ['api_key_id', 'date', 'request_count']
const USAGE_DATA_FIELDS = ['daily', 'keys', 'totals']
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 24 * 60 * 60 * 1000

function isExactDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function exactFields(value: Record<string, unknown>, expected: string[]): boolean {
  const fields = Object.keys(value).sort()
  return (
    fields.length === expected.length && fields.every((field, index) => field === expected[index])
  )
}

function parseUsagePayload(value: unknown): UsageData | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const payload = value as Record<string, unknown>
  if (!exactFields(payload, ['data'])) return null
  if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) return null
  const data = payload.data as Record<string, unknown>
  if (
    !exactFields(data, USAGE_DATA_FIELDS) ||
    !Array.isArray(data.keys) ||
    !Array.isArray(data.daily) ||
    !data.totals ||
    typeof data.totals !== 'object' ||
    Array.isArray(data.totals)
  ) {
    return null
  }

  const keys: UsageData['keys'] = []
  const keyIds = new Set<string>()
  for (const value of data.keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const key = value as Record<string, unknown>
    if (
      !exactFields(key, USAGE_KEY_FIELDS) ||
      typeof key.id !== 'string' ||
      !UUID_PATTERN.test(key.id) ||
      keyIds.has(key.id) ||
      typeof key.name !== 'string' ||
      key.name !== key.name.trim() ||
      key.name.length < 1 ||
      key.name.length > 50
    ) {
      return null
    }
    keyIds.add(key.id)
    keys.push({ id: key.id, name: key.name })
  }

  const today = new Date().toISOString().slice(0, 10)
  const since = new Date(new Date(`${today}T00:00:00.000Z`).getTime() - 29 * DAY_MS)
    .toISOString()
    .slice(0, 10)
  const daily: UsageData['daily'] = []
  const dailyIdentities = new Set<string>()
  const expectedTotals: Record<string, number> = {}
  for (const value of data.daily) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const row = value as Record<string, unknown>
    const identity = `${String(row.api_key_id)}\u0000${String(row.date)}`
    if (
      !exactFields(row, USAGE_DAILY_FIELDS) ||
      typeof row.api_key_id !== 'string' ||
      !keyIds.has(row.api_key_id) ||
      !isExactDate(row.date) ||
      row.date < since ||
      row.date > today ||
      typeof row.request_count !== 'number' ||
      !Number.isSafeInteger(row.request_count) ||
      row.request_count < 0 ||
      dailyIdentities.has(identity)
    ) {
      return null
    }
    const total = (expectedTotals[row.api_key_id] || 0) + row.request_count
    if (!Number.isSafeInteger(total)) return null
    expectedTotals[row.api_key_id] = total
    dailyIdentities.add(identity)
    daily.push({
      api_key_id: row.api_key_id,
      date: row.date,
      request_count: row.request_count,
    })
  }

  const rawTotals = data.totals as Record<string, unknown>
  const totalIds = Object.keys(rawTotals).sort()
  const expectedTotalIds = Object.keys(expectedTotals).sort()
  if (
    totalIds.length !== expectedTotalIds.length ||
    !totalIds.every((id, index) => id === expectedTotalIds[index]) ||
    totalIds.some((id) => rawTotals[id] !== expectedTotals[id])
  ) {
    return null
  }

  return { keys, daily, totals: expectedTotals }
}

function UsageChart() {
  const { t } = useLanguage()
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const [usage, setUsage] = useState<UsageData | null>(null)
  const [loadOutcome, setLoadOutcome] = useState<UsageLoadOutcome>('loading')
  const [retryGeneration, setRetryGeneration] = useState(0)

  useEffect(() => {
    setUsage(null)
    setLoadOutcome('loading')
    const scope = captureSettingsViewer(authRef.current)
    if (!scope) {
      setLoadOutcome('failed')
      return
    }
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
        if (cancelled || res.stale || !isSettingsViewerCurrent(scope, authRef.current)) return
        const parsed = res.ok ? parseUsagePayload(res.data) : null
        if (!parsed) {
          setLoadOutcome('failed')
          return
        }
        setUsage(parsed)
        setLoadOutcome('ready')
      } catch {
        if (!cancelled && isSettingsViewerCurrent(scope, authRef.current)) {
          setLoadOutcome('failed')
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [auth.authChecked, auth.loading, auth.sessionGeneration, auth.userId, retryGeneration])

  if (loadOutcome !== 'ready') {
    return (
      <div
        role={loadOutcome === 'failed' ? 'alert' : undefined}
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
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <Text size="xs" style={{ color: 'var(--color-text-tertiary)' }}>
            {loadOutcome === 'loading' ? t('loading') : t('loadFailedRetryShort')}
          </Text>
          {loadOutcome === 'failed' && (
            <Button size="sm" variant="secondary" onClick={() => setRetryGeneration((v) => v + 1)}>
              {t('retry')}
            </Button>
          )}
        </div>
      </div>
    )
  }

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
  hasStripeSubscription,
  onUpgrade,
  onOpenPortal,
  isLoading,
  error,
}: {
  currentTier: string
  hasStripeSubscription: boolean
  onUpgrade: (plan: 'starter' | 'pro') => void
  onOpenPortal: (flow: 'payment_method_update' | 'subscription_cancel') => void
  isLoading: boolean
  error: string | null
}) {
  const { t } = useLanguage()
  const tier = TIER_LABELS[currentTier] || TIER_LABELS.free

  return (
    <Box
      className="api-tier-banner"
      style={{
        padding: tokens.spacing[3],
        borderRadius: tokens.radius.md,
        background: 'var(--color-bg-tertiary)',
        marginBottom: tokens.spacing[4],
      }}
    >
      <div className="api-tier-banner-summary">
        <div className="api-tier-banner-meta">
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
          <Text
            className="api-tier-banner-limit"
            size="xs"
            style={{ color: 'var(--color-text-tertiary)' }}
          >
            {t(tier.limitKey)}
          </Text>
        </div>
        {error && (
          <Text size="xs" style={{ color: 'var(--color-accent-danger)', marginTop: 4 }}>
            {error}
          </Text>
        )}
      </div>
      {currentTier === 'free' && (
        <div className="api-tier-banner-actions">
          <Button
            size="sm"
            variant="primary"
            onClick={() => onUpgrade('starter')}
            disabled={isLoading}
          >
            {isLoading ? t('loading') : t('apiUpgradeStarter')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onUpgrade('pro')} disabled={isLoading}>
            {isLoading ? t('loading') : t('upgradeToPro')}
          </Button>
        </div>
      )}
      {currentTier !== 'free' && hasStripeSubscription && (
        <div className="api-tier-banner-actions">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onOpenPortal('payment_method_update')}
            disabled={isLoading}
          >
            {t('paymentMethods')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => onOpenPortal('subscription_cancel')}
            disabled={isLoading}
          >
            {t('cancelSubscription')}
          </Button>
        </div>
      )}
    </Box>
  )
}

function KeyRow({
  apiKey,
  onRevoke,
  isRevoking,
}: {
  apiKey: ApiKey
  onRevoke: (id: string) => void
  isRevoking: boolean
}) {
  const { t, language } = useLanguage()
  const created = formatDateLocalized(apiKey.created_at, language)
  const lastUsed = apiKey.last_used_at
    ? formatDateLocalized(apiKey.last_used_at, language)
    : t('apiKeyNever')

  return (
    <div
      className="api-key-row"
      style={{
        borderBottom: '1px solid var(--color-border-primary)',
        opacity: apiKey.active ? 1 : 0.5,
      }}
    >
      <div className="api-key-row-main">
        <div className="api-key-row-identity">
          <Text className="api-key-row-name" size="sm" weight="bold">
            {apiKey.name}
          </Text>
          <code
            className="api-key-row-code"
            style={{
              fontSize: 12,
              fontFamily: tokens.typography.fontFamily.mono.join(', '),
              color: 'var(--color-text-tertiary)',
            }}
          >
            {apiKey.key}
          </code>
        </div>
        <div className="api-key-row-metadata">
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
        <div className="api-key-row-actions">
          <Button
            size="sm"
            variant="danger"
            disabled={isRevoking}
            onClick={() => onRevoke(apiKey.id)}
          >
            {isRevoking ? t('loading') : t('revoke')}
          </Button>
        </div>
      )}
    </div>
  )
}
