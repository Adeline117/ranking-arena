export const VERIFY_OWNERSHIP_MAX_PLATFORM_LENGTH = 64
export const VERIFY_OWNERSHIP_MAX_VALUE_LENGTH = 512
export const VERIFY_OWNERSHIP_MAX_REQUEST_BYTES = 4 * 1024

const SOURCE_CONTRACT = {
  binance: { exchange: 'binance', requiresPassphrase: false },
  binance_futures: { exchange: 'binance', requiresPassphrase: false },
  binance_spot: { exchange: 'binance', requiresPassphrase: false },
  bybit: { exchange: 'bybit', requiresPassphrase: false },
  bybit_spot: { exchange: 'bybit', requiresPassphrase: false },
  okx: { exchange: 'okx', requiresPassphrase: true },
  okx_futures: { exchange: 'okx', requiresPassphrase: true },
  okx_spot: { exchange: 'okx', requiresPassphrase: true },
  bitget: { exchange: 'bitget', requiresPassphrase: true },
  bitget_futures: { exchange: 'bitget', requiresPassphrase: true },
  bitget_spot: { exchange: 'bitget', requiresPassphrase: true },
} as const

export const VERIFY_OWNERSHIP_SOURCES = Object.keys(SOURCE_CONTRACT) as [
  keyof typeof SOURCE_CONTRACT,
  ...(keyof typeof SOURCE_CONTRACT)[],
]

export type VerifyOwnershipSource = keyof typeof SOURCE_CONTRACT

export function readVerifyOwnershipSource(value: unknown): VerifyOwnershipSource | null {
  if (typeof value !== 'string' || value.length > VERIFY_OWNERSHIP_MAX_PLATFORM_LENGTH) return null
  const normalized = value.trim().toLowerCase()
  return Object.hasOwn(SOURCE_CONTRACT, normalized) ? (normalized as VerifyOwnershipSource) : null
}

export function verifyOwnershipConnectionExchange(source: VerifyOwnershipSource): string {
  return SOURCE_CONTRACT[source].exchange
}

export function verifyOwnershipSourceRequiresPassphrase(source: string): boolean {
  const normalized = readVerifyOwnershipSource(source)
  return normalized ? SOURCE_CONTRACT[normalized].requiresPassphrase : false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expectedKeys.length && expectedKeys.every((key) => keys.includes(key))
}

export function readVerifyOwnershipAcknowledgement(
  value: unknown,
  expected: { source: string; traderId: string; userId: string }
): string | null {
  const source = readVerifyOwnershipSource(expected.source)
  const traderId = expected.traderId.trim()
  if (!source || !traderId || traderId.length > VERIFY_OWNERSHIP_MAX_VALUE_LENGTH) return null
  if (!isRecord(value) || !hasExactKeys(value, ['success', 'verified', 'uid', 'data', 'message'])) {
    return null
  }
  if (
    value.success !== true ||
    value.verified !== true ||
    value.message !== 'Account ownership verified successfully' ||
    value.uid !== traderId ||
    !isRecord(value.data) ||
    !hasExactKeys(value.data, ['viewerId', 'exchange', 'source', 'traderId', 'verifiedUid'])
  ) {
    return null
  }
  if (
    value.data.viewerId !== expected.userId ||
    value.data.exchange !== verifyOwnershipConnectionExchange(source) ||
    value.data.source !== source ||
    value.data.traderId !== traderId ||
    value.data.verifiedUid !== traderId
  ) {
    return null
  }
  return traderId
}
