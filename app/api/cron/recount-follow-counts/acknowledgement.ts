export function parseFollowRecountAcknowledgement(value: unknown): number {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error('Follow-count recount returned an invalid acknowledgement')
  }
  const row = value[0]
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('Follow-count recount returned an invalid acknowledgement')
  }
  const keys = Object.keys(row)
  const updatedCount = (row as Record<string, unknown>).updated_count
  if (
    keys.length !== 1 ||
    keys[0] !== 'updated_count' ||
    typeof updatedCount !== 'number' ||
    !Number.isSafeInteger(updatedCount) ||
    updatedCount < 0
  ) {
    throw new Error('Follow-count recount returned an invalid acknowledgement')
  }
  return updatedCount
}
