type JsonObject = Record<string, unknown>

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function containsErrors(value: unknown): boolean {
  if (value == null) return false
  if (Array.isArray(value)) return value.length > 0
  if (isJsonObject(value)) return Object.keys(value).length > 0
  return true
}

function describePayload(value: unknown): string {
  try {
    return String(JSON.stringify(value)).slice(0, 500)
  } catch {
    return String(value).slice(0, 500)
  }
}

const LEADERBOARD_SEASONS = ['7D', '30D', '90D'] as const
const SUCCESSFUL_PUBLICATION_STATUSES = ['published', 'checkpoint_skip'] as const

function hasExactKeys(value: JsonObject, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(value).sort()
  const sortedExpectedKeys = [...expectedKeys].sort()
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  )
}

function isLeaderboardSeason(value: string): value is (typeof LEADERBOARD_SEASONS)[number] {
  return LEADERBOARD_SEASONS.includes(value as (typeof LEADERBOARD_SEASONS)[number])
}

function isSuccessfulPublicationStatus(
  value: unknown
): value is (typeof SUCCESSFUL_PUBLICATION_STATUSES)[number] {
  return SUCCESSFUL_PUBLICATION_STATUSES.includes(
    value as (typeof SUCCESSFUL_PUBLICATION_STATUSES)[number]
  )
}

/**
 * BullMQ must retry logical API failures even when the endpoint returned HTTP 200.
 * A successful sync contract is deliberately narrow: JSON `ok` is exactly true
 * and the payload does not carry any season-level errors.
 */
export function assertSuccessfulMeilisearchSyncResponse(
  httpOk: boolean,
  status: number,
  body: unknown
): asserts body is JsonObject & { ok: true } {
  if (!httpOk) {
    throw new Error(`sync-meilisearch returned ${status}`)
  }

  if (!isJsonObject(body) || body.ok !== true || containsErrors(body.errors)) {
    throw new Error(
      `sync-meilisearch returned an unsuccessful payload (${status}): ${describePayload(body)}`
    )
  }
}

/**
 * A compute request can return HTTP 200 while preserving the last-good board
 * after a degradation skip. BullMQ must reject that logical failure so its
 * retry policy remains active and the 90D completion handler cannot enqueue a
 * search sync for an unsealed generation.
 */
export function assertSuccessfulLeaderboardComputeResponse(
  httpOk: boolean,
  status: number,
  body: unknown,
  expectedSeason: string
): asserts body is JsonObject & { ok: true } {
  if (!isLeaderboardSeason(expectedSeason)) {
    throw new Error(`compute-leaderboard received an invalid expected season: ${expectedSeason}`)
  }
  if (!httpOk) {
    throw new Error(`compute-leaderboard ${expectedSeason} returned ${status}`)
  }
  if (!isJsonObject(body) || body.ok !== true) {
    throw new Error(
      `compute-leaderboard ${expectedSeason} returned an unsuccessful payload (${status}): ${describePayload(body)}`
    )
  }

  const stats = isJsonObject(body.stats) ? body.stats : null
  const seasons = stats && isJsonObject(stats.seasons) ? stats.seasons : null
  const publicationStatus = isJsonObject(body.publication_status) ? body.publication_status : null
  const publishedCount = seasons?.[expectedSeason]
  const acknowledgedStatus = publicationStatus?.[expectedSeason]
  if (
    !seasons ||
    !hasExactKeys(seasons, [expectedSeason]) ||
    !Number.isSafeInteger(publishedCount) ||
    (publishedCount as number) <= 0 ||
    !publicationStatus ||
    !hasExactKeys(publicationStatus, [expectedSeason]) ||
    !isSuccessfulPublicationStatus(acknowledgedStatus) ||
    containsErrors(body.warnings) ||
    containsErrors(body.publication_unsealed)
  ) {
    throw new Error(
      `compute-leaderboard ${expectedSeason} returned an incomplete publication acknowledgement (${status}): ${describePayload(body)}`
    )
  }
}
