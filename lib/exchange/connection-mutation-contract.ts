type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: JsonRecord, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

export function readExchangeDisconnectAcknowledgement(
  value: unknown,
  expectedExchange: string
): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['exchange', 'success']) &&
    value.success === true &&
    value.exchange === expectedExchange
  )
}

export function readExchangeMutationError(value: unknown): string | null {
  if (!isRecord(value) || typeof value.error !== 'string') return null
  const message = value.error.trim()
  return message.length > 0 && message.length <= 200 ? message : null
}
