export type SeasonFreshness = {
  ageMs: number
  ageMin: number
}

export type ComputeTriggerResult = {
  season: string
  triggered: boolean
  note: string
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function parseSeasonFreshnessPayload(value: unknown, now: number): SeasonFreshness {
  if (!Array.isArray(value)) {
    throw new Error('Leaderboard freshness query returned an invalid payload')
  }

  if (value.length === 0) {
    return { ageMs: Infinity, ageMin: -1 }
  }

  const row = value[0]
  if (
    value.length !== 1 ||
    !isPlainRecord(row) ||
    Object.keys(row).length !== 1 ||
    typeof row.computed_at !== 'string'
  ) {
    throw new Error('Leaderboard freshness query returned an invalid payload')
  }

  const computedAt = Date.parse(row.computed_at)
  if (!Number.isFinite(computedAt)) {
    throw new Error('Leaderboard freshness query returned an invalid payload')
  }

  const ageMs = Math.max(0, now - computedAt)
  return { ageMs, ageMin: Math.round(ageMs / 60_000) }
}

export async function triggerSeasonCompute(
  baseUrl: string,
  secret: string,
  season: string,
  options: {
    signal?: AbortSignal
    timeoutMs?: number
    fetchImpl?: typeof fetch
  } = {}
): Promise<ComputeTriggerResult> {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 60_000)
  const requestSignal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal
  const fetchImpl = options.fetchImpl ?? fetch

  try {
    const response = await fetchImpl(
      `${baseUrl}/api/cron/compute-leaderboard?season=${encodeURIComponent(season)}`,
      {
        headers: { Authorization: `Bearer ${secret}` },
        signal: requestSignal,
      }
    )

    if (!response.ok) {
      return { season, triggered: false, note: `HTTP ${response.status}` }
    }

    const payload: unknown = await response.json().catch(() => null)
    const acknowledged =
      isPlainRecord(payload) &&
      (payload.ok === true ||
        (response.status === 202 && payload.accepted === true && payload.ok !== false))
    if (!acknowledged) {
      return {
        season,
        triggered: false,
        note: `HTTP ${response.status} invalid acknowledgement`,
      }
    }

    return { season, triggered: true, note: `HTTP ${response.status} acknowledged` }
  } catch (error) {
    const aborted = requestSignal.aborted || (error instanceof Error && error.name === 'AbortError')
    return {
      season,
      triggered: false,
      note: aborted
        ? 'request timed out or aborted'
        : `network error: ${error instanceof Error ? error.name : 'UnknownError'}`,
    }
  }
}
