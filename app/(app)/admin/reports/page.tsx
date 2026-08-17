'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import ReportsTab from '../components/ReportsTab'
import { useAdminAuth } from '../hooks/useAdminAuth'

export default function AdminReportsPage() {
  const { t } = useLanguage()
  const { accessToken, isAdmin, authChecking } = useAdminAuth()

  if (authChecking) return null

  if (!isAdmin || !accessToken) {
    return (
      <div
        style={{
          minHeight: '100vh',
          background: tokens.colors.bg.primary,
          color: tokens.colors.text.primary,
        }}
      >
        <div style={{ padding: 40, textAlign: 'center' }}>
          <h1
            style={{
              fontSize: tokens.typography.fontSize['2xl'],
              marginBottom: 8,
            }}
          >
            {t('noPermissionAccess')}
          </h1>
          <p style={{ color: 'var(--color-text-secondary)' }}>{t('noAdminPermission')}</p>
        </div>
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 900, margin: '80px auto', padding: '0 16px' }}>
      <ReportsTab accessToken={accessToken} />
    </div>
  )
}
