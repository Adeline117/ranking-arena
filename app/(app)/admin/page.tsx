'use client'

import { useEffect } from 'react'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

// Hooks
import { useAdminAuth } from './hooks/useAdminAuth'
import { useFreshness } from './hooks/useFreshness'
import { useApplications } from './hooks/useApplications'

// Tab Components
import AdminTabs, { tabButtonId, tabPanelId, type AdminTabItem } from './components/AdminTabs'
import DashboardTab from './components/DashboardTab'
import ScraperStatusTab from './components/ScraperStatusTab'
import UserManagementTab from './components/UserManagementTab'
import ReportsTab from './components/ReportsTab'
import GroupApplicationsTab from './components/GroupApplicationsTab'
import GroupEditTab from './components/GroupEditTab'
import AlertConfigTab from './components/AlertConfigTab'
import TraderClaimsTab from './components/TraderClaimsTab'
import AuditLogTab from './components/AuditLogTab'
import ModerationQueueTab from './components/ModerationQueueTab'

type AdminTab =
  | 'dashboard'
  | 'scraperStatus'
  | 'users'
  | 'reports'
  | 'applications'
  | 'editApplications'
  | 'alertConfig'
  | 'traderClaims'
  | 'auditLog'
  | 'moderationQueue'

export default function AdminPage() {
  const router = useRouter()
  const { t } = useLanguage()
  const { accessToken, isAdmin, authChecking } = useAdminAuth()
  const {
    freshnessReport,
    loading: freshnessLoading,
    error: freshnessError,
    loadFreshnessReport,
  } = useFreshness(accessToken)
  const { applications, editApplications, loadApplications, loadEditApplications } =
    useApplications(accessToken)

  const [activeTab, setActiveTab] = useState<AdminTab>('dashboard')

  // Load data on mount
  useEffect(() => {
    if (accessToken && isAdmin) {
      loadFreshnessReport()
      loadApplications()
      loadEditApplications()
    }
  }, [accessToken, isAdmin, loadApplications, loadEditApplications, loadFreshnessReport])

  if (authChecking) {
    return (
      <Box
        style={{
          minHeight: '100vh',
          background: tokens.colors.bg.primary,
          color: tokens.colors.text.primary,
        }}
      >
        <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Text size="lg">{t('verifyingPermission')}</Text>
        </Box>
      </Box>
    )
  }

  if (!isAdmin) {
    return (
      <Box
        style={{
          minHeight: '100vh',
          background: tokens.colors.bg.primary,
          color: tokens.colors.text.primary,
        }}
      >
        <Box
          style={{
            maxWidth: 1200,
            margin: '0 auto',
            padding: tokens.spacing[6],
            textAlign: 'center',
          }}
        >
          <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
            {t('noPermissionAccess')}
          </Text>
          <Text color="tertiary" style={{ marginBottom: tokens.spacing[4] }}>
            {t('noAdminPermission')}
          </Text>
          <Button variant="primary" onClick={() => router.push('/')}>
            {t('backToHome')}
          </Button>
        </Box>
      </Box>
    )
  }

  // Check for alerts
  const hasScraperAlert = Boolean(freshnessError || (freshnessReport && !freshnessReport.ok))
  const hasCriticalScraperAlert = Boolean(
    freshnessError ||
    (freshnessReport &&
      (freshnessReport.summary.critical > 0 || freshnessReport.summary.unknown > 0))
  )
  const scraperAttentionCount =
    (freshnessReport
      ? freshnessReport.summary.stale +
        freshnessReport.summary.critical +
        freshnessReport.summary.unknown
      : 0) + (freshnessError ? 1 : 0)
  const pendingApplicationsCount = applications.length
  const pendingEditApplicationsCount = editApplications.length

  const tabs: AdminTabItem[] = [
    { id: 'dashboard', label: t('dashboard'), ariaLabel: t('dashboard') },
    {
      id: 'scraperStatus',
      ariaLabel: hasScraperAlert
        ? `${t('scraperStatus')}. ${t('adminScraperAlertA11y').replace(
            '{count}',
            String(scraperAttentionCount)
          )}`
        : t('scraperStatus'),
      label: (
        <>
          {t('scraperStatus')}
          {hasScraperAlert && (
            <span
              aria-hidden="true"
              style={{
                marginLeft: tokens.spacing[1],
                color: hasCriticalScraperAlert
                  ? tokens.colors.accent.error
                  : tokens.colors.accent.warning,
              }}
            >
              ●
            </span>
          )}
        </>
      ),
    },
    { id: 'users', label: t('userManagement'), ariaLabel: t('userManagement') },
    { id: 'reports', label: t('contentReports'), ariaLabel: t('contentReports') },
    {
      id: 'applications',
      ariaLabel: t('groupApplications'),
      label: (
        <>
          {t('groupApplications')} {pendingApplicationsCount > 0 && `(${pendingApplicationsCount})`}
        </>
      ),
    },
    {
      id: 'editApplications',
      ariaLabel: t('groupEdits'),
      label: (
        <>
          {t('groupEdits')}{' '}
          {pendingEditApplicationsCount > 0 && `(${pendingEditApplicationsCount})`}
        </>
      ),
    },
    { id: 'traderClaims', label: t('traderClaims'), ariaLabel: t('traderClaims') },
    { id: 'alertConfig', label: t('alertConfig'), ariaLabel: t('alertConfig') },
    { id: 'moderationQueue', label: t('moderationQueue'), ariaLabel: t('moderationQueue') },
    { id: 'auditLog', label: t('auditLog'), ariaLabel: t('auditLog') },
  ]

  return (
    <Box
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
      }}
    >
      <Box style={{ maxWidth: 1400, margin: '0 auto', padding: tokens.spacing[6] }}>
        <Box
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: tokens.spacing[6],
          }}
        >
          <Text as="h1" size="2xl" weight="black">
            {t('adminDashboard')}
          </Text>
        </Box>

        {/* Tabs */}
        <AdminTabs
          tabs={tabs}
          active={activeTab}
          onChange={(id) => setActiveTab(id as AdminTab)}
          label={t('adminDashboard')}
          idPrefix="admin"
        />

        {/* Tab Content */}
        <div
          role="tabpanel"
          id={tabPanelId('admin', activeTab)}
          aria-labelledby={tabButtonId('admin', activeTab)}
          tabIndex={0}
        >
          {activeTab === 'dashboard' && <DashboardTab accessToken={accessToken} />}

          {activeTab === 'scraperStatus' && (
            <ScraperStatusTab
              freshnessReport={freshnessReport}
              loading={freshnessLoading}
              error={freshnessError}
              onRefresh={loadFreshnessReport}
            />
          )}

          {activeTab === 'users' && <UserManagementTab accessToken={accessToken} />}

          {activeTab === 'reports' && <ReportsTab accessToken={accessToken} />}

          {activeTab === 'applications' && <GroupApplicationsTab accessToken={accessToken} />}

          {activeTab === 'editApplications' && <GroupEditTab accessToken={accessToken} />}

          {activeTab === 'traderClaims' && <TraderClaimsTab accessToken={accessToken} />}

          {activeTab === 'alertConfig' && <AlertConfigTab accessToken={accessToken} />}

          {activeTab === 'moderationQueue' && <ModerationQueueTab accessToken={accessToken} />}

          {activeTab === 'auditLog' && <AuditLogTab accessToken={accessToken} />}
        </div>
      </Box>
    </Box>
  )
}
