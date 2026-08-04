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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isSyncStats(value: unknown, expectedTradesCount: number): boolean {
  if (!isRecord(value)) return false

  const keys = Object.keys(value).sort()
  const baseKeys = ['avgLoss', 'avgProfit', 'profitableTradesPct', 'totalTrades', 'tradesPerWeek']
  const datedKeys = ['activeSince', ...baseKeys].sort()
  const shapeMatches =
    (keys.length === baseKeys.length && keys.every((key, index) => key === baseKeys[index])) ||
    (keys.length === datedKeys.length && keys.every((key, index) => key === datedKeys[index]))
  if (!shapeMatches) return false

  if (
    !Number.isSafeInteger(value.totalTrades) ||
    value.totalTrades !== expectedTradesCount ||
    !isFiniteNumber(value.avgProfit) ||
    !isFiniteNumber(value.avgLoss) ||
    !isFiniteNumber(value.profitableTradesPct) ||
    value.profitableTradesPct < 0 ||
    value.profitableTradesPct > 100 ||
    !isFiniteNumber(value.tradesPerWeek) ||
    value.tradesPerWeek < 0
  ) {
    return false
  }

  if (!Object.prototype.hasOwnProperty.call(value, 'activeSince')) return true
  if (typeof value.activeSince !== 'string') return false
  const parsedDate = new Date(value.activeSince)
  return !Number.isNaN(parsedDate.getTime()) && parsedDate.toISOString() === value.activeSince
}

export function readExchangeSyncAcknowledgement(
  value: unknown,
  expectedExchange: string
): { tradesCount: number } | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['data', 'exchange', 'success']) ||
    value.success !== true ||
    value.exchange !== expectedExchange ||
    !isRecord(value.data) ||
    !hasExactKeys(value.data, ['message', 'stats', 'tradesCount']) ||
    value.data.message !== 'Sync successful' ||
    !Number.isSafeInteger(value.data.tradesCount) ||
    (value.data.tradesCount as number) < 0 ||
    !isSyncStats(value.data.stats, value.data.tradesCount as number)
  ) {
    return null
  }

  return { tradesCount: value.data.tradesCount as number }
}

export function readExchangeMutationError(value: unknown): string | null {
  if (!isRecord(value) || typeof value.error !== 'string') return null
  const message = value.error.trim()
  return message.length > 0 && message.length <= 200 ? message : null
}
