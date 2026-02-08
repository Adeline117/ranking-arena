'use client'

import { useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import Card from '@/app/components/ui/Card'
import { useFreshness } from '../hooks/useFreshness'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export default function ScraperStatusTab() {
  const { freshnessReport, loading, loadFreshnessReport } = useFreshness()
  const { t } = useLanguage()

  useEffect(() => {
    loadFreshnessReport()
  }, [loadFreshnessReport])

  const statusColors: Record<string, string> = {
    fresh: tokens.colors.accent.success,
    stale: tokens.colors.accent.warning,
    critical: tokens.colors.accent.error,
    unknown: tokens.colors.text.tertiary,
  }

  const getStatusLabel = (status: string): string => {
    const labels: Record<string, string> = {
      fresh: t('adminStatusFresh'),
      stale: t('adminStatusStale'),
      critical: t('adminStatusCritical'),
      unknown: t('adminStatusUnknown'),
    }
    return labels[status] || status
  }

  const formatDate = (dateStr: string | null | undefined): string => {
    if (!dateStr) return t('adminNoDataLabel')
    const date = new Date(dateStr)
    if (isNaN(date.getTime())) return t('adminNoDataLabel')
    return date.toLocaleString()
  }

  return (
    <Card title={t('adminScraperMonitor')}>
      <Box style={{ marginBottom: tokens.spacing[4], display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: tokens.spacing[3] }}>
        <Box>
          {freshnessReport?.summary && freshnessReport?.thresholds && (
            <Box style={{ display: 'flex', gap: tokens.spacing[4], flexWrap: 'wrap' }}>
              <Text size="sm" color="secondary">
                {t('adminTotalPlatforms').replace('{count}', String(freshnessReport.summary.total))}
              </Text>
              <Text size="sm" style={{ color: tokens.colors.accent.success }}>
                {t('adminFreshCount').replace('{count}', String(freshnessReport.summary.fresh))}
              </Text>
              <Text size="sm" style={{ color: tokens.colors.accent.warning }}>
                {t('adminStaleCount').replace('{threshold}', freshnessReport.thresholds.stale).replace('{count}', String(freshnessReport.summary.stale))}
              </Text>
              <Text size="sm" style={{ color: tokens.colors.accent.error }}>
                {t('adminCriticalCount').replace('{threshold}', freshnessReport.thresholds.critical).replace('{count}', String(freshnessReport.summary.critical))}
              </Text>
            </Box>
          )}
        </Box>
        <Button variant="secondary" size="sm" onClick={loadFreshnessReport} disabled={loading}>
          {loading ? t('adminRefreshing') : t('adminRefreshStatus')}
        </Button>
      </Box>

      {loading && !freshnessReport ? (
        <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
          <Text color="tertiary">{t('loading')}</Text>
        </Box>
      ) : freshnessReport ? (
        <Box>
          {/* Status overview cards */}
          <Box style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: tokens.spacing[4],
            marginBottom: tokens.spacing[4],
          }}>
            {(freshnessReport.platforms || []).map((platform) => (
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
                      color: tokens.colors.white,
                      fontSize: tokens.typography.fontSize.xs,
                      fontWeight: tokens.typography.fontWeight.bold,
                    }}
                  >
                    {getStatusLabel(platform.status)}
                  </Box>
                </Box>

                <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
                  <Text size="sm" color="secondary">
                    {t('adminLastUpdate').replace('{time}', formatDate(platform.lastUpdate))}
                  </Text>
                  {platform.ageHours !== null && (
                    <Text size="sm" color={platform.status === 'fresh' ? 'secondary' : 'tertiary'}>
                      {t('adminAgeHours').replace('{hours}', platform.ageHours.toFixed(1))}
                    </Text>
                  )}
                  <Text size="xs" color="tertiary">
                    {t('adminRecordCount').replace('{count}', platform.recordCount.toLocaleString())}
                  </Text>
                </Box>
              </Box>
            ))}
          </Box>

          {/* Check time */}
          <Box style={{ textAlign: 'center', marginTop: tokens.spacing[4] }}>
            <Text size="xs" color="tertiary">
              {t('adminCheckedAt').replace('{time}', formatDate(freshnessReport.checked_at))}
            </Text>
          </Box>
        </Box>
      ) : (
        <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
          <Text color="tertiary">{t('noData')}</Text>
        </Box>
      )}

      {/* Explanation */}
      <Box style={{
        marginTop: tokens.spacing[6],
        padding: tokens.spacing[4],
        background: tokens.colors.bg.tertiary,
        borderRadius: tokens.radius.lg,
      }}>
        <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>{t('adminStatusExplanation')}</Text>
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
          <Text size="xs" color="secondary">
            <span style={{ color: tokens.colors.accent.success, fontWeight: 'bold' }}>● {t('adminStatusFresh')}</span>: {t('adminFreshDesc')}
          </Text>
          <Text size="xs" color="secondary">
            <span style={{ color: tokens.colors.accent.warning, fontWeight: 'bold' }}>● {t('adminStatusStale')}</span>: {t('adminStaleDesc')}
          </Text>
          <Text size="xs" color="secondary">
            <span style={{ color: tokens.colors.accent.error, fontWeight: 'bold' }}>● {t('adminStatusCritical')}</span>: {t('adminCriticalDesc')}
          </Text>
        </Box>
      </Box>
    </Card>
  )
}
