export const GROUP_AUDIT_PAGE_LIMIT = 50
export const MAX_GROUP_AUDIT_PAGES = 20

export type GroupAuditActivity = {
  id: string
  type: string
  title: string
  message: string
  created_at: string
  actor_id?: string
}

export type GroupAuditPageFetchResult = {
  ok: boolean
  status: number
  data: unknown
  stale?: boolean
}

export type GroupAuditActivityLoadResult = {
  activities: GroupAuditActivity[]
  stale: boolean
  truncated: boolean
}

type AuditRow = {
  id: string
  action: string
  actor_id: string | null
  target_id: string | null
  created_at: string
}

type AuditPage = {
  logs: AuditRow[]
  hasMore: boolean
  nextCursor: string | null
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ACTION_PATTERN = /^[a-z][a-z0-9_]{0,127}$/
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,256}$/
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const canonicalExpected = [...expected].sort()
  return (
    actual.length === canonicalExpected.length &&
    actual.every((key, index) => key === canonicalExpected[index])
  )
}

function isUuidOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && UUID_PATTERN.test(value))
}

function parseAuditRow(value: unknown): AuditRow | null {
  if (!isRecord(value)) return null
  if (!hasExactKeys(value, ['action', 'actor_id', 'created_at', 'id', 'target_id'])) return null
  if (
    typeof value.id !== 'string' ||
    !UUID_PATTERN.test(value.id) ||
    typeof value.action !== 'string' ||
    !ACTION_PATTERN.test(value.action) ||
    !isUuidOrNull(value.actor_id) ||
    !isUuidOrNull(value.target_id) ||
    typeof value.created_at !== 'string' ||
    !TIMESTAMP_PATTERN.test(value.created_at) ||
    !Number.isFinite(Date.parse(value.created_at))
  ) {
    return null
  }
  return {
    id: value.id.toLowerCase(),
    action: value.action,
    actor_id: value.actor_id?.toLowerCase() ?? null,
    target_id: value.target_id?.toLowerCase() ?? null,
    created_at: value.created_at,
  }
}

function parseAuditPage(value: unknown): AuditPage | null {
  if (!isRecord(value) || !hasExactKeys(value, ['logs', 'pagination', 'success'])) return null
  if (value.success !== true || !Array.isArray(value.logs) || !isRecord(value.pagination)) {
    return null
  }
  if (!hasExactKeys(value.pagination, ['has_more', 'limit', 'next_cursor'])) return null
  if (
    value.pagination.limit !== GROUP_AUDIT_PAGE_LIMIT ||
    typeof value.pagination.has_more !== 'boolean'
  ) {
    return null
  }
  const nextCursor = value.pagination.next_cursor
  if (
    (value.pagination.has_more &&
      (typeof nextCursor !== 'string' || !CURSOR_PATTERN.test(nextCursor))) ||
    (!value.pagination.has_more && nextCursor !== null) ||
    (value.pagination.has_more && value.logs.length === 0) ||
    value.logs.length > GROUP_AUDIT_PAGE_LIMIT
  ) {
    return null
  }
  const logs: AuditRow[] = []
  for (const valueRow of value.logs) {
    const row = parseAuditRow(valueRow)
    if (!row) return null
    logs.push(row)
  }
  return {
    logs,
    hasMore: value.pagination.has_more,
    nextCursor: typeof nextCursor === 'string' ? nextCursor : null,
  }
}

function toActivity(row: AuditRow): GroupAuditActivity {
  return {
    id: row.id,
    type: row.action,
    title: row.action,
    message: row.target_id || row.actor_id || '',
    created_at: row.created_at,
    ...(row.actor_id ? { actor_id: row.actor_id } : {}),
  }
}

export async function loadGroupAuditActivities(input: {
  fetchPage(cursor: string | null): Promise<GroupAuditPageFetchResult>
  isCurrent(): boolean
}): Promise<GroupAuditActivityLoadResult> {
  const activities: GroupAuditActivity[] = []
  const activityIds = new Set<string>()
  const cursors = new Set<string>()
  let cursor: string | null = null

  for (let pageIndex = 0; pageIndex < MAX_GROUP_AUDIT_PAGES; pageIndex += 1) {
    if (!input.isCurrent()) return { activities: [], stale: true, truncated: false }
    const result = await input.fetchPage(cursor)
    if (result.stale || !input.isCurrent()) {
      return { activities: [], stale: true, truncated: false }
    }
    if (!result.ok) throw new Error(`Group audit page failed with status ${result.status}`)

    const page = parseAuditPage(result.data)
    if (!page) throw new Error('Group audit page did not match the exact client contract')
    for (const row of page.logs) {
      if (activityIds.has(row.id)) continue
      activityIds.add(row.id)
      activities.push(toActivity(row))
    }

    if (!page.hasMore) return { activities, stale: false, truncated: false }
    if (!page.nextCursor || cursors.has(page.nextCursor)) {
      throw new Error('Group audit cursor did not advance')
    }
    cursors.add(page.nextCursor)
    cursor = page.nextCursor
  }

  return { activities, stale: false, truncated: true }
}
