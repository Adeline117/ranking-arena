export type TraderFollowAcknowledgement = Readonly<{
  following: boolean
  traderId: string
  source: string | null
  tableNotFound: boolean
}>

type ExpectedTraderFollowAcknowledgement = Readonly<{
  traderId: string
  source: string | null
  following?: boolean
  allowTableNotFound?: boolean
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const canonical = [...expected].sort()
  return (
    actual.length === canonical.length && actual.every((key, index) => key === canonical[index])
  )
}

/**
 * Read only the middleware envelope for the exact exchange account requested.
 * A table-missing receipt is a GET-only degraded state and must be explicitly
 * enabled by the caller; mutation callers fail closed on that shape.
 */
export function readTraderFollowAcknowledgement(
  value: unknown,
  expected: ExpectedTraderFollowAcknowledgement
): TraderFollowAcknowledgement | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['data', 'success']) ||
    value.success !== true ||
    !isRecord(value.data)
  ) {
    return null
  }

  const data = value.data
  const tableNotFound = Object.hasOwn(data, 'tableNotFound')
  if (
    !hasExactKeys(
      data,
      tableNotFound
        ? ['following', 'source', 'tableNotFound', 'traderId']
        : ['following', 'source', 'traderId']
    ) ||
    typeof data.following !== 'boolean' ||
    typeof data.traderId !== 'string' ||
    (data.source !== null && typeof data.source !== 'string') ||
    data.traderId !== expected.traderId ||
    data.source !== expected.source ||
    (expected.following !== undefined && data.following !== expected.following) ||
    (tableNotFound &&
      (expected.allowTableNotFound !== true ||
        data.tableNotFound !== true ||
        data.following !== false))
  ) {
    return null
  }

  return {
    following: data.following,
    traderId: data.traderId,
    source: data.source,
    tableNotFound,
  }
}
