function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function parseProfileUpdateAcknowledgement(value: unknown, traderKey: string): number {
  if (!Array.isArray(value) || value.length > 1) {
    throw new Error('Profile conditional update returned an invalid acknowledgement')
  }

  if (value.length === 0) return 0

  const row = value[0]
  if (
    !isPlainRecord(row) ||
    Object.keys(row).length !== 1 ||
    typeof row.trader_key !== 'string' ||
    row.trader_key !== traderKey
  ) {
    throw new Error('Profile conditional update returned an invalid acknowledgement')
  }

  return 1
}
