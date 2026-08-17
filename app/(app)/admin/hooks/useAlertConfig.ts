'use client'

import { useCallback, useEffect, useRef } from 'react'
import { getCsrfHeaders } from '@/lib/api/client'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { logger } from '@/lib/logger'
import { useViewerOwnedState } from '@/lib/state/viewer-owned-state'

type ToastFn = (message: string, type: 'success' | 'error' | 'warning' | 'info') => void

export interface AlertConfigItem {
  value: string | null
  enabled: boolean
}

export interface AlertConfig {
  slack_webhook_url?: AlertConfigItem
  feishu_webhook_url?: AlertConfigItem
  alert_email?: AlertConfigItem
}

type AlertConfigResponse = {
  ok: true
  config: AlertConfig
}

function emptyConfig(): AlertConfig {
  return {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAlertConfigItem(value: unknown): value is AlertConfigItem {
  return (
    isRecord(value) &&
    (value.value === null || typeof value.value === 'string') &&
    typeof value.enabled === 'boolean'
  )
}

function parseAlertConfigResponse(value: unknown): AlertConfigResponse | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.config)) return null

  const config: AlertConfig = {}
  const keys = Object.keys(value.config)
  for (const key of keys) {
    if (key !== 'slack_webhook_url' && key !== 'feishu_webhook_url' && key !== 'alert_email') {
      return null
    }

    const item = value.config[key]
    if (!isAlertConfigItem(item)) return null
    config[key] = item
  }

  return { ok: true, config }
}

function extractErrorMessage(value: unknown): string | null {
  if (!isRecord(value)) return null
  if (typeof value.error === 'string' && value.error) return value.error
  if (isRecord(value.error) && typeof value.error.message === 'string' && value.error.message) {
    return value.error.message
  }
  return typeof value.message === 'string' && value.message ? value.message : null
}

function responseOk(response: Pick<Response, 'status'> & { ok?: boolean }): boolean {
  return typeof response.ok === 'boolean'
    ? response.ok
    : response.status >= 200 && response.status < 300
}

export function useAlertConfig(accessToken: string | null, showToast?: ToastFn) {
  const { t } = useLanguage()
  const auth = useAuthSession()
  const scopeKey = `${auth.viewerKey}\u0000${auth.sessionGeneration}\u0000${auth.userId ?? ''}\u0000${accessToken ?? ''}`
  const scopeKeyRef = useRef(scopeKey)
  scopeKeyRef.current = scopeKey
  const [config, setConfig] = useViewerOwnedState<AlertConfig>(emptyConfig, emptyConfig, scopeKey)
  const [loading, setLoading] = useViewerOwnedState(false, () => false, scopeKey)
  const [savingCount, setSavingCount] = useViewerOwnedState(0, () => 0, scopeKey)
  const [error, setError] = useViewerOwnedState<string | null>(null, () => null, scopeKey)
  const inFlightByScopeKey = useRef(new Map<string, Promise<boolean>>())
  const loadRequestIdRef = useRef(0)
  const activeLoadRef = useRef<{
    scopeKey: string
    requestId: number
    controller: AbortController
  } | null>(null)

  const hasBoundScope =
    auth.authChecked &&
    !auth.loading &&
    Boolean(
      accessToken &&
      auth.accessToken === accessToken &&
      auth.userId &&
      auth.viewerKey === `user:${auth.userId}`
    )

  useEffect(() => {
    return () => {
      activeLoadRef.current?.controller.abort()
    }
  }, [scopeKey])

  const loadConfig = useCallback(async () => {
    if (!hasBoundScope || !accessToken) {
      setConfig(emptyConfig())
      setLoading(false)
      setSavingCount(0)
      setError(null)
      return
    }

    const requestScopeKey = scopeKey
    const requestId = loadRequestIdRef.current + 1
    loadRequestIdRef.current = requestId
    activeLoadRef.current?.controller.abort()
    const controller = new AbortController()
    activeLoadRef.current = { scopeKey: requestScopeKey, requestId, controller }
    setLoading(true)
    setError(null)

    try {
      const res = await fetch('/api/admin/alert-config', {
        signal: controller.signal,
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      const data: unknown = await res.json()
      if (scopeKeyRef.current !== requestScopeKey) return

      const parsed = parseAlertConfigResponse(data)
      if (responseOk(res) && parsed) {
        setConfig(parsed.config)
        setError(null)
        return
      }

      setConfig(emptyConfig())
      setError(extractErrorMessage(data) ?? t('adminLoadFailed'))
    } catch (_err) {
      if (controller.signal.aborted || scopeKeyRef.current !== requestScopeKey) return
      logger.error('Error loading alert config:', _err)
      setConfig(emptyConfig())
      setError(t('adminLoadFailed'))
    } finally {
      const activeLoad = activeLoadRef.current
      if (
        activeLoad?.scopeKey === requestScopeKey &&
        activeLoad.requestId === requestId &&
        activeLoad.controller === controller
      ) {
        activeLoadRef.current = null
      }
      if (scopeKeyRef.current !== requestScopeKey) return
      setLoading(false)
    }
  }, [accessToken, hasBoundScope, scopeKey, setConfig, setError, setLoading, setSavingCount, t])

  const updateConfig = useCallback(
    async (key: string, value: string | null, enabled: boolean) => {
      if (!hasBoundScope || !accessToken) {
        setConfig(emptyConfig())
        setLoading(false)
        setSavingCount(0)
        setError(null)
        return false
      }

      const requestScopeKey = scopeKey
      const requestKey = `${requestScopeKey}\u0000${key}`
      const existingRequest = inFlightByScopeKey.current.get(requestKey)
      if (existingRequest) {
        return existingRequest
      }

      setSavingCount((count) => count + 1)

      const request = (async () => {
        try {
          const res = await fetch('/api/admin/alert-config', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${accessToken}`,
              ...getCsrfHeaders(),
            },
            body: JSON.stringify({ key, value, enabled }),
          })
          const data: unknown = await res.json()

          if (
            responseOk(res) &&
            scopeKeyRef.current === requestScopeKey &&
            data &&
            typeof data === 'object' &&
            'ok' in data &&
            data.ok === true
          ) {
            setConfig((prev) => ({
              ...prev,
              [key]: { value, enabled },
            }))
            setError(null)
            return true
          }

          if (scopeKeyRef.current !== requestScopeKey) return false
          const errorMessage = extractErrorMessage(data) ?? t('adminSaveFailed')
          showToast?.(errorMessage, 'error')
          return false
        } catch (_err) {
          if (scopeKeyRef.current !== requestScopeKey) return false
          showToast?.(t('adminNetworkError'), 'error')
          return false
        } finally {
          inFlightByScopeKey.current.delete(requestKey)
          setSavingCount((count) => Math.max(0, count - 1))
        }
      })()

      inFlightByScopeKey.current.set(requestKey, request)
      return request
    },
    [
      accessToken,
      hasBoundScope,
      scopeKey,
      setConfig,
      setError,
      setLoading,
      setSavingCount,
      showToast,
      t,
    ]
  )

  return {
    config,
    error,
    loading,
    saving: savingCount > 0,
    loadConfig,
    updateConfig,
  }
}
