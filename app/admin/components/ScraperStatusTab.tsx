'use client'

import { useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/Base'
import Card from '@/app/components/UI/Card'
import { useFreshness } from '../hooks/useFreshness'

export default function ScraperStatusTab() {
  const { freshnessReport, loading, loadFreshnessReport } = useFreshness()

  useEffect(() => {
    loadFreshnessReport()
  }, [loadFreshnessReport])

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
    <Card title="爬虫状态监控">
      <Box style={{ marginBottom: tokens.spacing[4], display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: tokens.spacing[3] }}>
        <Box>
          {freshnessReport?.summary && freshnessReport?.thresholds && (
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
        <Button variant="secondary" size="sm" onClick={loadFreshnessReport} disabled={loading}>
          {loading ? '刷新中...' : '刷新状态'}
        </Button>
      </Box>

      {loading && !freshnessReport ? (
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
            {freshnessReport.platforms.map((platform) => (
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
            ))}
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
  )
}
