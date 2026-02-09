'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import Card from '@/app/components/ui/Card'
import { useApplications } from '../hooks/useApplications'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

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
  const { t } = useLanguage()

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
    <Card title={t('adminGroupEditApplications')}>
      {editApplicationsLoading ? (
        <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
          <Text color="tertiary">{t('loading')}</Text>
        </Box>
      ) : editApplications.length === 0 ? (
        <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
          <Text color="tertiary">{t('adminNoPendingEditApps')}</Text>
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
                    {t('adminEditAppTitle').replace('{group}', app.group?.name || t('adminEditGroup'))}
                  </Text>
                  <Text size="sm" color="tertiary">
                    {t('adminApplicant').replace('{handle}', app.applicant?.handle || app.applicant_id.slice(0, 8))}
                  </Text>
                </Box>
                <Text size="xs" color="tertiary">
                  {new Date(app.created_at).toLocaleString()}
                </Text>
              </Box>

              {/* Edit content */}
              <Box style={{
                padding: tokens.spacing[3],
                background: tokens.colors.bg.primary,
                borderRadius: tokens.radius.lg,
                marginBottom: tokens.spacing[3],
              }}>
                <Text size="sm" weight="bold" color="secondary" style={{ marginBottom: tokens.spacing[2] }}>
                  {t('adminEditContent')}
                </Text>
                {app.name && (
                  <Text size="sm" color="secondary">
                    {t('adminEditName').replace('{name}', app.name)}
                  </Text>
                )}
                {app.name_en && (
                  <Text size="sm" color="tertiary">
                    {t('adminEditNameEn').replace('{name}', app.name_en)}
                  </Text>
                )}
                {app.description && (
                  <Text size="sm" color="secondary">
                    {t('adminEditDescription').replace('{text}', app.description.slice(0, 100))}{app.description.length > 100 ? '...' : ''}
                  </Text>
                )}
                {app.description_en && (
                  <Text size="sm" color="tertiary">
                    {t('adminEditDescriptionEn').replace('{text}', app.description_en.slice(0, 100))}{app.description_en.length > 100 ? '...' : ''}
                  </Text>
                )}
                {app.rules && (
                  <Text size="sm" color="secondary">
                    {t('adminEditRules').replace('{text}', app.rules.slice(0, 100))}{app.rules.length > 100 ? '...' : ''}
                  </Text>
                )}
                {app.avatar_url && (
                  <Text size="sm" color="secondary">
                    {t('adminEditAvatar')}
                  </Text>
                )}
              </Box>

              {/* Action buttons */}
              <Box style={{ display: 'flex', gap: tokens.spacing[2], flexWrap: 'wrap' }}>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => approveEditApplication(app.id)}
                  disabled={actionLoading[`edit_${app.id}`]}
                  style={{ background: tokens.colors.accent?.success || 'var(--color-score-great)' }}
                >
                  {actionLoading[`edit_${app.id}`] ? t('processing') : t('adminApprove')}
                </Button>

                {showRejectInput[`edit_${app.id}`] ? (
                  <Box style={{ display: 'flex', gap: tokens.spacing[2], alignItems: 'center', flex: 1 }}>
                    <input
                      type="text"
                      placeholder={t('adminRejectReasonPlaceholder')}
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
                      style={{ background: tokens.colors.accent?.error || 'var(--color-accent-error)', color: tokens.colors.white }}
                    >
                      {t('adminConfirmReject')}
                    </Button>
                    <Button
                      variant="text"
                      size="sm"
                      onClick={() => setShowRejectInput(prev => ({ ...prev, [`edit_${app.id}`]: false }))}
                    >
                      {t('cancel')}
                    </Button>
                  </Box>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setShowRejectInput(prev => ({ ...prev, [`edit_${app.id}`]: true }))}
                    disabled={actionLoading[`edit_${app.id}`]}
                  >
                    {t('adminReject')}
                  </Button>
                )}
              </Box>
            </Box>
          ))}
        </Box>
      )}

      {/* Refresh button */}
      <Box style={{ marginTop: tokens.spacing[4], textAlign: 'center' }}>
        <Button
          variant="secondary"
          size="sm"
          onClick={loadEditApplications}
          disabled={editApplicationsLoading}
        >
          {editApplicationsLoading ? t('adminRefreshing') : t('adminRefreshList')}
        </Button>
      </Box>
    </Card>
  )
}
