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
