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

type AdminTab = 'snapshots' | 'applications'

export default function AdminPage() {
  const router = useRouter()
  const [rows, setRows] = useState<any[]>([])
  const [applications, setApplications] = useState<GroupApplication[]>([])
  const [loading, setLoading] = useState(true)
  const [applicationsLoading, setApplicationsLoading] = useState(true)
  const [email, setEmail] = useState<string | null>(null)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [authChecking, setAuthChecking] = useState(true)
  const [activeTab, setActiveTab] = useState<AdminTab>('applications')
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({})
  const [rejectReason, setRejectReason] = useState<Record<string, string>>({})
  const [showRejectInput, setShowRejectInput] = useState<Record<string, boolean>>({})

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
        <Box style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[6] }}>
          <Button
            variant={activeTab === 'applications' ? 'primary' : 'secondary'}
            onClick={() => setActiveTab('applications')}
          >
            小组申请 {applications.length > 0 && `(${applications.length})`}
          </Button>
          <Button
            variant={activeTab === 'snapshots' ? 'primary' : 'secondary'}
            onClick={() => setActiveTab('snapshots')}
          >
            交易员快照
          </Button>
        </Box>

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
