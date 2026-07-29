import { isDexWalletPlatform } from '@/lib/constants/wallet-platforms'
import { canonicalizeWalletIdentity } from '@/lib/validators/wallet-identity'

export interface LinkedTrader {
  id: string
  user_id: string
  trader_id: string
  source: string
  label: string | null
  is_primary: boolean
  verified_at: string
  verification_method: string
  /** Performance data is not authorized on this management boundary. */
  stats: null
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function exactString(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim()
    ? value
    : null
}

function validTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  )
}

function parseLinkedTrader(value: unknown, expectedUserId: string): LinkedTrader | null {
  const row = recordOrNull(value)
  if (!row || row.stats !== null) return null

  const id = exactString(row.id, 64)
  const traderId = exactString(row.trader_id, 512)
  const source = exactString(row.source, 64)
  const verificationMethod = exactString(row.verification_method, 64)
  const label = row.label === null ? null : exactString(row.label, 50)
  const labelIsValid = row.label === null || label !== null

  if (
    !id ||
    !UUID_PATTERN.test(id) ||
    row.user_id !== expectedUserId ||
    !traderId ||
    !source ||
    !verificationMethod ||
    !labelIsValid ||
    typeof row.is_primary !== 'boolean' ||
    !validTimestamp(row.verified_at)
  ) {
    return null
  }

  return {
    id,
    user_id: expectedUserId,
    trader_id: traderId,
    source,
    label,
    is_primary: row.is_primary,
    verified_at: row.verified_at,
    verification_method: verificationMethod,
    stats: null,
  }
}

function identityKey(trader: LinkedTrader): string {
  const traderId = isDexWalletPlatform(trader.source)
    ? canonicalizeWalletIdentity(trader.trader_id, trader.source)
    : trader.trader_id
  return `${trader.source}:${traderId}`
}

/** Rebuild the exact owner-private management DTO from an untrusted response. */
export function parseLinkedTraderManagementPayload(
  value: unknown,
  expectedUserId: string
): LinkedTrader[] | null {
  const payload = recordOrNull(value)
  if (!payload || !Array.isArray(payload.linked_traders)) return null
  if (!Number.isInteger(payload.count) || payload.count !== payload.linked_traders.length)
    return null

  const traders = payload.linked_traders.map((row) => parseLinkedTrader(row, expectedUserId))
  if (!traders.every((trader): trader is LinkedTrader => trader !== null)) return null

  if (new Set(traders.map((trader) => trader.id)).size !== traders.length) return null
  if (new Set(traders.map(identityKey)).size !== traders.length) return null
  if (traders.length > 0 && traders.filter((trader) => trader.is_primary).length !== 1) return null

  return traders
}
