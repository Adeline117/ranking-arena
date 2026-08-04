type JsonRecord = Record<string, unknown>

export type VerifiedCheckoutSession =
  | { kind: 'lifetime'; status: 'active' }
  | { kind: 'recurring'; status: 'active' | 'trialing'; subscriptionId: string }

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: JsonRecord, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

export function readVerifiedCheckoutSession(value: unknown): VerifiedCheckoutSession | null {
  if (!isRecord(value) || value.success !== true || value.tier !== 'pro') return null

  if (
    hasExactKeys(value, ['plan', 'status', 'success', 'tier']) &&
    value.plan === 'lifetime' &&
    value.status === 'active'
  ) {
    return { kind: 'lifetime', status: 'active' }
  }

  if (
    hasExactKeys(value, ['status', 'subscriptionId', 'success', 'tier']) &&
    (value.status === 'active' || value.status === 'trialing') &&
    typeof value.subscriptionId === 'string' &&
    /^sub_[A-Za-z0-9]{1,240}$/.test(value.subscriptionId)
  ) {
    return {
      kind: 'recurring',
      status: value.status,
      subscriptionId: value.subscriptionId,
    }
  }

  return null
}
