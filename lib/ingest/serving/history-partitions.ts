import type { PoolClient } from 'pg'
import type { HistoryKind, ParsedHistoryRow } from '../core/types'

const PARTITION_PARENT_BY_KIND = {
  orders: 'order_records',
  transfers: 'transfer_history',
  copiers: 'copier_records',
} as const

export interface HistoryPartitionRequest {
  parentTable: (typeof PARTITION_PARENT_BY_KIND)[keyof typeof PARTITION_PARENT_BY_KIND]
  timestamps: string[]
}

/**
 * Position history has a deliberately managed DEFAULT partition. The remaining
 * history tables do not: every source month must exist before their INSERT.
 */
export function historyPartitionRequest(
  kind: HistoryKind,
  rows: ParsedHistoryRow[]
): HistoryPartitionRequest | null {
  if (kind === 'position_history') return null

  const parentTable = PARTITION_PARENT_BY_KIND[kind]
  const timestamps: string[] = []

  for (const row of rows) {
    if (row.kind !== kind || !('ts' in row)) {
      throw new Error(`history row kind does not match ${kind}`)
    }
    const epochMs = Date.parse(row.ts)
    if (!Number.isFinite(epochMs)) {
      throw new Error(`history row has an invalid ${kind} timestamp`)
    }
    timestamps.push(new Date(epochMs).toISOString())
  }

  if (timestamps.length === 0) {
    throw new Error(`history batch ${kind} has no partition timestamps`)
  }

  return { parentTable, timestamps }
}

export async function ensureHistoryPartitions(
  client: Pick<PoolClient, 'query'>,
  kind: HistoryKind,
  rows: ParsedHistoryRow[]
): Promise<number> {
  const request = historyPartitionRequest(kind, rows)
  if (!request) return 0

  const result = await client.query<{ ensure_history_partitions: number }>(
    'SELECT arena.ensure_history_partitions($1, $2::timestamptz[])',
    [request.parentTable, request.timestamps]
  )
  return result.rows[0]?.ensure_history_partitions ?? 0
}
