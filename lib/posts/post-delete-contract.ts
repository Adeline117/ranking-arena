type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Accept only the exact acknowledgement emitted by the canonical delete route. */
export function readPostDeleteAcknowledgement(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    Object.prototype.hasOwnProperty.call(value, 'success') &&
    value.success === true
  )
}

/** Keep server error text bounded before displaying it in a toast. */
export function readPostDeleteError(value: unknown): string | null {
  if (!isRecord(value) || typeof value.error !== 'string') return null
  const message = value.error.trim()
  return message.length > 0 && message.length <= 200 ? message : null
}
