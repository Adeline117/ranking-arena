export interface DigestFollowRow {
  user_id: string
  trader_id: string
  source: string | null
}

export interface DigestActivityRow {
  id: string
  source_trader_id: string
  source: string
  handle: string | null
  activity_text: string
  occurred_at: string
}

interface PageError {
  message: string
}

export async function readAllPages<T>(
  loadPage: (
    from: number,
    to: number
  ) => PromiseLike<{ data: T[] | null; error: PageError | null }>,
  pageSize = 1000
): Promise<{ data: T[]; error: PageError | null }> {
  const data: T[] = []
  for (let offset = 0; ; offset += pageSize) {
    const page = await loadPage(offset, offset + pageSize - 1)
    if (page.error) return { data: [], error: page.error }
    const rows = page.data ?? []
    data.push(...rows)
    if (rows.length < pageSize) return { data, error: null }
  }
}

function accountKey(traderId: string, source: string): string {
  return JSON.stringify([traderId, source])
}

export function indexDigestFollows(rows: DigestFollowRow[]): {
  followsByUser: Map<string, Set<string>>
  accountsBySource: Map<string, Set<string>>
} {
  const followsByUser = new Map<string, Set<string>>()
  const accountsBySource = new Map<string, Set<string>>()

  for (const row of rows) {
    const userId = row.user_id?.trim()
    const traderId = row.trader_id?.trim()
    const source = row.source?.trim()
    // Composite migration leaves only ambiguous/unresolved historical edges
    // as NULL. Never guess which exchange account they meant.
    if (!userId || !traderId || !source) continue

    const identities = followsByUser.get(userId) ?? new Set<string>()
    identities.add(accountKey(traderId, source))
    followsByUser.set(userId, identities)

    const sourceIds = accountsBySource.get(source) ?? new Set<string>()
    sourceIds.add(traderId)
    accountsBySource.set(source, sourceIds)
  }

  return { followsByUser, accountsBySource }
}

export function indexDigestActivities(rows: DigestActivityRow[]): Map<string, DigestActivityRow[]> {
  const result = new Map<string, DigestActivityRow[]>()
  for (const row of rows) {
    if (!row.source_trader_id || !row.source) continue
    const key = accountKey(row.source_trader_id, row.source)
    const activities = result.get(key) ?? []
    activities.push(row)
    result.set(key, activities)
  }
  return result
}

export function buildFollowedDigestActivity(
  userId: string,
  followsByUser: Map<string, Set<string>>,
  activityByAccount: Map<string, DigestActivityRow[]>
): Array<{ name: string; summary: string; link: string }> {
  const accountKeys = followsByUser.get(userId)
  if (!accountKeys?.size) return []

  const entries: Array<{
    name: string
    summary: string
    link: string
    occurredAt: string
  }> = []
  for (const key of accountKeys) {
    const activities = activityByAccount.get(key)
    if (!activities?.length) continue
    const ordered = [...activities].sort(
      (left, right) =>
        Date.parse(right.occurred_at) - Date.parse(left.occurred_at) ||
        right.id.localeCompare(left.id)
    )
    const top = ordered[0]
    const name = top.handle || top.source_trader_id
    const extra = ordered.length > 1 ? ` (+${ordered.length - 1} more this week)` : ''
    entries.push({
      name,
      summary: `${top.activity_text}${extra}`,
      link: `/trader/${encodeURIComponent(name)}?platform=${encodeURIComponent(top.source)}`,
      occurredAt: top.occurred_at,
    })
  }

  entries.sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))
  return entries.slice(0, 8).map(({ name, summary, link }) => ({ name, summary, link }))
}
