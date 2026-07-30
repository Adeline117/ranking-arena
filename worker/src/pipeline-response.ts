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
      `sync-meilisearch returned an unsuccessful payload (${status}): ${JSON.stringify(body).slice(0, 500)}`
    )
  }
}

/**
 * A compute request can legitimately return HTTP 200 while refusing to
 * publish (degradation guard) or rolling a season back. BullMQ must treat
 * those payloads as failures so its retry policy remains effective. The only
 * successful skip is an exact lock conflict, where another worker owns the
 * same season computation.
 */
export function assertSuccessfulLeaderboardComputeResponse(
  httpOk: boolean,
  status: number,
  body: unknown,
  expectedSeason: string
): asserts body is JsonObject & { ok: true } {
  if (!/^(7D|30D|90D)$/.test(expectedSeason)) {
    throw new Error(`compute-leaderboard received an invalid expected season: ${expectedSeason}`)
  }
  if (!httpOk) {
    throw new Error(`compute-leaderboard ${expectedSeason} returned ${status}`)
  }
  if (!isJsonObject(body) || body.ok !== true) {
    throw new Error(
      `compute-leaderboard ${expectedSeason} returned an unsuccessful payload (${status}): ${JSON.stringify(body).slice(0, 500)}`
    )
  }

  if (body.skipped === true) {
    if (body.reason === 'concurrent season compute' && body.season === expectedSeason) return
    throw new Error(
      `compute-leaderboard ${expectedSeason} returned an invalid skip acknowledgement (${status})`
    )
  }

  const stats = isJsonObject(body.stats) ? body.stats : null
  const seasons = stats && isJsonObject(stats.seasons) ? stats.seasons : null
  const publishedCount = seasons?.[expectedSeason]
  if (
    !Number.isSafeInteger(publishedCount) ||
    (publishedCount as number) <= 0 ||
    containsErrors(body.warnings) ||
    containsErrors(body.rolled_back) ||
    containsErrors(body.empty_publications)
  ) {
    throw new Error(
      `compute-leaderboard ${expectedSeason} returned an incomplete publication acknowledgement (${status}): ${JSON.stringify(body).slice(0, 500)}`
    )
  }
}
