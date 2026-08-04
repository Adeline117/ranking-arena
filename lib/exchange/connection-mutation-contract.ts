import type { ExchangeConnection } from './index'
import { API_KEY_CONNECTION_PLATFORMS } from './read-only-platforms'

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

export function readExchangeConnectAcknowledgement(
  value: unknown,
  expectedUserId: string,
  expectedExchange: string
): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['data', 'success']) &&
    value.success === true &&
    isRecord(value.data) &&
    hasExactKeys(value.data, ['exchange', 'viewerId']) &&
    value.data.viewerId === expectedUserId &&
    value.data.exchange === expectedExchange
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

const currentConnectionExchanges = new Set<string>(API_KEY_CONNECTION_PLATFORMS)
const syncStatuses = new Set(['success', 'error', 'pending'])
const isoTimestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    isoTimestampPattern.test(value) &&
    Number.isFinite(Date.parse(value))
  )
}

function isNullableIsoTimestamp(value: unknown): value is string | null {
  return value === null || isIsoTimestamp(value)
}

function isNullableBoundedString(value: unknown, maximumLength: number): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= maximumLength)
}

function isExchangeConnectionRow(value: unknown, expectedUserId: string): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'created_at',
      'exchange',
      'id',
      'is_active',
      'last_sync_at',
      'last_sync_error',
      'last_sync_status',
      'updated_at',
      'user_id',
    ]) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.length <= 64 &&
    value.user_id === expectedUserId &&
    typeof value.exchange === 'string' &&
    currentConnectionExchanges.has(value.exchange) &&
    typeof value.is_active === 'boolean' &&
    isNullableIsoTimestamp(value.last_sync_at) &&
    (value.last_sync_status === null ||
      (typeof value.last_sync_status === 'string' && syncStatuses.has(value.last_sync_status))) &&
    isNullableBoundedString(value.last_sync_error, 500) &&
    isIsoTimestamp(value.created_at) &&
    isIsoTimestamp(value.updated_at)
  )
}

export function readExchangeConnectionsAcknowledgement(
  value: unknown,
  expectedUserId: string
): ExchangeConnection[] | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['data', 'meta', 'success']) ||
    value.success !== true ||
    !isRecord(value.meta) ||
    !hasExactKeys(value.meta, ['timestamp']) ||
    !isIsoTimestamp(value.meta.timestamp) ||
    !isRecord(value.data) ||
    !hasExactKeys(value.data, ['connections']) ||
    !Array.isArray(value.data.connections) ||
    value.data.connections.length > currentConnectionExchanges.size ||
    value.data.connections.some(
      (connection) => !isExchangeConnectionRow(connection, expectedUserId)
    )
  ) {
    return null
  }

  const exchanges = value.data.connections.map((connection) => (connection as JsonRecord).exchange)
  if (new Set(exchanges).size !== exchanges.length) return null

  return value.data.connections as ExchangeConnection[]
}

export function readExchangeMutationError(value: unknown): string | null {
  if (!isRecord(value) || typeof value.error !== 'string') return null
  const message = value.error.trim()
  return message.length > 0 && message.length <= 200 ? message : null
}
