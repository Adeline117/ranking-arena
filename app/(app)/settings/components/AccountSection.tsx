'use client'

import React, { useCallback, useEffect, useRef } from 'react'
import { tokens, alpha } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import { SectionCard } from './shared'
import { MultiAccountSection } from './MultiAccountSection'
import { getCsrfHeaders } from '@/lib/api/client'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import {
  captureSettingsViewer,
  isSettingsViewerCurrent,
  type SettingsViewerSnapshot,
} from '../hooks/settings-viewer-scope'
import { useViewerOwnedState } from '@/lib/state/viewer-owned-state'

interface AccountSectionProps {
  onLogout: () => void
  onDeleteAccount: () => void
}

type ExportOperation = {
  id: number
  viewer: SettingsViewerSnapshot
  controller: AbortController
}

function exportScopeKey(
  viewer: SettingsViewerSnapshot | null,
  fallback: { viewerKey: string; sessionGeneration: number }
): string {
  return viewer
    ? `${viewer.viewerKey}\u0000${viewer.sessionGeneration}`
    : `invalid:${fallback.viewerKey}\u0000${fallback.sessionGeneration}`
}

export const AccountSection = React.memo(function AccountSection({
  onLogout,
  onDeleteAccount,
}: AccountSectionProps) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const tRef = useRef(t)
  tRef.current = t
  const toastRef = useRef(showToast)
  toastRef.current = showToast
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const currentViewer = captureSettingsViewer(auth)
  const scopeKey = exportScopeKey(currentViewer, auth)
  const [exporting, setExporting] = useViewerOwnedState(false, () => false, scopeKey)
  const mountedRef = useRef(false)
  const nextOperationIdRef = useRef(0)
  const operationRef = useRef<ExportOperation | null>(null)

  const operationIsCurrent = useCallback((operation: ExportOperation): boolean => {
    const latestViewer = captureSettingsViewer(authRef.current)
    return (
      mountedRef.current &&
      operationRef.current?.id === operation.id &&
      latestViewer !== null &&
      latestViewer.viewerKey === operation.viewer.viewerKey &&
      latestViewer.sessionGeneration === operation.viewer.sessionGeneration &&
      latestViewer.userId === operation.viewer.userId &&
      isSettingsViewerCurrent(operation.viewer, authRef.current)
    )
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      operationRef.current?.controller.abort()
      operationRef.current = null
    }
  }, [])

  useEffect(() => {
    const operation = operationRef.current
    if (operation && !operationIsCurrent(operation)) {
      operation.controller.abort()
      operationRef.current = null
      setExporting(false)
    }
  }, [operationIsCurrent, scopeKey, setExporting])

  const handleExportData = useCallback(async () => {
    const viewer = captureSettingsViewer(authRef.current)
    if (!viewer) {
      const latestAuth = authRef.current
      if (
        mountedRef.current &&
        latestAuth.authChecked &&
        !latestAuth.loading &&
        !latestAuth.userId
      ) {
        toastRef.current(tRef.current('pleaseLoginFirst'), 'error')
      }
      return
    }

    const activeOperation = operationRef.current
    if (activeOperation && operationIsCurrent(activeOperation)) return
    if (activeOperation) activeOperation.controller.abort()

    const operation: ExportOperation = {
      id: ++nextOperationIdRef.current,
      viewer,
      controller: new AbortController(),
    }
    operationRef.current = operation
    setExporting(true)
    try {
      const res = await fetch('/api/settings/export', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${operation.viewer.accessToken}`,
          ...getCsrfHeaders(),
        },
        signal: operation.controller.signal,
      })
      if (!operationIsCurrent(operation)) return
      if (res.status === 429) {
        toastRef.current(tRef.current('exportRateLimited'), 'error')
        return
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        if (!operationIsCurrent(operation)) return
        const error =
          typeof data === 'object' &&
          data !== null &&
          'error' in data &&
          typeof data.error === 'string' &&
          data.error
            ? data.error
            : tRef.current('operationFailed')
        toastRef.current(error, 'error')
        return
      }
      const blob = await res.blob()
      if (!operationIsCurrent(operation)) return
      const url = URL.createObjectURL(blob)
      try {
        if (!operationIsCurrent(operation)) return
        const a = document.createElement('a')
        a.href = url
        a.download = `arena-data-export-${new Date().toISOString().slice(0, 10)}.json`
        document.body.appendChild(a)
        try {
          if (!operationIsCurrent(operation)) return
          a.click()
        } finally {
          a.remove()
        }
        if (operationIsCurrent(operation)) {
          toastRef.current(tRef.current('exportSuccess'), 'success')
        }
      } finally {
        URL.revokeObjectURL(url) // Always revoke, even if download trigger fails
      }
    } catch {
      if (operationIsCurrent(operation)) {
        toastRef.current(tRef.current('networkError'), 'error')
      }
    } finally {
      if (operationRef.current?.id === operation.id) {
        operationRef.current = null
        if (mountedRef.current && isSettingsViewerCurrent(operation.viewer, authRef.current)) {
          setExporting(false)
        }
      }
    }
  }, [operationIsCurrent, setExporting])

  return (
    <SectionCard id="account" title={t('accountSection')} variant="danger">
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
        {/* Data Export */}
        <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Box>
            <Text size="sm" weight="medium">
              {t('exportData')}
            </Text>
            <Text size="xs" color="tertiary">
              {t('exportDataDesc')}
            </Text>
          </Box>
          <Button variant="secondary" size="sm" onClick={handleExportData} disabled={exporting}>
            {exporting ? t('exporting') : t('exportData')}
          </Button>
        </Box>

        <Box style={{ height: 1, background: tokens.colors.border.primary }} />

        {/* Multi-Account Section */}
        <Box>
          <Box
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: tokens.spacing[2],
            }}
          >
            <Box>
              <Text size="sm" weight="medium">
                {t('linkedAccountsTitle')}
              </Text>
              <Text size="xs" color="tertiary">
                {t('linkedAccountsDesc')}
              </Text>
            </Box>
          </Box>
          <MultiAccountSection />
        </Box>

        <Box style={{ height: 1, background: tokens.colors.border.primary }} />

        {/* Logout */}
        <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Box>
            <Text size="sm" weight="medium">
              {t('logout')}
            </Text>
            <Text size="xs" color="tertiary">
              {t('logoutDesc')}
            </Text>
          </Box>
          <Button
            variant="secondary"
            size="sm"
            onClick={onLogout}
            style={{
              color: tokens.colors.accent.error,
              borderColor: alpha(tokens.colors.accent.error, 25),
            }}
          >
            {t('logout')}
          </Button>
        </Box>

        <Box style={{ height: 1, background: tokens.colors.border.primary }} />

        {/* Account Deletion */}
        <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Box>
            <Text size="sm" weight="medium" style={{ color: tokens.colors.accent.error }}>
              {t('deleteAccount')}
            </Text>
            <Text size="xs" color="tertiary">
              {t('deleteAccountDesc2')}
            </Text>
          </Box>
          <Button
            variant="secondary"
            size="sm"
            onClick={onDeleteAccount}
            style={{
              color: tokens.colors.accent.error,
              borderColor: alpha(tokens.colors.accent.error, 25),
            }}
          >
            {t('deleteAccount')}
          </Button>
        </Box>
      </Box>
    </SectionCard>
  )
})
