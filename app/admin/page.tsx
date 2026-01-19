'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/Layout/TopNav'
import { Box, Text, Button } from '@/app/components/Base'
import Card from '@/app/components/UI/Card'

// 管理员邮箱白名单（可以移到环境变量或数据库）
const ADMIN_EMAILS: string[] = [
  // 添加管理员邮箱，例如: 'admin@example.com'
]

type GroupApplication = {
  id: string
  applicant_id: string
  name: string
  name_en?: string | null
  description?: string | null
  description_en?: string | null
  avatar_url?: string | null
  role_names?: any
  status: string
  reject_reason?: string | null
  created_at: string
  applicant?: {
    id: string
    handle?: string | null
    avatar_url?: string | null
  }
}

type GroupEditApplication = {
  id: string
  group_id: string
  applicant_id: string
  name?: string | null
  name_en?: string | null
  description?: string | null
  description_en?: string | null
  avatar_url?: string | null
  rules_json?: any
  rules?: string | null
  rules_en?: string | null
  role_names?: any
  status: string
  reject_reason?: string | null
  created_at: string
  group?: {
    id: string
    name: string
    name_en?: string | null
  }
  applicant?: {
    handle?: string | null
    avatar_url?: string | null
  }
}

type TraderData = {
  traderId: string
  handle: string | null
  roi: number
  pnl: number | null
  winRate: number | null
  rank: number
}

type PeriodReport = {
  period: string
  lastUpdate: string | null
  isStale: boolean
  traderCount: number
  top10: TraderData[]
}

type SourceReport = {
  source: string
  displayName: string
  type: string
  periods: PeriodReport[]
}

type DataReport = {
  ok: boolean
  stats: {
    totalSources: number
    healthySources: number
    staleSources: number
    lastGenerated: string
  }
  reports: SourceReport[]
}

type AdminTab = 'snapshots' | 'applications' | 'editApplications' | 'dataReport' | 'scraperStatus'

type PlatformFreshnessStatus = {
  platform: string
  displayName: string
  lastUpdate: string | null
  ageMs: number | null
  ageHours: number | null
  status: 'fresh' | 'stale' | 'critical' | 'unknown'
  recordCount: number
}

type FreshnessReport = {
  ok: boolean
  checked_at: string
  summary: {
    total: number
    fresh: number
    stale: number
    critical: number
    unknown: number
  }
  thresholds: {
    stale: string
    critical: string
  }
  platforms: PlatformFreshnessStatus[]
}

export default function AdminPage() {
  const router = useRouter()
  const [rows, setRows] = useState<any[]>([])
  const [applications, setApplications] = useState<GroupApplication[]>([])
  const [editApplications, setEditApplications] = useState<GroupEditApplication[]>([])
  const [dataReport, setDataReport] = useState<DataReport | null>(null)
  const [freshnessReport, setFreshnessReport] = useState<FreshnessReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [applicationsLoading, setApplicationsLoading] = useState(true)
  const [editApplicationsLoading, setEditApplicationsLoading] = useState(true)
  const [reportLoading, setReportLoading] = useState(false)
  const [freshnessLoading, setFreshnessLoading] = useState(false)
  const [email, setEmail] = useState<string | null>(null)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [authChecking, setAuthChecking] = useState(true)
  const [activeTab, setActiveTab] = useState<AdminTab>('dataReport')
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({})
  const [rejectReason, setRejectReason] = useState<Record<string, string>>({})
  const [showRejectInput, setShowRejectInput] = useState<Record<string, boolean>>({})
  const [expandedSources, setExpandedSources] = useState<Set<string>>(new Set())

  useEffect(() => {
    checkAuth()
  }, [])

  async function checkAuth() {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      
      if (!session?.user) {
        router.push('/login?redirect=/admin')
        return
      }

      setEmail(session.user.email ?? null)
      setAccessToken(session.access_token)
      
      // 检查是否是管理员
      // 方法1: 邮箱白名单
      const isAdminByEmail = session.user.email && ADMIN_EMAILS.includes(session.user.email)
      
      // 方法2: 检查数据库中的 admin 角色
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', session.user.id)
        .maybeSingle()
      
      const isAdminByRole = profile?.role === 'admin'
      
      if (!isAdminByEmail && !isAdminByRole) {
        // 不是管理员，重定向到首页
        router.push('/')
        return
      }
      
      setIsAdmin(true)
      setAuthChecking(false)
      loadSnapshots()
      loadApplications(session.access_token)
      loadEditApplications(session.access_token)
      loadDataReport()
      loadFreshnessReport()
    } catch (error) {
      console.error('Auth check failed:', error)
      router.push('/login')
    }
  }

  async function loadSnapshots() {
    setLoading(true)

    const { data } = await supabase
      .from('trader_snapshots')
      .select('source, source_trader_id, roi, win_rate, followers, captured_at')
      .order('roi', { ascending: false })
      .limit(50)

    setRows(data || [])
    setLoading(false)
  }

  async function loadApplications(token: string) {
    setApplicationsLoading(true)
    
    try {
      const res = await fetch('/api/groups/applications?status=pending', {
        headers: { Authorization: `Bearer ${token}` }
      })
      const data = await res.json()
      
      if (data.applications) {
        setApplications(data.applications)
      }
    } catch (err) {
      console.error('Error loading applications:', err)
    } finally {
      setApplicationsLoading(false)
    }
  }

  async function loadEditApplications(token: string) {
    setEditApplicationsLoading(true)
    
    try {
      const res = await fetch('/api/groups/edit-applications?status=pending', {
        headers: { Authorization: `Bearer ${token}` }
      })
      const data = await res.json()
      
      if (data.applications) {
        setEditApplications(data.applications)
      }
    } catch (err) {
      console.error('Error loading edit applications:', err)
    } finally {
      setEditApplicationsLoading(false)
    }
  }

  async function handleApproveEdit(applicationId: string) {
    if (!accessToken) return
    
    setActionLoading(prev => ({ ...prev, [`edit_${applicationId}`]: true }))
    
    try {
      const res = await fetch(`/api/groups/edit-applications/${applicationId}/approve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` }
      })
      
      const data = await res.json()
      
      if (res.ok) {
        loadEditApplications(accessToken)
      } else {
        alert(data.error || '操作失败')
      }
    } catch (err) {
      alert('网络错误')
    } finally {
      setActionLoading(prev => ({ ...prev, [`edit_${applicationId}`]: false }))
    }
  }

  async function handleRejectEdit(applicationId: string) {
    if (!accessToken) return
    
    const reason = rejectReason[`edit_${applicationId}`]?.trim()
    
    setActionLoading(prev => ({ ...prev, [`edit_${applicationId}`]: true }))
    
    try {
      const res = await fetch(`/api/groups/edit-applications/${applicationId}/reject`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}` 
        },
        body: JSON.stringify({ reason })
      })
      
      const data = await res.json()
      
      if (res.ok) {
        loadEditApplications(accessToken)
        setShowRejectInput(prev => ({ ...prev, [`edit_${applicationId}`]: false }))
        setRejectReason(prev => ({ ...prev, [`edit_${applicationId}`]: '' }))
      } else {
        alert(data.error || '操作失败')
      }
    } catch (err) {
      alert('网络错误')
    } finally {
      setActionLoading(prev => ({ ...prev, [`edit_${applicationId}`]: false }))
    }
  }

  async function loadDataReport() {
    setReportLoading(true)
    
    try {
      const res = await fetch('/api/admin/data-report')
      const data = await res.json()
      
      if (data.ok) {
        setDataReport(data)
      }
    } catch (err) {
      console.error('Error loading data report:', err)
    } finally {
      setReportLoading(false)
    }
  }

  async function loadFreshnessReport() {
    setFreshnessLoading(true)
    
    try {
      const res = await fetch('/api/cron/check-data-freshness')
      const data = await res.json()
      
      setFreshnessReport(data)
    } catch (err) {
      console.error('Error loading freshness report:', err)
    } finally {
      setFreshnessLoading(false)
    }
  }

  async function handleApprove(applicationId: string) {
    if (!accessToken) return
    
    setActionLoading(prev => ({ ...prev, [applicationId]: true }))
    
    try {
      const res = await fetch(`/api/groups/applications/${applicationId}/approve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` }
      })
      
      const data = await res.json()
      
      if (res.ok) {
        // 刷新列表
        loadApplications(accessToken)
      } else {
        alert(data.error || '操作失败')
      }
    } catch (err) {
      alert('网络错误')
    } finally {
      setActionLoading(prev => ({ ...prev, [applicationId]: false }))
    }
  }

  async function handleReject(applicationId: string) {
    if (!accessToken) return
    
    const reason = rejectReason[applicationId]?.trim()
    
    setActionLoading(prev => ({ ...prev, [applicationId]: true }))
    
    try {
      const res = await fetch(`/api/groups/applications/${applicationId}/reject`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}` 
        },
        body: JSON.stringify({ reason })
      })
      
      const data = await res.json()
      
      if (res.ok) {
        // 刷新列表
        loadApplications(accessToken)
        setShowRejectInput(prev => ({ ...prev, [applicationId]: false }))
        setRejectReason(prev => ({ ...prev, [applicationId]: '' }))
      } else {
        alert(data.error || '操作失败')
      }
    } catch (err) {
      alert('网络错误')
    } finally {
      setActionLoading(prev => ({ ...prev, [applicationId]: false }))
    }
  }

  function toggleSourceExpand(source: string) {
    setExpandedSources(prev => {
      const newSet = new Set(prev)
      if (newSet.has(source)) {
        newSet.delete(source)
      } else {
        newSet.add(source)
      }
      return newSet
    })
  }

  function getSourceTypeColor(type: string) {
    switch (type) {
      case 'futures': return tokens.colors.accent.warning
      case 'spot': return tokens.colors.accent.success
      case 'web3': return '#3B82F6'
      default: return tokens.colors.text.tertiary
    }
  }

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
            variant={activeTab === 'scraperStatus' ? 'primary' : 'secondary'}
            onClick={() => setActiveTab('scraperStatus')}
          >
            爬虫状态 {freshnessReport && (freshnessReport.summary.critical > 0 || freshnessReport.summary.stale > 0) && (
              <span style={{ 
                marginLeft: tokens.spacing[1], 
                color: freshnessReport.summary.critical > 0 ? tokens.colors.accent.error : tokens.colors.accent.warning 
              }}>
                ●
              </span>
            )}
          </Button>
          <Button
            variant={activeTab === 'dataReport' ? 'primary' : 'secondary'}
            onClick={() => setActiveTab('dataReport')}
          >
            数据校验报告
          </Button>
          <Button
            variant={activeTab === 'applications' ? 'primary' : 'secondary'}
            onClick={() => setActiveTab('applications')}
          >
            小组申请 {applications.length > 0 && `(${applications.length})`}
          </Button>
          <Button
            variant={activeTab === 'editApplications' ? 'primary' : 'secondary'}
            onClick={() => setActiveTab('editApplications')}
          >
            小组修改 {editApplications.length > 0 && `(${editApplications.length})`}
          </Button>
          <Button
            variant={activeTab === 'snapshots' ? 'primary' : 'secondary'}
            onClick={() => setActiveTab('snapshots')}
          >
            交易员快照
          </Button>
        </Box>

        {/* Scraper Status Tab */}
        {activeTab === 'scraperStatus' && (
          <Card title="爬虫状态监控">
            <Box style={{ marginBottom: tokens.spacing[4], display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: tokens.spacing[3] }}>
              <Box>
                {freshnessReport && (
                  <Box style={{ display: 'flex', gap: tokens.spacing[4], flexWrap: 'wrap' }}>
                    <Text size="sm" color="secondary">
                      总计: {freshnessReport.summary.total} 个平台
                    </Text>
                    <Text size="sm" style={{ color: tokens.colors.accent.success }}>
                      正常: {freshnessReport.summary.fresh}
                    </Text>
                    <Text size="sm" style={{ color: tokens.colors.accent.warning }}>
                      陈旧 (&gt;{freshnessReport.thresholds.stale}): {freshnessReport.summary.stale}
                    </Text>
                    <Text size="sm" style={{ color: tokens.colors.accent.error }}>
                      严重 (&gt;{freshnessReport.thresholds.critical}): {freshnessReport.summary.critical}
                    </Text>
                  </Box>
                )}
              </Box>
              <Button variant="secondary" size="sm" onClick={loadFreshnessReport} disabled={freshnessLoading}>
                {freshnessLoading ? '刷新中...' : '刷新状态'}
              </Button>
            </Box>

            {freshnessLoading && !freshnessReport ? (
              <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
                <Text color="tertiary">加载中...</Text>
              </Box>
            ) : freshnessReport ? (
              <Box>
                {/* 状态概览卡片 */}
                <Box style={{ 
                  display: 'grid', 
                  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', 
                  gap: tokens.spacing[4],
                  marginBottom: tokens.spacing[4],
                }}>
                  {freshnessReport.platforms.map((platform) => {
                    const statusColors: Record<string, string> = {
                      fresh: tokens.colors.accent.success,
                      stale: tokens.colors.accent.warning,
                      critical: tokens.colors.accent.error,
                      unknown: tokens.colors.text.tertiary,
                    }
                    const statusLabels: Record<string, string> = {
                      fresh: '正常',
                      stale: '陈旧',
                      critical: '严重',
                      unknown: '未知',
                    }
                    
                    return (
                      <Box
                        key={platform.platform}
                        style={{
                          padding: tokens.spacing[4],
                          background: tokens.colors.bg.secondary,
                          borderRadius: tokens.radius.lg,
                          border: `1px solid ${tokens.colors.border.primary}`,
                          borderLeft: `4px solid ${statusColors[platform.status]}`,
                        }}
                      >
                        <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: tokens.spacing[2] }}>
                          <Text size="md" weight="bold">{platform.displayName}</Text>
                          <Box
                            style={{
                              padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                              borderRadius: tokens.radius.sm,
                              background: statusColors[platform.status],
                              color: '#fff',
                              fontSize: tokens.typography.fontSize.xs,
                              fontWeight: tokens.typography.fontWeight.bold,
                            }}
                          >
                            {statusLabels[platform.status]}
                          </Box>
                        </Box>
                        
                        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
                          <Text size="sm" color="secondary">
                            最后更新: {platform.lastUpdate 
                              ? new Date(platform.lastUpdate).toLocaleString('zh-CN') 
                              : '无数据'}
                          </Text>
                          {platform.ageHours !== null && (
                            <Text size="sm" color={platform.status === 'fresh' ? 'secondary' : 'tertiary'}>
                              距今: {platform.ageHours.toFixed(1)} 小时
                            </Text>
                          )}
                          <Text size="xs" color="tertiary">
                            记录数: {platform.recordCount.toLocaleString()}
                          </Text>
                        </Box>
                      </Box>
                    )
                  })}
                </Box>

                {/* 检查时间 */}
                <Box style={{ textAlign: 'center', marginTop: tokens.spacing[4] }}>
                  <Text size="xs" color="tertiary">
                    检查时间: {new Date(freshnessReport.checked_at).toLocaleString('zh-CN')}
                  </Text>
                </Box>
              </Box>
            ) : (
              <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
                <Text color="tertiary">暂无数据</Text>
              </Box>
            )}

            {/* 说明 */}
            <Box style={{ 
              marginTop: tokens.spacing[6], 
              padding: tokens.spacing[4], 
              background: tokens.colors.bg.tertiary, 
              borderRadius: tokens.radius.lg,
            }}>
              <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>状态说明</Text>
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
                <Text size="xs" color="secondary">
                  <span style={{ color: tokens.colors.accent.success, fontWeight: 'bold' }}>● 正常</span>: 数据在 12 小时内更新
                </Text>
                <Text size="xs" color="secondary">
                  <span style={{ color: tokens.colors.accent.warning, fontWeight: 'bold' }}>● 陈旧</span>: 数据超过 12 小时未更新
                </Text>
                <Text size="xs" color="secondary">
                  <span style={{ color: tokens.colors.accent.error, fontWeight: 'bold' }}>● 严重</span>: 数据超过 24 小时未更新，需要立即处理
                </Text>
              </Box>
            </Box>
          </Card>
        )}

        {/* Data Report Tab */}
        {activeTab === 'dataReport' && (
          <Card title="数据校验报告">
            <Box style={{ marginBottom: tokens.spacing[4], display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Box>
                {dataReport && (
                  <Box style={{ display: 'flex', gap: tokens.spacing[4], flexWrap: 'wrap' }}>
                    <Text size="sm" color="secondary">
                      数据源: {dataReport.stats.totalSources}
                    </Text>
                    <Text size="sm" style={{ color: tokens.colors.accent.success }}>
                      正常: {dataReport.stats.healthySources}
                    </Text>
                    <Text size="sm" style={{ color: tokens.colors.accent.error }}>
                      陈旧: {dataReport.stats.staleSources}
                    </Text>
                    <Text size="sm" color="tertiary">
                      生成时间: {dataReport.stats.lastGenerated ? new Date(dataReport.stats.lastGenerated).toLocaleString('zh-CN') : '-'}
                    </Text>
                  </Box>
                )}
              </Box>
              <Button variant="secondary" size="sm" onClick={loadDataReport} disabled={reportLoading}>
                {reportLoading ? '刷新中...' : '刷新报告'}
              </Button>
            </Box>

            {reportLoading && !dataReport ? (
              <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
                <Text color="tertiary">加载中...</Text>
              </Box>
            ) : dataReport ? (
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
                {dataReport.reports.map((report) => (
                  <Box
                    key={report.source}
                    style={{
                      background: tokens.colors.bg.secondary,
                      borderRadius: tokens.radius.lg,
                      border: `1px solid ${tokens.colors.border.primary}`,
                      overflow: 'hidden',
                    }}
                  >
                    {/* 数据源标题 */}
                    <Box
                      style={{
                        padding: tokens.spacing[4],
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        cursor: 'pointer',
                        background: expandedSources.has(report.source) ? tokens.colors.bg.tertiary : 'transparent',
                      }}
                      onClick={() => toggleSourceExpand(report.source)}
                    >
                      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
                        <Text size="lg" weight="bold">{report.displayName}</Text>
                        <Box
                          style={{
                            padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                            borderRadius: tokens.radius.sm,
                            background: getSourceTypeColor(report.type),
                            color: '#fff',
                            fontSize: tokens.typography.fontSize.xs,
                            fontWeight: tokens.typography.fontWeight.bold,
                            textTransform: 'uppercase',
                          }}
                        >
                          {report.type}
                        </Box>
                      </Box>
                      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[4] }}>
                        {report.periods.map((p) => (
                          <Box key={p.period} style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1] }}>
                            <Box
                              style={{
                                width: 8,
                                height: 8,
                                borderRadius: '50%',
                                background: p.isStale ? tokens.colors.accent.error : tokens.colors.accent.success,
                              }}
                            />
                            <Text size="sm" color={p.isStale ? 'tertiary' : 'secondary'}>
                              {p.period}
                            </Text>
                          </Box>
                        ))}
                        <Text size="lg" color="tertiary">
                          {expandedSources.has(report.source) ? '▼' : '▶'}
                        </Text>
                      </Box>
                    </Box>

                    {/* 展开内容 */}
                    {expandedSources.has(report.source) && (
                      <Box style={{ padding: tokens.spacing[4], borderTop: `1px solid ${tokens.colors.border.primary}` }}>
                        {report.periods.map((p) => (
                          <Box key={p.period} style={{ marginBottom: tokens.spacing[4] }}>
                            <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[2] }}>
                              <Text size="md" weight="bold">
                                {p.period} 排行榜
                              </Text>
                              <Box style={{ display: 'flex', gap: tokens.spacing[3] }}>
                                <Text size="xs" color={p.isStale ? 'tertiary' : 'secondary'}>
                                  {p.lastUpdate ? `更新: ${new Date(p.lastUpdate).toLocaleString('zh-CN')}` : '无数据'}
                                </Text>
                                <Text size="xs" color="tertiary">
                                  共 {p.traderCount} 人
                                </Text>
                              </Box>
                            </Box>

                            {p.top10.length > 0 ? (
                              <Box style={{ overflowX: 'auto' }}>
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: tokens.typography.fontSize.sm }}>
                                  <thead>
                                    <tr style={{ borderBottom: `1px solid ${tokens.colors.border.primary}` }}>
                                      <th style={{ padding: tokens.spacing[2], textAlign: 'left', color: tokens.colors.text.tertiary }}>排名</th>
                                      <th style={{ padding: tokens.spacing[2], textAlign: 'left', color: tokens.colors.text.tertiary }}>交易员</th>
                                      <th style={{ padding: tokens.spacing[2], textAlign: 'right', color: tokens.colors.text.tertiary }}>ROI</th>
                                      <th style={{ padding: tokens.spacing[2], textAlign: 'right', color: tokens.colors.text.tertiary }}>胜率</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {p.top10.map((trader, idx) => (
                                      <tr key={trader.traderId} style={{ borderBottom: `1px solid ${tokens.colors.border.primary}` }}>
                                        <td style={{ padding: tokens.spacing[2] }}>{idx + 1}</td>
                                        <td style={{ padding: tokens.spacing[2], fontFamily: 'monospace', fontSize: tokens.typography.fontSize.xs }}>
                                          {trader.handle || trader.traderId.slice(0, 16) + '...'}
                                        </td>
                                        <td style={{ padding: tokens.spacing[2], textAlign: 'right', color: trader.roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error, fontWeight: 'bold' }}>
                                          {trader.roi >= 0 ? '+' : ''}{trader.roi.toFixed(2)}%
                                        </td>
                                        <td style={{ padding: tokens.spacing[2], textAlign: 'right' }}>
                                          {trader.winRate != null ? `${trader.winRate.toFixed(1)}%` : '-'}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </Box>
                            ) : (
                              <Text size="sm" color="tertiary" style={{ padding: tokens.spacing[2] }}>
                                暂无数据
                              </Text>
                            )}
                          </Box>
                        ))}
                      </Box>
                    )}
                  </Box>
                ))}
              </Box>
            ) : (
              <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
                <Text color="tertiary">暂无报告数据</Text>
              </Box>
            )}
          </Card>
        )}

        {/* Applications Tab */}
        {activeTab === 'applications' && (
          <Card title="待审核的小组申请">
            {applicationsLoading ? (
              <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
                <Text color="tertiary">加载中...</Text>
              </Box>
            ) : applications.length === 0 ? (
              <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
                <Text color="tertiary">暂无待审核的申请</Text>
              </Box>
            ) : (
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
                {applications.map((app) => (
                  <Box
                    key={app.id}
                    style={{
                      padding: tokens.spacing[4],
                      background: tokens.colors.bg.secondary,
                      borderRadius: tokens.radius.xl,
                      border: `1px solid ${tokens.colors.border.primary}`,
                    }}
                  >
                    <Box style={{ display: 'flex', gap: tokens.spacing[4] }}>
                      {/* 头像 */}
                      <Box
                        style={{
                          width: 60,
                          height: 60,
                          borderRadius: tokens.radius.lg,
                          background: tokens.colors.bg.tertiary,
                          border: `1px solid ${tokens.colors.border.primary}`,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          overflow: 'hidden',
                          flexShrink: 0,
                        }}
                      >
                        {app.avatar_url ? (
                          <img
                            src={app.avatar_url}
                            alt={app.name}
                            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          />
                        ) : (
                          <Text size="xl" weight="bold" color="tertiary">
                            {app.name.charAt(0).toUpperCase()}
                          </Text>
                        )}
                      </Box>

                      {/* 信息 */}
                      <Box style={{ flex: 1 }}>
                        <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                          <Box>
                            <Text size="lg" weight="bold">{app.name}</Text>
                            {app.name_en && (
                              <Text size="sm" color="tertiary"> ({app.name_en})</Text>
                            )}
                          </Box>
                          <Text size="xs" color="tertiary">
                            {new Date(app.created_at).toLocaleString('zh-CN')}
                          </Text>
                        </Box>

                        {/* 申请者 */}
                        <Text size="sm" color="secondary" style={{ marginTop: tokens.spacing[1] }}>
                          申请者: @{app.applicant?.handle || app.applicant_id.slice(0, 8)}
                        </Text>

                        {/* 简介 */}
                        {app.description && (
                          <Text size="sm" color="secondary" style={{ marginTop: tokens.spacing[2] }}>
                            简介: {app.description}
                          </Text>
                        )}
                        {app.description_en && (
                          <Text size="sm" color="tertiary" style={{ marginTop: tokens.spacing[1] }}>
                            (EN): {app.description_en}
                          </Text>
                        )}

                        {/* 角色称呼 */}
                        {app.role_names && (
                          <Box style={{ marginTop: tokens.spacing[2] }}>
                            <Text size="xs" color="tertiary">
                              角色称呼: 管理员={app.role_names.admin?.zh || app.role_names.admin?.en || '默认'}, 
                              成员={app.role_names.member?.zh || app.role_names.member?.en || '默认'}
                            </Text>
                          </Box>
                        )}

                        {/* 操作按钮 */}
                        <Box style={{ marginTop: tokens.spacing[4], display: 'flex', gap: tokens.spacing[2], flexWrap: 'wrap' }}>
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() => handleApprove(app.id)}
                            disabled={actionLoading[app.id]}
                            style={{ background: tokens.colors.accent?.success || '#10B981' }}
                          >
                            {actionLoading[app.id] ? '处理中...' : '批准'}
                          </Button>
                          
                          {showRejectInput[app.id] ? (
                            <Box style={{ display: 'flex', gap: tokens.spacing[2], alignItems: 'center', flex: 1 }}>
                              <input
                                type="text"
                                placeholder="拒绝原因（可选）"
                                value={rejectReason[app.id] || ''}
                                onChange={(e) => setRejectReason(prev => ({ ...prev, [app.id]: e.target.value }))}
                                style={{
                                  flex: 1,
                                  padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                                  borderRadius: tokens.radius.md,
                                  border: `1px solid ${tokens.colors.border.primary}`,
                                  background: tokens.colors.bg.primary,
                                  color: tokens.colors.text.primary,
                                  fontSize: tokens.typography.fontSize.sm,
                                }}
                              />
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => handleReject(app.id)}
                                disabled={actionLoading[app.id]}
                                style={{ background: tokens.colors.accent?.error || '#EF4444', color: '#fff' }}
                              >
                                确认拒绝
                              </Button>
                              <Button
                                variant="text"
                                size="sm"
                                onClick={() => setShowRejectInput(prev => ({ ...prev, [app.id]: false }))}
                              >
                                取消
                              </Button>
                            </Box>
                          ) : (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => setShowRejectInput(prev => ({ ...prev, [app.id]: true }))}
                              disabled={actionLoading[app.id]}
                            >
                              拒绝
                            </Button>
                          )}
                        </Box>
                      </Box>
                    </Box>
                  </Box>
                ))}
              </Box>
            )}
            
            {/* 刷新按钮 */}
            <Box style={{ marginTop: tokens.spacing[4], textAlign: 'center' }}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => accessToken && loadApplications(accessToken)}
                disabled={applicationsLoading}
              >
                {applicationsLoading ? '刷新中...' : '刷新列表'}
              </Button>
            </Box>
          </Card>
        )}

        {/* Edit Applications Tab */}
        {activeTab === 'editApplications' && (
          <Card title="小组信息修改申请">
            {editApplicationsLoading ? (
              <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
                <Text color="tertiary">加载中...</Text>
              </Box>
            ) : editApplications.length === 0 ? (
              <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
                <Text color="tertiary">暂无待审核的修改申请</Text>
              </Box>
            ) : (
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
                {editApplications.map((app) => (
                  <Box
                    key={app.id}
                    style={{
                      padding: tokens.spacing[4],
                      background: tokens.colors.bg.secondary,
                      borderRadius: tokens.radius.xl,
                      border: `1px solid ${tokens.colors.border.primary}`,
                    }}
                  >
                    <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: tokens.spacing[3] }}>
                      <Box>
                        <Text size="lg" weight="bold">
                          修改申请 - {app.group?.name || '小组'}
                        </Text>
                        <Text size="sm" color="tertiary">
                          申请者: @{app.applicant?.handle || app.applicant_id.slice(0, 8)}
                        </Text>
                      </Box>
                      <Text size="xs" color="tertiary">
                        {new Date(app.created_at).toLocaleString('zh-CN')}
                      </Text>
                    </Box>

                    {/* 修改内容 */}
                    <Box style={{ 
                      padding: tokens.spacing[3], 
                      background: tokens.colors.bg.primary, 
                      borderRadius: tokens.radius.lg,
                      marginBottom: tokens.spacing[3],
                    }}>
                      <Text size="sm" weight="bold" color="secondary" style={{ marginBottom: tokens.spacing[2] }}>
                        修改内容:
                      </Text>
                      {app.name && (
                        <Text size="sm" color="secondary">
                          • 名称: {app.name}
                        </Text>
                      )}
                      {app.name_en && (
                        <Text size="sm" color="tertiary">
                          • 英文名称: {app.name_en}
                        </Text>
                      )}
                      {app.description && (
                        <Text size="sm" color="secondary">
                          • 简介: {app.description.slice(0, 100)}{app.description.length > 100 ? '...' : ''}
                        </Text>
                      )}
                      {app.description_en && (
                        <Text size="sm" color="tertiary">
                          • 英文简介: {app.description_en.slice(0, 100)}{app.description_en.length > 100 ? '...' : ''}
                        </Text>
                      )}
                      {app.rules && (
                        <Text size="sm" color="secondary">
                          • 规则: {app.rules.slice(0, 100)}{app.rules.length > 100 ? '...' : ''}
                        </Text>
                      )}
                      {app.avatar_url && (
                        <Text size="sm" color="secondary">
                          • 头像: 已更新
                        </Text>
                      )}
                    </Box>

                    {/* 操作按钮 */}
                    <Box style={{ display: 'flex', gap: tokens.spacing[2], flexWrap: 'wrap' }}>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => handleApproveEdit(app.id)}
                        disabled={actionLoading[`edit_${app.id}`]}
                        style={{ background: tokens.colors.accent?.success || '#10B981' }}
                      >
                        {actionLoading[`edit_${app.id}`] ? '处理中...' : '批准'}
                      </Button>
                      
                      {showRejectInput[`edit_${app.id}`] ? (
                        <Box style={{ display: 'flex', gap: tokens.spacing[2], alignItems: 'center', flex: 1 }}>
                          <input
                            type="text"
                            placeholder="拒绝原因（可选）"
                            value={rejectReason[`edit_${app.id}`] || ''}
                            onChange={(e) => setRejectReason(prev => ({ ...prev, [`edit_${app.id}`]: e.target.value }))}
                            style={{
                              flex: 1,
                              padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                              borderRadius: tokens.radius.md,
                              border: `1px solid ${tokens.colors.border.primary}`,
                              background: tokens.colors.bg.primary,
                              color: tokens.colors.text.primary,
                              fontSize: tokens.typography.fontSize.sm,
                            }}
                          />
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handleRejectEdit(app.id)}
                            disabled={actionLoading[`edit_${app.id}`]}
                            style={{ background: tokens.colors.accent?.error || '#EF4444', color: '#fff' }}
                          >
                            确认拒绝
                          </Button>
                          <Button
                            variant="text"
                            size="sm"
                            onClick={() => setShowRejectInput(prev => ({ ...prev, [`edit_${app.id}`]: false }))}
                          >
                            取消
                          </Button>
                        </Box>
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setShowRejectInput(prev => ({ ...prev, [`edit_${app.id}`]: true }))}
                          disabled={actionLoading[`edit_${app.id}`]}
                        >
                          拒绝
                        </Button>
                      )}
                    </Box>
                  </Box>
                ))}
              </Box>
            )}
            
            {/* 刷新按钮 */}
            <Box style={{ marginTop: tokens.spacing[4], textAlign: 'center' }}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => accessToken && loadEditApplications(accessToken)}
                disabled={editApplicationsLoading}
              >
                {editApplicationsLoading ? '刷新中...' : '刷新列表'}
              </Button>
            </Box>
          </Card>
        )}

        {/* Snapshots Tab */}
        {activeTab === 'snapshots' && (
          <Card title="交易员快照数据 (Top 50)">
            <Box style={{ marginBottom: tokens.spacing[4], textAlign: 'right' }}>
              <Button variant="secondary" size="sm" onClick={loadSnapshots} disabled={loading}>
                {loading ? '刷新中...' : '刷新数据'}
              </Button>
            </Box>
            
            {loading ? (
              <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
                <Text color="tertiary">加载中...</Text>
              </Box>
            ) : (
              <Box style={{ overflowX: 'auto' }}>
                <table style={{ 
                  width: '100%', 
                  borderCollapse: 'collapse',
                  fontSize: tokens.typography.fontSize.sm,
                }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${tokens.colors.border.primary}` }}>
                      <th style={{ padding: tokens.spacing[3], textAlign: 'left', fontWeight: tokens.typography.fontWeight.bold, color: tokens.colors.text.secondary }}>
                        来源
                      </th>
                      <th style={{ padding: tokens.spacing[3], textAlign: 'left', fontWeight: tokens.typography.fontWeight.bold, color: tokens.colors.text.secondary }}>
                        交易员 ID
                      </th>
                      <th style={{ padding: tokens.spacing[3], textAlign: 'right', fontWeight: tokens.typography.fontWeight.bold, color: tokens.colors.text.secondary }}>
                        ROI (90D)
                      </th>
                      <th style={{ padding: tokens.spacing[3], textAlign: 'right', fontWeight: tokens.typography.fontWeight.bold, color: tokens.colors.text.secondary }}>
                        胜率
                      </th>
                      <th style={{ padding: tokens.spacing[3], textAlign: 'right', fontWeight: tokens.typography.fontWeight.bold, color: tokens.colors.text.secondary }}>
                        粉丝数
                      </th>
                      <th style={{ padding: tokens.spacing[3], textAlign: 'left', fontWeight: tokens.typography.fontWeight.bold, color: tokens.colors.text.secondary }}>
                        采集时间
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {rows.map((r, idx) => (
                      <tr 
                        key={`${r.source}-${r.source_trader_id}-${idx}`}
                        style={{ 
                          borderBottom: `1px solid ${tokens.colors.border.primary}`,
                          background: idx % 2 === 0 ? 'transparent' : tokens.colors.bg.secondary,
                        }}
                      >
                        <td style={{ padding: tokens.spacing[3] }}>
                          <Box
                            style={{
                              display: 'inline-block',
                              padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                              borderRadius: tokens.radius.sm,
                              background: tokens.colors.bg.tertiary,
                              fontSize: tokens.typography.fontSize.xs,
                              fontWeight: tokens.typography.fontWeight.bold,
                              textTransform: 'uppercase',
                            }}
                          >
                            {String(r.source || '')}
                          </Box>
                        </td>
                        <td style={{ padding: tokens.spacing[3], fontFamily: 'monospace', fontSize: tokens.typography.fontSize.xs }}>
                          {r.source_trader_id?.slice(0, 16)}...
                        </td>
                        <td style={{ 
                          padding: tokens.spacing[3], 
                          textAlign: 'right',
                          color: (r.roi || 0) >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
                          fontWeight: tokens.typography.fontWeight.bold,
                        }}>
                          {r.roi != null ? `${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(2)}%` : '-'}
                        </td>
                        <td style={{ padding: tokens.spacing[3], textAlign: 'right' }}>
                          {r.win_rate != null ? `${r.win_rate.toFixed(1)}%` : '-'}
                        </td>
                        <td style={{ padding: tokens.spacing[3], textAlign: 'right' }}>
                          {r.followers?.toLocaleString() || '-'}
                        </td>
                        <td style={{ padding: tokens.spacing[3], fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary }}>
                          {r.captured_at ? new Date(r.captured_at).toLocaleString() : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Box>
            )}
          </Card>
        )}
      </Box>
    </Box>
  )
}
