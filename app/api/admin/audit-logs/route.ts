/**
 * Audit Log API
 * GET /api/admin/audit-logs
 *
 * Queries both admin_logs and group_audit_log tables,
 * merges and sorts by timestamp.
 */

import { withAdminAuth } from '@/lib/api/with-admin-auth'
import { success as apiSuccess } from '@/lib/api/response'
import { createLogger } from '@/lib/utils/logger'
import { parsePage, parseLimit } from '@/lib/utils/safe-parse'

const logger = createLogger('api:audit-logs')

export const dynamic = 'force-dynamic'

export const GET = withAdminAuth(
  async ({ supabase, request }) => {
    const { searchParams } = new URL(request.url)
    const page = parsePage(searchParams.get('page'))
    const limit = parseLimit(searchParams.get('limit'), 20, 100)
    const action = searchParams.get('action') || null
    const from = searchParams.get('from') || null
    const to = searchParams.get('to') || null

    // Query admin_logs
    // KEEP 'exact' — powers pagination "Page X of Y" in the admin audit log
    // viewer. admin_logs is small (<100k rows, write-only operational log)
    // and the UI needs a correct total_pages for range navigation.
    let adminQuery = supabase
      .from('admin_logs')
      .select('id, admin_id, action, target_type, target_id, details, created_at', { count: 'exact' })

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
      .range((page - 1) * limit, page * limit - 1)

    const { data: adminLogs, count: adminCount, error: adminError } = await adminQuery

    if (adminError) {
      logger.error('Error fetching admin_logs', { error: adminError })
    }

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
      .range((page - 1) * limit, page * limit - 1)

    const { data: groupLogs, count: groupCount, error: groupError } = await groupQuery

    if (groupError) {
      logger.error('Error fetching group_audit_log', { error: groupError })
    }

    // Get actor handles for all actor IDs
    const actorIds = new Set<string>()
    for (const log of adminLogs || []) {
      if (log.admin_id) actorIds.add(log.admin_id)
    }
    for (const log of groupLogs || []) {
      if (log.actor_id) actorIds.add(log.actor_id)
    }

    const actorHandles: Record<string, string> = {}
    if (actorIds.size > 0) {
      const { data: actors } = await supabase
        .from('user_profiles')
        .select('id, handle')
        .in('id', Array.from(actorIds))

      for (const a of actors || []) {
        actorHandles[a.id] = a.handle || 'unknown'
      }
    }

    // Get group names
    const groupIds = new Set<string>()
    for (const log of groupLogs || []) {
      if (log.group_id) groupIds.add(log.group_id)
    }

    const groupNames: Record<string, string> = {}
    if (groupIds.size > 0) {
      const { data: groups } = await supabase
        .from('groups')
        .select('id, name')
        .in('id', Array.from(groupIds))

      for (const g of groups || []) {
        groupNames[g.id] = g.name || 'unknown'
      }
    }

    // Merge and normalize
    const merged = [
      ...(adminLogs || []).map((log) => ({
        id: log.id,
        source: 'admin' as const,
        actor_id: log.admin_id,
        actor_handle: actorHandles[log.admin_id] || null,
        action: log.action,
        target_type: log.target_type,
        target_id: log.target_id,
        details: log.details,
        created_at: log.created_at,
        group_name: null,
      })),
      ...(groupLogs || []).map((log) => ({
        id: log.id,
        source: 'group' as const,
        actor_id: log.actor_id,
        actor_handle: actorHandles[log.actor_id] || null,
        action: log.action,
        target_type: 'group_member',
        target_id: log.target_id,
        details: log.details,
        created_at: log.created_at,
        group_name: log.group_id ? groupNames[log.group_id] || null : null,
      })),
    ]

    // Sort by created_at desc
    merged.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

    // Trim to page size
    const pageLogs = merged.slice(0, limit)
    const total = (adminCount || 0) + (groupCount || 0)

    return apiSuccess({ logs: pageLogs, total })
  },
  { name: 'admin-audit-logs' }
)
