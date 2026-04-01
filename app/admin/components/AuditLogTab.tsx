'use client'

import { useEffect, useState, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import Card from '@/app/components/ui/Card'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { logger } from '@/lib/logger'

interface AuditLogTabProps {
  accessToken: string | null
}

interface AuditLogEntry {
  id: string
  source: 'admin' | 'group'
  actor_id: string
  actor_handle: string | null
  action: string
  target_type: string | null
  target_id: string | null
  details: Record<string, unknown> | null
  created_at: string
  group_name?: string | null
}

const PAGE_SIZE = 20

const ACTION_COLORS: Record<string, string> = {
  ban_user: tokens.colors.accent.error,
  unban_user: tokens.colors.accent.success,
  issue_warning: tokens.colors.accent.warning,
  issue_temp_ban: tokens.colors.accent.error,
  issue_perm_ban: tokens.colors.accent.error,
  issue_mute: tokens.colors.accent.warning,
  promote_to_moderator: tokens.colors.accent.primary,
  demote_from_moderator: tokens.colors.accent.warning,
  delete_content: tokens.colors.accent.error,
  dismiss_report: tokens.colors.text.tertiary,
  kick: tokens.colors.accent.error,
  mute: tokens.colors.accent.warning,
  unmute: tokens.colors.accent.success,
  ban: tokens.colors.accent.error,
  unban: tokens.colors.accent.success,
  promote: tokens.colors.accent.primary,
  demote: tokens.colors.accent.warning,
}

export default function AuditLogTab({ accessToken }: AuditLogTabProps) {
  const { t } = useLanguage()
  const [logs, setLogs] = useState<AuditLogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [actionFilter, setActionFilter] = useState<string>('all')
  const [dateFrom, setDateFrom] = useState<string>('')
  const [dateTo, setDateTo] = useState<string>('')

  const loadLogs = useCallback(async (pageNum: number = 1) => {
    if (!accessToken) return

    setLoading(true)
    try {
      const params = new URLSearchParams({
        page: String(pageNum),
        limit: String(PAGE_SIZE),
      })
      if (actionFilter !== 'all') params.set('action', actionFilter)
      if (dateFrom) params.set('from', dateFrom)
      if (dateTo) params.set('to', dateTo)

      const res = await fetch(`/api/admin/audit-logs?${params}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      const data = await res.json()

      if (data.success) {
        setLogs(data.data.logs)
        setTotalPages(Math.ceil((data.data.total || 0) / PAGE_SIZE) || 1)
        setPage(pageNum)
      }
    } catch (err) {
      logger.error('Error loading audit logs:', err)
    } finally {
      setLoading(false)
    }
  }, [accessToken, actionFilter, dateFrom, dateTo])

  useEffect(() => {
    if (accessToken) {
      loadLogs(1)
    }
  }, [accessToken, loadLogs])

  const handlePageChange = (newPage: number) => {
    loadLogs(newPage)
  }

  const inputStyle = {
    padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
    borderRadius: tokens.radius.md,
    border: `1px solid ${tokens.colors.border.primary}`,
    background: tokens.colors.bg.primary,
    color: tokens.colors.text.primary,
    fontSize: tokens.typography.fontSize.sm,
  }

  return (
    <Card title={t('auditLog') || 'Audit Log'}>
      {/* Filters */}
      <Box style={{ marginBottom: tokens.spacing[4], display: 'flex', gap: tokens.spacing[3], flexWrap: 'wrap', alignItems: 'center' }}>
        <Box style={{ display: 'flex', gap: tokens.spacing[2], alignItems: 'center' }}>
          <Text size="sm" color="secondary">Action:</Text>
          <select
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            style={inputStyle}
          >
            <option value="all">All</option>
            <option value="ban_user">Ban User</option>
            <option value="unban_user">Unban User</option>
            <option value="issue_warning">Warning</option>
            <option value="issue_temp_ban">Temp Ban</option>
            <option value="issue_perm_ban">Perm Ban</option>
            <option value="issue_mute">Mute</option>
            <option value="promote_to_moderator">Promote Mod</option>
            <option value="demote_from_moderator">Demote Mod</option>
            <option value="delete_content">Delete Content</option>
            <option value="dismiss_report">Dismiss Report</option>
            <option value="kick">Kick (Group)</option>
          </select>
        </Box>

        <Box style={{ display: 'flex', gap: tokens.spacing[2], alignItems: 'center' }}>
          <Text size="sm" color="secondary">From:</Text>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            style={inputStyle}
          />
        </Box>

        <Box style={{ display: 'flex', gap: tokens.spacing[2], alignItems: 'center' }}>
          <Text size="sm" color="secondary">To:</Text>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            style={inputStyle}
          />
        </Box>

        <Button variant="secondary" size="sm" onClick={() => loadLogs(1)}>
          {t('search') || 'Search'}
        </Button>
      </Box>

      {/* Log List */}
      {loading ? (
        <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
          <Text color="tertiary">{t('loading')}</Text>
        </Box>
      ) : logs.length === 0 ? (
        <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
          <Text color="tertiary">No audit logs found</Text>
        </Box>
      ) : (
        <>
          <Box style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: tokens.typography.fontSize.sm }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${tokens.colors.border.primary}` }}>
                  <th style={{ padding: tokens.spacing[3], textAlign: 'left', color: tokens.colors.text.tertiary }}>Time</th>
                  <th style={{ padding: tokens.spacing[3], textAlign: 'left', color: tokens.colors.text.tertiary }}>Actor</th>
                  <th style={{ padding: tokens.spacing[3], textAlign: 'left', color: tokens.colors.text.tertiary }}>Action</th>
                  <th style={{ padding: tokens.spacing[3], textAlign: 'left', color: tokens.colors.text.tertiary }}>Target</th>
                  <th style={{ padding: tokens.spacing[3], textAlign: 'left', color: tokens.colors.text.tertiary }}>Details</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log, idx) => (
                  <tr
                    key={`${log.source}-${log.id}`}
                    style={{
                      borderBottom: `1px solid ${tokens.colors.border.primary}`,
                      background: idx % 2 === 0 ? 'transparent' : tokens.colors.bg.secondary,
                    }}
                  >
                    <td style={{ padding: tokens.spacing[3], whiteSpace: 'nowrap' }}>
                      <Text size="xs" color="tertiary">
                        {new Date(log.created_at).toLocaleString()}
                      </Text>
                    </td>
                    <td style={{ padding: tokens.spacing[3] }}>
                      <Text size="sm">
                        @{log.actor_handle || 'system'}
                      </Text>
                      <Text size="xs" color="tertiary">
                        {log.source === 'group' ? '(group)' : '(admin)'}
                      </Text>
                    </td>
                    <td style={{ padding: tokens.spacing[3] }}>
                      <Box
                        style={{
                          display: 'inline-block',
                          padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                          borderRadius: tokens.radius.sm,
                          background: ACTION_COLORS[log.action] || tokens.colors.bg.tertiary,
                          color: tokens.colors.white,
                          fontSize: tokens.typography.fontSize.xs,
                        }}
                      >
                        {log.action}
                      </Box>
                    </td>
                    <td style={{ padding: tokens.spacing[3] }}>
                      <Text size="sm" color="secondary">
                        {log.target_type ? `${log.target_type}` : '-'}
                      </Text>
                      {log.target_id && (
                        <Text size="xs" color="tertiary" style={{ fontFamily: 'monospace' }}>
                          {log.target_id.substring(0, 8)}...
                        </Text>
                      )}
                    </td>
                    <td style={{ padding: tokens.spacing[3], maxWidth: 300 }}>
                      {log.details ? (
                        <Text size="xs" color="secondary" style={{ wordBreak: 'break-word' }}>
                          {Object.entries(log.details)
                            .filter(([k]) => k !== 'timestamp')
                            .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
                            .join(', ')}
                        </Text>
                      ) : (
                        <Text size="xs" color="tertiary">-</Text>
                      )}
                      {log.group_name && (
                        <Text size="xs" color="tertiary">
                          Group: {log.group_name}
                        </Text>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Box>

          {/* Pagination */}
          {totalPages > 1 && (
            <Box style={{ marginTop: tokens.spacing[4], display: 'flex', justifyContent: 'center', gap: tokens.spacing[2] }}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handlePageChange(page - 1)}
                disabled={page <= 1}
              >
                {t('prevPage')}
              </Button>
              <Text size="sm" color="secondary" style={{ display: 'flex', alignItems: 'center' }}>
                {page} / {totalPages}
              </Text>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handlePageChange(page + 1)}
                disabled={page >= totalPages}
              >
                {t('nextPage')}
              </Button>
            </Box>
          )}
        </>
      )}
    </Card>
  )
}
