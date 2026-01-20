'use client'

import { useEffect } from 'react'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/Layout/TopNav'
import { Box, Text, Button } from '@/app/components/Base'

// Hooks
import { useAdminAuth } from './hooks/useAdminAuth'
import { useFreshness } from './hooks/useFreshness'
import { useApplications } from './hooks/useApplications'

// Tab Components
import DashboardTab from './components/DashboardTab'
import ScraperStatusTab from './components/ScraperStatusTab'
import UserManagementTab from './components/UserManagementTab'
import ReportsTab from './components/ReportsTab'
import GroupApplicationsTab from './components/GroupApplicationsTab'
import GroupEditTab from './components/GroupEditTab'
import AlertConfigTab from './components/AlertConfigTab'

type AdminTab = 'dashboard' | 'scraperStatus' | 'users' | 'reports' | 'applications' | 'editApplications' | 'alertConfig'

export default function AdminPage() {
  const router = useRouter()
  const { email, accessToken, isAdmin, authChecking } = useAdminAuth()
  const { freshnessReport, loadFreshnessReport } = useFreshness()
  const { applications, editApplications, loadApplications, loadEditApplications } = useApplications(accessToken)
  
  const [activeTab, setActiveTab] = useState<AdminTab>('dashboard')

  // Load data on mount
  useEffect(() => {
    if (accessToken && isAdmin) {
      loadFreshnessReport()
      loadApplications()
      loadEditApplications()
    }
  }, [accessToken, isAdmin, loadFreshnessReport, loadApplications, loadEditApplications])

  if (authChecking) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Text size="lg">验证权限中...</Text>
        </Box>
      </Box>
    )
  }

  if (!isAdmin) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6], textAlign: 'center' }}>
          <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
            无权限访问
          </Text>
          <Text color="tertiary" style={{ marginBottom: tokens.spacing[4] }}>
            您没有管理员权限，无法访问此页面
          </Text>
          <Button variant="primary" onClick={() => router.push('/')}>
            返回首页
          </Button>
        </Box>
      </Box>
    )
  }

  // Check for alerts
  const hasScraperAlert = freshnessReport?.summary && 
    (freshnessReport.summary.critical > 0 || freshnessReport.summary.stale > 0)
  const pendingApplicationsCount = applications.length
  const pendingEditApplicationsCount = editApplications.length

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      
      <Box style={{ maxWidth: 1400, margin: '0 auto', padding: tokens.spacing[6] }}>
        <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[6] }}>
          <Text size="2xl" weight="black">
            管理后台
          </Text>
        </Box>

        {/* Tabs */}
        <Box style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[6], flexWrap: 'wrap' }}>
          <Button
            variant={activeTab === 'dashboard' ? 'primary' : 'secondary'}
            onClick={() => setActiveTab('dashboard')}
          >
            仪表盘
          </Button>
          <Button
            variant={activeTab === 'scraperStatus' ? 'primary' : 'secondary'}
            onClick={() => setActiveTab('scraperStatus')}
          >
            爬虫状态
            {hasScraperAlert && (
              <span style={{ 
                marginLeft: tokens.spacing[1], 
                color: freshnessReport?.summary?.critical ? tokens.colors.accent.error : tokens.colors.accent.warning 
              }}>
                ●
              </span>
            )}
          </Button>
          <Button
            variant={activeTab === 'users' ? 'primary' : 'secondary'}
            onClick={() => setActiveTab('users')}
          >
            用户管理
          </Button>
          <Button
            variant={activeTab === 'reports' ? 'primary' : 'secondary'}
            onClick={() => setActiveTab('reports')}
          >
            内容举报
          </Button>
          <Button
            variant={activeTab === 'applications' ? 'primary' : 'secondary'}
            onClick={() => setActiveTab('applications')}
          >
            小组申请 {pendingApplicationsCount > 0 && `(${pendingApplicationsCount})`}
          </Button>
          <Button
            variant={activeTab === 'editApplications' ? 'primary' : 'secondary'}
            onClick={() => setActiveTab('editApplications')}
          >
            小组修改 {pendingEditApplicationsCount > 0 && `(${pendingEditApplicationsCount})`}
          </Button>
          <Button
            variant={activeTab === 'alertConfig' ? 'primary' : 'secondary'}
            onClick={() => setActiveTab('alertConfig')}
          >
            报警配置
          </Button>
        </Box>

        {/* Tab Content */}
        {activeTab === 'dashboard' && (
          <DashboardTab accessToken={accessToken} />
        )}

        {activeTab === 'scraperStatus' && (
          <ScraperStatusTab />
        )}

        {activeTab === 'users' && (
          <UserManagementTab accessToken={accessToken} />
        )}

        {activeTab === 'reports' && (
          <ReportsTab accessToken={accessToken} />
        )}

        {activeTab === 'applications' && (
          <GroupApplicationsTab accessToken={accessToken} />
        )}

        {activeTab === 'editApplications' && (
          <GroupEditTab accessToken={accessToken} />
        )}

        {activeTab === 'alertConfig' && (
          <AlertConfigTab accessToken={accessToken} />
        )}
      </Box>
    </Box>
  )
}
