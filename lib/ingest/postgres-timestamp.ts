const POSTGRES_CANONICAL_TIMESTAMP =
  /^(?!0000-)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/

/** Exact UTC millisecond form accepted identically by JavaScript and PostgreSQL. */
export function isCanonicalPostgresTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !POSTGRES_CANONICAL_TIMESTAMP.test(value)) return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}
