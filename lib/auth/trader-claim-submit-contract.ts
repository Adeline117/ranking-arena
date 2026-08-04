export type TraderClaimSubmitMethod = 'api_key' | 'signature'

export type TraderClaimSubmitAcknowledgement = {
  claimId: string
  traderId: string
  source: string
  viewerId: string
  method: TraderClaimSubmitMethod
  status: 'reviewing'
  autoApproved: false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === expected.length && expected.every((key) => actual.includes(key))
}

function isExactIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

/**
 * Accept the claim submission response only when the entire standard API
 * envelope is exact and its authoritative receipt is bound to this operation.
 */
export function readTraderClaimSubmitAcknowledgement(
  value: unknown,
  expected: {
    traderId: string
    source: string
    viewerId: string
    method: TraderClaimSubmitMethod
  }
): TraderClaimSubmitAcknowledgement | null {
  if (!isRecord(value) || !hasExactKeys(value, ['success', 'data', 'meta'])) return null
  if (value.success !== true || !isRecord(value.data) || !isRecord(value.meta)) return null
  if (!hasExactKeys(value.meta, ['timestamp']) || !isExactIsoTimestamp(value.meta.timestamp)) {
    return null
  }
  if (
    !hasExactKeys(value.data, [
      'claimId',
      'traderId',
      'source',
      'viewerId',
      'method',
      'status',
      'autoApproved',
    ])
  ) {
    return null
  }

  const expectedTraderId = expected.traderId.trim()
  const expectedSource = expected.source.trim().toLowerCase()
  const claimId = value.data.claimId
  if (
    typeof claimId !== 'string' ||
    claimId.length < 1 ||
    claimId.length > 128 ||
    claimId.trim() !== claimId ||
    value.data.traderId !== expectedTraderId ||
    value.data.source !== expectedSource ||
    value.data.viewerId !== expected.viewerId ||
    value.data.method !== expected.method ||
    value.data.status !== 'reviewing' ||
    value.data.autoApproved !== false
  ) {
    return null
  }

  return {
    claimId,
    traderId: expectedTraderId,
    source: expectedSource,
    viewerId: expected.viewerId,
    method: expected.method,
    status: 'reviewing',
    autoApproved: false,
  }
}
