import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 24 * 60 * 60 * 1000

type UsageKey = { id: string; name: string }
type DailyUsage = { api_key_id: string; date: string; request_count: number }

function noStoreJson(body: unknown, status = 200) {
  const response = NextResponse.json(body, { status })
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}

function parseDays(value: string | null): number | null {
  if (value === null) return 30
  if (!/^[1-9]\d?$/.test(value)) return null
  const days = Number(value)
  return days >= 1 && days <= 90 ? days : null
}

function exactDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function readError() {
  return noStoreJson({ error: 'Failed to fetch API key usage' }, 500)
}

/**
 * GET /api/user/api-keys/usage?days=30
 * Returns daily usage for all of the user's API keys over the last N days.
 */
export const GET = withAuth(
  async ({ user, supabase, request }) => {
    const days = parseDays(request.nextUrl.searchParams.get('days'))
    if (days === null) {
      return noStoreJson({ error: 'days must be an integer between 1 and 90' }, 400)
    }

    const today = new Date().toISOString().slice(0, 10)
    const todayUtc = new Date(`${today}T00:00:00.000Z`)
    const since = new Date(todayUtc.getTime() - (days - 1) * DAY_MS).toISOString().slice(0, 10)

    // Get user's key IDs
    const { data: rawKeys, error: keysError } = await supabase
      .from('api_keys')
      .select('id, user_id, name')
      .eq('user_id', user!.id)

    if (keysError || !Array.isArray(rawKeys)) return readError()

    const keys: UsageKey[] = []
    const keyIds = new Set<string>()
    for (const value of rawKeys) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return readError()
      const row = value as Record<string, unknown>
      if (
        typeof row.id !== 'string' ||
        !UUID_PATTERN.test(row.id) ||
        row.user_id !== user!.id ||
        keyIds.has(row.id) ||
        typeof row.name !== 'string' ||
        row.name !== row.name.trim() ||
        row.name.length < 1 ||
        row.name.length > 50
      ) {
        return readError()
      }
      keyIds.add(row.id)
      keys.push({ id: row.id, name: row.name })
    }

    if (keys.length === 0) {
      return noStoreJson({ data: { keys: [], daily: [], totals: {} } })
    }

    const keyIdList = keys.map((key) => key.id)

    // Fetch daily usage
    const { data: rawDaily, error: dailyError } = await supabase
      .from('api_key_usage_daily')
      .select('api_key_id, date, request_count')
      .in('api_key_id', keyIdList)
      .gte('date', since)
      .order('date', { ascending: true })

    if (dailyError || !Array.isArray(rawDaily)) return readError()

    const daily: DailyUsage[] = []
    const dailyIdentities = new Set<string>()
    for (const value of rawDaily) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return readError()
      const row = value as Record<string, unknown>
      const identity = `${String(row.api_key_id)}\u0000${String(row.date)}`
      if (
        typeof row.api_key_id !== 'string' ||
        !keyIds.has(row.api_key_id) ||
        !exactDate(row.date) ||
        row.date < since ||
        row.date > today ||
        typeof row.request_count !== 'number' ||
        !Number.isSafeInteger(row.request_count) ||
        row.request_count < 0 ||
        dailyIdentities.has(identity)
      ) {
        return readError()
      }
      dailyIdentities.add(identity)
      daily.push({
        api_key_id: row.api_key_id,
        date: row.date,
        request_count: row.request_count,
      })
    }

    // Also include today's live counts from api_keys.request_count_today
    const { data: rawLiveKeys, error: liveKeysError } = await supabase
      .from('api_keys')
      .select('id, user_id, request_count_today')
      .in('id', keyIdList)

    if (liveKeysError || !Array.isArray(rawLiveKeys) || rawLiveKeys.length !== keys.length) {
      return readError()
    }

    const seenLiveIds = new Set<string>()
    const todayEntries: DailyUsage[] = []
    for (const value of rawLiveKeys) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return readError()
      const row = value as Record<string, unknown>
      if (
        typeof row.id !== 'string' ||
        !keyIds.has(row.id) ||
        row.user_id !== user!.id ||
        seenLiveIds.has(row.id) ||
        typeof row.request_count_today !== 'number' ||
        !Number.isSafeInteger(row.request_count_today) ||
        row.request_count_today < 0
      ) {
        return readError()
      }
      seenLiveIds.add(row.id)
      if (row.request_count_today > 0) {
        todayEntries.push({
          api_key_id: row.id,
          date: today,
          request_count: row.request_count_today,
        })
      }
    }
    if (seenLiveIds.size !== keyIds.size) return readError()

    const allDaily = [...daily]
    for (const entry of todayEntries) {
      const existing = allDaily.find(
        (row) => row.api_key_id === entry.api_key_id && row.date === entry.date
      )
      if (existing) {
        existing.request_count = Math.max(existing.request_count, entry.request_count)
      } else {
        allDaily.push({
          api_key_id: entry.api_key_id,
          date: today,
          request_count: entry.request_count,
        })
      }
    }
    allDaily.sort((left, right) =>
      left.date === right.date
        ? left.api_key_id.localeCompare(right.api_key_id)
        : left.date.localeCompare(right.date)
    )

    // Compute totals per key
    const totals: Record<string, number> = {}
    for (const row of allDaily) {
      const total = (totals[row.api_key_id] || 0) + row.request_count
      if (!Number.isSafeInteger(total)) return readError()
      totals[row.api_key_id] = total
    }

    return noStoreJson({
      data: {
        keys,
        daily: allDaily,
        totals,
      },
    })
  },
  { name: 'api-keys-usage', rateLimit: 'authenticated' }
)
