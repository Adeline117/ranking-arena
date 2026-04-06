'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import Card from '@/app/components/ui/Card'
import { useApplications } from '../hooks/useApplications'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

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
  const { t } = useLanguage()

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
    <Card title={t('adminPendingGroupApplications')}>
      {applicationsLoading ? (
        <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
          <Text color="tertiary">{t('loading')}</Text>
        </Box>
      ) : applications.length === 0 ? (
        <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
          <Text color="tertiary">{t('adminNoPendingApplications')}</Text>
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
                {/* Avatar */}
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
                    <Image
                      src={app.avatar_url.startsWith('data:') ? app.avatar_url : '/api/avatar?url=' + encodeURIComponent(app.avatar_url)}
                      alt={app.name}
                      width={60}
                      height={60}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      unoptimized
                    />
                  ) : (
                    <Text size="xl" weight="bold" color="tertiary">
                      {app.name.charAt(0).toUpperCase()}
                    </Text>
                  )}
                </Box>

                {/* Info */}
                <Box style={{ flex: 1 }}>
                  <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <Box>
                      <Text size="lg" weight="bold">{app.name}</Text>
                      {app.name_en && (
                        <Text size="sm" color="tertiary"> ({app.name_en})</Text>
                      )}
                    </Box>
                    <Text size="xs" color="tertiary">
                      {new Date(app.created_at).toLocaleString()}
                    </Text>
                  </Box>

                  {/* Applicant */}
                  <Text size="sm" color="secondary" style={{ marginTop: tokens.spacing[1] }}>
                    {t('adminApplicant').replace('{handle}', app.applicant?.handle || app.applicant_id.slice(0, 8))}
                  </Text>

                  {/* Description */}
                  {app.description && (
                    <Text size="sm" color="secondary" style={{ marginTop: tokens.spacing[2] }}>
                      {t('adminDescriptionLabel').replace('{text}', app.description)}
                    </Text>
                  )}
                  {app.description_en && (
                    <Text size="sm" color="tertiary" style={{ marginTop: tokens.spacing[1] }}>
                      (EN): {app.description_en}
                    </Text>
                  )}

                  {/* Role names */}
                  {app.role_names && (
                    <Box style={{ marginTop: tokens.spacing[2] }}>
                      <Text size="xs" color="tertiary">
                        {t('adminRoleNames')
                          .replace('{admin}', app.role_names.admin?.zh || app.role_names.admin?.en || t('adminRoleDefault'))
                          .replace('{member}', app.role_names.member?.zh || app.role_names.member?.en || t('adminRoleDefault'))}
                      </Text>
                    </Box>
                  )}

                  {/* Action buttons */}
                  <Box style={{ marginTop: tokens.spacing[4], display: 'flex', gap: tokens.spacing[2], flexWrap: 'wrap' }}>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => approveApplication(app.id)}
                      disabled={actionLoading[app.id]}
                      style={{ background: tokens.colors.accent?.success || 'var(--color-score-great)' }}
                    >
                      {actionLoading[app.id] ? t('processing') : t('adminApprove')}
                    </Button>

                    {showRejectInput[app.id] ? (
                      <Box style={{ display: 'flex', gap: tokens.spacing[2], alignItems: 'center', flex: 1 }}>
                        <input
                          type="text"
                          placeholder={t('adminRejectReasonPlaceholder')}
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
                          style={{ background: tokens.colors.accent?.error || 'var(--color-accent-error)', color: tokens.colors.white }}
                        >
                          {t('adminConfirmReject')}
                        </Button>
                        <Button
                          variant="text"
                          size="sm"
                          onClick={() => setShowRejectInput(prev => ({ ...prev, [app.id]: false }))}
                        >
                          {t('cancel')}
                        </Button>
                      </Box>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setShowRejectInput(prev => ({ ...prev, [app.id]: true }))}
                        disabled={actionLoading[app.id]}
                      >
                        {t('adminReject')}
                      </Button>
                    )}
                  </Box>
                </Box>
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
          onClick={loadApplications}
          disabled={applicationsLoading}
        >
          {applicationsLoading ? t('adminRefreshing') : t('adminRefreshList')}
        </Button>
      </Box>
    </Card>
  )
}
