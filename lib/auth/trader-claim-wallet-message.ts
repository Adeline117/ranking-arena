const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SOURCE_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/
const MESSAGE_PATTERN =
  /^Arena trader claim\nUser ID: ([0-9a-f-]+)\nSource: ([a-z0-9_]+)\nTrader ID: ([^\r\n]+)\nTimestamp: (\d+)$/

export interface TraderClaimWalletMessage {
  userId: string
  source: string
  traderKey: string
  timestamp: number
}

function normalizeMessageInput(input: TraderClaimWalletMessage): TraderClaimWalletMessage {
  const userId = input.userId.trim().toLowerCase()
  const source = input.source.trim().toLowerCase()
  const traderKey = input.traderKey.trim()

  if (!USER_ID_PATTERN.test(userId)) throw new Error('Invalid trader claim user ID')
  if (!SOURCE_PATTERN.test(source)) throw new Error('Invalid trader claim source')
  if (!traderKey || traderKey.length > 512 || /[\r\n]/.test(traderKey)) {
    throw new Error('Invalid trader claim identity')
  }
  if (!Number.isSafeInteger(input.timestamp) || input.timestamp < 0) {
    throw new Error('Invalid trader claim timestamp')
  }

  return { userId, source, traderKey, timestamp: input.timestamp }
}

/**
 * Produce the exact human-readable statement a wallet signs. Binding the
 * authenticated user and source prevents a valid proof from being replayed by
 * another Arena account or against a different exchange identity.
 */
export function buildTraderClaimWalletMessage(input: TraderClaimWalletMessage): string {
  const normalized = normalizeMessageInput(input)
  return [
    'Arena trader claim',
    `User ID: ${normalized.userId}`,
    `Source: ${normalized.source}`,
    `Trader ID: ${normalized.traderKey}`,
    `Timestamp: ${normalized.timestamp}`,
  ].join('\n')
}

export function parseTraderClaimWalletMessage(message: string): TraderClaimWalletMessage | null {
  const match = MESSAGE_PATTERN.exec(message)
  if (!match) return null

  const parsed = {
    userId: match[1],
    source: match[2],
    traderKey: match[3],
    timestamp: Number(match[4]),
  }

  try {
    const normalized = normalizeMessageInput(parsed)
    return buildTraderClaimWalletMessage(normalized) === message ? normalized : null
  } catch {
    return null
  }
}
