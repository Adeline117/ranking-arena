/**
 * Audit Log API
 * GET /api/admin/audit-logs
 *
 * Queries both admin_logs and group_audit_log tables,
 * merges and sorts by timestamp.
 */

import { withAdminAuth } from '@/lib/api/with-admin-auth'
import { success as apiSuccess } from '@/lib/api/response'
import { ApiError } from '@/lib/api/errors'
import { createLogger } from '@/lib/utils/logger'
import { parsePage, parseLimit } from '@/lib/utils/safe-parse'

const logger = createLogger('api:audit-logs')
const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }
const MAX_PREFIX_ROWS = 10_000

export const dynamic = 'force-dynamic'

type MergedAuditLog = {
  id: string
  source: 'admin' | 'group'
  actor_id: string | null
  action: string
  target_type: string | null
  target_id: string | null
  details: unknown
  created_at: string | null
  group_id: string | null
}

function getCreatedAtRank(value: string | null): number {
  if (!value) return 0
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : 0
}

function compareMergedAuditLogs(a: MergedAuditLog, b: MergedAuditLog): number {
  const createdAtDiff = getCreatedAtRank(b.created_at) - getCreatedAtRank(a.created_at)
  if (createdAtDiff !== 0) return createdAtDiff

  if (a.source !== b.source) {
    return a.source.localeCompare(b.source)
  }

  return b.id.localeCompare(a.id)
}

export const GET = withAdminAuth(
  async ({ supabase, request }) => {
    const { searchParams } = new URL(request.url)
    const page = parsePage(searchParams.get('page'))
    const limit = parseLimit(searchParams.get('limit'), 20, 100)
    const prefixRows = page * limit
    if (!Number.isSafeInteger(prefixRows) || prefixRows > MAX_PREFIX_ROWS) {
      throw ApiError.validation('Requested audit log page exceeds prefix query cap', {
        page,
        limit,
        maxPrefixRows: MAX_PREFIX_ROWS,
      })
    }
    const offset = (page - 1) * limit
    const fetchEnd = prefixRows - 1
    const action = searchParams.get('action') || null
    const from = searchParams.get('from') || null
    const to = searchParams.get('to') || null

    // Query admin_logs
    // KEEP 'exact' — powers pagination "Page X of Y" in the admin audit log
    // viewer. admin_logs is small (<100k rows, write-only operational log)
    // and the UI needs a correct total_pages for range navigation.
    let adminQuery = supabase
      .from('admin_logs')
      .select('id, admin_id, action, target_type, target_id, details, created_at', {
        count: 'exact',
      })

    if (action) {
      adminQuery = adminQuery.eq('action', action)
    }
    if (from) {
      adminQuery = adminQuery.gte('created_at', `${from}T00:00:00Z`)
    }
    if (to) {
      adminQuery = adminQuery.lte('created_at', `${to}T23:59:59Z`)
    }

    adminQuery = adminQuery
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(0, fetchEnd)

    // Query group_audit_log
    // KEEP 'exact' — same pagination reason as admin_logs above.
    let groupQuery = supabase
      .from('group_audit_log')
      .select('id, group_id, actor_id, action, target_id, details, created_at', { count: 'exact' })

    if (action) {
      groupQuery = groupQuery.eq('action', action)
    }
    if (from) {
      groupQuery = groupQuery.gte('created_at', `${from}T00:00:00Z`)
    }
    if (to) {
      groupQuery = groupQuery.lte('created_at', `${to}T23:59:59Z`)
    }

    groupQuery = groupQuery
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(0, fetchEnd)

    const [
      { data: adminLogs, count: adminCount, error: adminError },
      { data: groupLogs, count: groupCount, error: groupError },
    ] = await Promise.all([adminQuery, groupQuery])

    if (adminError) {
      logger.error('Error fetching admin_logs', { error: adminError })
      throw ApiError.database('Failed to fetch admin audit logs')
    }
    if (groupError) {
      logger.error('Error fetching group_audit_log', { error: groupError })
      throw ApiError.database('Failed to fetch group audit logs')
    }
    if (!Number.isSafeInteger(adminCount) || (adminCount as number) < 0) {
      throw ApiError.database('Invalid admin audit log count')
    }
    if (!Number.isSafeInteger(groupCount) || (groupCount as number) < 0) {
      throw ApiError.database('Invalid group audit log count')
    }

    const merged: MergedAuditLog[] = [
      ...(adminLogs || []).map((log) => ({
        id: log.id,
        source: 'admin' as const,
        actor_id: log.admin_id,
        action: log.action,
        target_type: log.target_type,
        target_id: log.target_id,
        details: log.details,
        created_at: log.created_at,
        group_id: null,
      })),
      ...(groupLogs || []).map((log) => ({
        id: log.id,
        source: 'group' as const,
        actor_id: log.actor_id,
        action: log.action,
        target_type: 'group_member',
        target_id: log.target_id,
        details: log.details,
        created_at: log.created_at,
        group_id: log.group_id,
      })),
    ]

    merged.sort(compareMergedAuditLogs)

    const pageLogs = merged.slice(offset, offset + limit)
    const total = (adminCount as number) + (groupCount as number)

    const actorIds = new Set<string>()
    const groupIds = new Set<string>()
    for (const log of pageLogs) {
      if (log.actor_id) actorIds.add(log.actor_id)
      if (log.group_id) groupIds.add(log.group_id)
    }

    const actorHandles: Record<string, string> = {}
    if (actorIds.size > 0) {
      const { data: actors, error: actorsError } = await supabase
        .from('user_profiles')
        .select('id, handle')
        .in('id', Array.from(actorIds))

      if (actorsError) {
        throw ApiError.database('Failed to fetch audit log actors')
      }

      for (const actor of actors || []) {
        actorHandles[actor.id] = actor.handle || 'unknown'
      }
    }

    const groupNames: Record<string, string> = {}
    if (groupIds.size > 0) {
      const { data: groups, error: groupsError } = await supabase
        .from('groups')
        .select('id, name')
        .in('id', Array.from(groupIds))

      if (groupsError) {
        throw ApiError.database('Failed to fetch audit log groups')
      }

      for (const group of groups || []) {
        groupNames[group.id] = group.name || 'unknown'
      }
    }

    return apiSuccess(
      {
        logs: pageLogs.map((log) => ({
          id: log.id,
          source: log.source,
          actor_id: log.actor_id,
          actor_handle: log.actor_id ? actorHandles[log.actor_id] || null : null,
          action: log.action,
          target_type: log.target_type,
          target_id: log.target_id,
          details: log.details,
          created_at: log.created_at,
          group_name: log.group_id ? groupNames[log.group_id] || null : null,
        })),
        total,
      },
      200,
      NO_STORE_HEADERS
    )
  },
  { name: 'admin-audit-logs' }
)
