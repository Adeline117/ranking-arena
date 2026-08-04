const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const PUBLIC_SNAPSHOT_TOKEN_RE = /^[A-Za-z0-9_-]{6,64}$/
export const PUBLIC_SNAPSHOT_MAX_TRADERS = 100

type JsonRecord = Record<string, unknown>

export interface PublicRankingSnapshot {
  id: string
  shareToken: string
  timeRange: string
  exchange: string | null
  category: string | null
  totalTraders: number
  topTraderHandle: string
  topTraderRoi: number
  dataCapturedAt: string
  dataDelayMinutes: number | null
  viewCount: number
  expiresAt: string | null
  title: string | null
  description: string | null
  createdAt: string
  isExpired: boolean
}

export interface PublicSnapshotTrader {
  rank: number
  id: string
  handle: string | null
  source: string
  avatarUrl: string | null
  roi: number | null
  pnl: number | null
  winRate: number | null
  maxDrawdown: number | null
  tradesCount: number | null
  followers: number | null
  arenaScore: number | null
  returnScore: number | null
  drawdownScore: number | null
  stabilityScore: number | null
  dataAvailability: Record<string, boolean> | null
}

export interface PublicSnapshotMetadata {
  title: string | null
  timeRange: string
  totalTraders: number
  topTraderHandle: string
  topTraderRoi: number
  dataCapturedAt: string
  expiresAt: string | null
  isExpired: boolean
}

function fail(field: string): never {
  throw new TypeError(`Invalid public ranking snapshot ${field}`)
}

function record(value: unknown, field: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(field)
  return value as JsonRecord
}

function stringValue(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.length === 0)) {
    fail(field)
  }
  return value
}

function nullableString(value: unknown, field: string, max: number): string | null {
  if (value === null) return null
  return stringValue(value, field, max, true)
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(field)
  return value
}

function nullableFiniteNumber(value: unknown, field: string): number | null {
  if (value === null) return null
  return finiteNumber(value, field)
}

function safeInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(field)
  }
  return value as number
}

function nullableSafeInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number
): number | null {
  if (value === null) return null
  return safeInteger(value, field, minimum, maximum)
}

function timestamp(value: unknown, field: string): string {
  const parsed = stringValue(value, field, 64)
  if (!Number.isFinite(Date.parse(parsed))) fail(field)
  return parsed
}

function nullableTimestamp(value: unknown, field: string): string | null {
  if (value === null) return null
  return timestamp(value, field)
}

function booleanMap(value: unknown, field: string): Record<string, boolean> | null {
  if (value === null) return null
  const raw = record(value, field)
  const entries = Object.entries(raw)
  if (entries.length > 64) fail(field)

  const parsed: Record<string, boolean> = {}
  for (const [key, item] of entries) {
    if (key.length === 0 || key.length > 64 || typeof item !== 'boolean') fail(field)
    parsed[key] = item
  }
  return parsed
}

function readSnapshotCore(
  value: unknown,
  expectedToken: string,
  nowMs: number
): PublicRankingSnapshot {
  const raw = record(value, 'record')
  const id = stringValue(raw.id, 'id', 36)
  if (!UUID_RE.test(id)) fail('id')

  const shareToken = stringValue(raw.share_token, 'share_token', 64)
  if (shareToken !== expectedToken || !PUBLIC_SNAPSHOT_TOKEN_RE.test(shareToken)) {
    fail('share_token')
  }
  if (raw.is_public !== true) fail('is_public')
  if (raw.is_expired !== null && typeof raw.is_expired !== 'boolean') fail('is_expired')
  const expiresAt = nullableTimestamp(raw.expires_at, 'expires_at')

  return {
    id,
    shareToken,
    timeRange: stringValue(raw.time_range, 'time_range', 16),
    exchange: nullableString(raw.exchange, 'exchange', 64),
    category: nullableString(raw.category, 'category', 64),
    totalTraders: safeInteger(raw.total_traders, 'total_traders', 1, PUBLIC_SNAPSHOT_MAX_TRADERS),
    topTraderHandle: stringValue(raw.top_trader_handle, 'top_trader_handle', 300),
    topTraderRoi: finiteNumber(raw.top_trader_roi, 'top_trader_roi'),
    dataCapturedAt: timestamp(raw.data_captured_at, 'data_captured_at'),
    dataDelayMinutes: nullableSafeInteger(raw.data_delay_minutes, 'data_delay_minutes', 0, 525_600),
    viewCount:
      raw.view_count === null
        ? 0
        : safeInteger(raw.view_count, 'view_count', 0, Number.MAX_SAFE_INTEGER),
    expiresAt,
    title: nullableString(raw.title, 'title', 200),
    description: nullableString(raw.description, 'description', 2_000),
    createdAt: timestamp(raw.created_at, 'created_at'),
    isExpired: raw.is_expired === true || (expiresAt !== null && Date.parse(expiresAt) <= nowMs),
  }
}

export function parsePublicRankingSnapshot(
  value: unknown,
  expectedToken: string,
  nowMs = Date.now()
): PublicRankingSnapshot {
  if (!PUBLIC_SNAPSHOT_TOKEN_RE.test(expectedToken)) fail('expected token')
  return readSnapshotCore(value, expectedToken, nowMs)
}

export function parsePublicSnapshotMetadata(
  value: unknown,
  expectedToken: string,
  nowMs = Date.now()
): PublicSnapshotMetadata {
  const raw = record(value, 'metadata')
  const shareToken = stringValue(raw.share_token, 'share_token', 64)
  if (shareToken !== expectedToken || !PUBLIC_SNAPSHOT_TOKEN_RE.test(shareToken)) {
    fail('share_token')
  }
  if (raw.is_public !== true) fail('is_public')

  const expiresAt = nullableTimestamp(raw.expires_at, 'expires_at')
  const databaseExpired = raw.is_expired === true
  if (raw.is_expired !== null && typeof raw.is_expired !== 'boolean') fail('is_expired')

  return {
    title: nullableString(raw.title, 'title', 200),
    timeRange: stringValue(raw.time_range, 'time_range', 16),
    totalTraders: safeInteger(raw.total_traders, 'total_traders', 1, PUBLIC_SNAPSHOT_MAX_TRADERS),
    topTraderHandle: stringValue(raw.top_trader_handle, 'top_trader_handle', 300),
    topTraderRoi: finiteNumber(raw.top_trader_roi, 'top_trader_roi'),
    dataCapturedAt: timestamp(raw.data_captured_at, 'data_captured_at'),
    expiresAt,
    isExpired: databaseExpired || (expiresAt !== null && Date.parse(expiresAt) <= nowMs),
  }
}

export function parsePublicSnapshotTraders(
  value: unknown,
  expectedSnapshotId: string,
  expectedCount: number
): PublicSnapshotTrader[] {
  if (!UUID_RE.test(expectedSnapshotId)) fail('expected snapshot id')
  safeInteger(expectedCount, 'expected trader count', 1, PUBLIC_SNAPSHOT_MAX_TRADERS)
  if (!Array.isArray(value) || value.length !== expectedCount) fail('trader row count')

  const seenRanks = new Set<number>()
  const seenIdentities = new Set<string>()
  let previousRank = 0

  return value.map((item, index) => {
    const raw = record(item, `traders[${index}]`)
    if (raw.snapshot_id !== expectedSnapshotId) fail(`traders[${index}].snapshot_id`)

    const rank = safeInteger(raw.rank, `traders[${index}].rank`, 1, Number.MAX_SAFE_INTEGER)
    if (seenRanks.has(rank) || rank <= previousRank) fail(`traders[${index}].rank`)
    seenRanks.add(rank)
    previousRank = rank

    const id = stringValue(raw.trader_id, `traders[${index}].trader_id`, 500)
    const source = stringValue(raw.source, `traders[${index}].source`, 100)
    const identity = `${source}\u0000${id}`
    if (seenIdentities.has(identity)) fail(`traders[${index}].identity`)
    seenIdentities.add(identity)

    return {
      rank,
      id,
      handle: nullableString(raw.handle, `traders[${index}].handle`, 300),
      source,
      avatarUrl: nullableString(raw.avatar_url, `traders[${index}].avatar_url`, 2_048),
      roi: nullableFiniteNumber(raw.roi, `traders[${index}].roi`),
      pnl: nullableFiniteNumber(raw.pnl, `traders[${index}].pnl`),
      winRate: nullableFiniteNumber(raw.win_rate, `traders[${index}].win_rate`),
      maxDrawdown: nullableFiniteNumber(raw.max_drawdown, `traders[${index}].max_drawdown`),
      tradesCount: nullableSafeInteger(
        raw.trades_count,
        `traders[${index}].trades_count`,
        0,
        Number.MAX_SAFE_INTEGER
      ),
      followers: nullableSafeInteger(
        raw.followers,
        `traders[${index}].followers`,
        0,
        Number.MAX_SAFE_INTEGER
      ),
      arenaScore: nullableFiniteNumber(raw.arena_score, `traders[${index}].arena_score`),
      returnScore: nullableFiniteNumber(raw.return_score, `traders[${index}].return_score`),
      drawdownScore: nullableFiniteNumber(raw.drawdown_score, `traders[${index}].drawdown_score`),
      stabilityScore: nullableFiniteNumber(
        raw.stability_score,
        `traders[${index}].stability_score`
      ),
      dataAvailability: booleanMap(raw.data_availability, `traders[${index}].data_availability`),
    }
  })
}
