'use client'

import React, { useState, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import { SectionCard } from './shared'
import { MultiAccountSection } from './MultiAccountSection'
import { supabase } from '@/lib/supabase/client'
import { getCsrfHeaders } from '@/lib/api/client'

interface AccountSectionProps {
  onLogout: () => void
  onDeleteAccount: () => void
}

export const AccountSection = React.memo(function AccountSection({ onLogout, onDeleteAccount }: AccountSectionProps) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const [exporting, setExporting] = useState(false)

  const handleExportData = useCallback(async () => {
    if (exporting) return
    setExporting(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        showToast(t('pleaseLoginFirst'), 'error')
        return
      }
      const res = await fetch('/api/settings/export', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          ...getCsrfHeaders(),
        },
      })
      if (res.status === 429) {
        showToast(t('exportRateLimited') || 'Export limit reached. Try again in 24 hours.', 'error')
        return
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        showToast(data.error || t('operationFailed'), 'error')
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      try {
        const a = document.createElement('a')
        a.href = url
        a.download = `arena-data-export-${new Date().toISOString().slice(0, 10)}.json`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        showToast(t('exportSuccess') || 'Data exported successfully!', 'success')
      } finally {
        URL.revokeObjectURL(url) // Always revoke, even if download trigger fails
      }
    } catch {
      showToast(t('networkError'), 'error')
    } finally {
      setExporting(false)
    }
  }, [exporting, showToast, t])

  return (
    <SectionCard id="account" title={t('accountSection')} variant="danger">
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
        {/* Data Export */}
        <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Box>
            <Text size="sm" weight="medium">{t('exportData') || 'Export Data'}</Text>
            <Text size="xs" color="tertiary">{t('exportDataDesc') || 'Download all your data as JSON. Limited to once per 24 hours.'}</Text>
          </Box>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleExportData}
            disabled={exporting}
          >
            {exporting ? (t('exporting') || 'Exporting...') : (t('exportData') || 'Export')}
          </Button>
        </Box>

        <Box style={{ height: 1, background: tokens.colors.border.primary }} />

        {/* Multi-Account Section */}
        <Box>
          <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: tokens.spacing[2] }}>
            <Box>
              <Text size="sm" weight="medium">{t('linkedAccountsTitle')}</Text>
              <Text size="xs" color="tertiary">{t('linkedAccountsDesc')}</Text>
            </Box>
          </Box>
          <MultiAccountSection />
        </Box>

        <Box style={{ height: 1, background: tokens.colors.border.primary }} />

        {/* Logout */}
        <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Box>
            <Text size="sm" weight="medium">{t('logout')}</Text>
            <Text size="xs" color="tertiary">{t('logoutDesc')}</Text>
          </Box>
          <Button
            variant="secondary"
            size="sm"
            onClick={onLogout}
            style={{ color: tokens.colors.accent.error, borderColor: tokens.colors.accent.error + '40' }}
          >
            {t('logout')}
          </Button>
        </Box>

        <Box style={{ height: 1, background: tokens.colors.border.primary }} />

        {/* Account Deletion */}
        <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Box>
            <Text size="sm" weight="medium" style={{ color: tokens.colors.accent.error }}>{t('deleteAccount')}</Text>
            <Text size="xs" color="tertiary">{t('deleteAccountDesc2')}</Text>
          </Box>
          <Button
            variant="secondary"
            size="sm"
            onClick={onDeleteAccount}
            style={{ color: tokens.colors.accent.error, borderColor: tokens.colors.accent.error + '40' }}
          >
            {t('deleteAccount')}
          </Button>
        </Box>
      </Box>
    </SectionCard>
  )
})
