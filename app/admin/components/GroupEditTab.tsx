'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import Card from '@/app/components/ui/Card'
import { useApplications } from '../hooks/useApplications'

interface GroupEditTabProps {
  accessToken: string | null
}

export default function GroupEditTab({ accessToken }: GroupEditTabProps) {
  const {
    editApplications,
    editApplicationsLoading,
    actionLoading,
    loadEditApplications,
    approveEditApplication,
    rejectEditApplication,
  } = useApplications(accessToken)

  const [showRejectInput, setShowRejectInput] = useState<Record<string, boolean>>({})
  const [rejectReason, setRejectReason] = useState<Record<string, string>>({})

  useEffect(() => {
    if (accessToken) {
      loadEditApplications()
    }
  }, [accessToken, loadEditApplications])

  const handleReject = async (applicationId: string) => {
    const reason = rejectReason[`edit_${applicationId}`]?.trim()
    const success = await rejectEditApplication(applicationId, reason)
    if (success) {
      setShowRejectInput(prev => ({ ...prev, [`edit_${applicationId}`]: false }))
      setRejectReason(prev => ({ ...prev, [`edit_${applicationId}`]: '' }))
    }
  }

  return (
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
                  onClick={() => approveEditApplication(app.id)}
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
                      onClick={() => handleReject(app.id)}
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
          onClick={loadEditApplications}
          disabled={editApplicationsLoading}
        >
          {editApplicationsLoading ? '刷新中...' : '刷新列表'}
        </Button>
      </Box>
    </Card>
  )
}
