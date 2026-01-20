'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/Base'
import Card from '@/app/components/UI/Card'
import { useApplications } from '../hooks/useApplications'

interface GroupApplicationsTabProps {
  accessToken: string | null
}

export default function GroupApplicationsTab({ accessToken }: GroupApplicationsTabProps) {
  const {
    applications,
    applicationsLoading,
    actionLoading,
    loadApplications,
    approveApplication,
    rejectApplication,
  } = useApplications(accessToken)

  const [showRejectInput, setShowRejectInput] = useState<Record<string, boolean>>({})
  const [rejectReason, setRejectReason] = useState<Record<string, string>>({})

  useEffect(() => {
    if (accessToken) {
      loadApplications()
    }
  }, [accessToken, loadApplications])

  const handleReject = async (applicationId: string) => {
    const reason = rejectReason[applicationId]?.trim()
    const success = await rejectApplication(applicationId, reason)
    if (success) {
      setShowRejectInput(prev => ({ ...prev, [applicationId]: false }))
      setRejectReason(prev => ({ ...prev, [applicationId]: '' }))
    }
  }

  return (
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
                      onClick={() => approveApplication(app.id)}
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
          onClick={loadApplications}
          disabled={applicationsLoading}
        >
          {applicationsLoading ? '刷新中...' : '刷新列表'}
        </Button>
      </Box>
    </Card>
  )
}
