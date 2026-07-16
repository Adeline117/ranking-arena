import type { SupabaseClient } from '@supabase/supabase-js'

export const EXPORT_PAGE_SIZE = 1_000
export const MAX_EXPORT_ROWS_PER_DATASET = 250_000

export type ExportDataset = Readonly<{
  name: string
  table: string
  ownerColumn: string
  selectColumns: readonly string[]
}>

const SIMPLE_COLUMN_NAME = /^[a-z_][a-z0-9_]*$/i
const FORBIDDEN_EXPORT_COLUMNS = [
  /(^|_)stripe(_|$)/i,
  /(^|_)(token|secret|password|credential)(_|$)/i,
  /(^|_)api_key(_|$)/i,
  /_encrypted$/i,
  /^(key|code_hash|token_hash|code_verifier|payment_reference)$/i,
  /^(payment_intent_id|checkout_session_id|invoice_id|customer_id)$/i,
  /^(public_key|private_key|auth|p256dh|endpoint|device_id|verification_data)$/i,
  /^(signup_ip_hash|attempt_count|baseline_version)$/i,
  /^(deleted_by|banned_by|muted_by|reviewed_by|resolved_by|issued_by)$/i,
  /^(anonymous_id_hash|session_id_hash|last_error|verification_error|error_message)$/i,
]

export class DataExportReadError extends Error {
  constructor(
    readonly dataset: string,
    readonly causeValue: unknown
  ) {
    super(`Failed to read export dataset: ${dataset}`)
    this.name = 'DataExportReadError'
  }
}

export class DataExportTooLargeError extends Error {
  constructor(readonly dataset: string) {
    super(`Export dataset exceeds the synchronous export limit: ${dataset}`)
    this.name = 'DataExportTooLargeError'
  }
}

function getSelectColumns(dataset: ExportDataset): readonly string[] {
  if (
    dataset.selectColumns.length === 0 ||
    !dataset.selectColumns.includes('id') ||
    new Set(dataset.selectColumns).size !== dataset.selectColumns.length ||
    dataset.selectColumns.some(
      (column) =>
        !SIMPLE_COLUMN_NAME.test(column) ||
        FORBIDDEN_EXPORT_COLUMNS.some((forbidden) => forbidden.test(column))
    )
  ) {
    throw new DataExportReadError(dataset.name, new Error('Unsafe export column configuration'))
  }

  return dataset.selectColumns
}

/**
 * Read one complete dataset with an id keyset. An extra empty page is
 * intentional: PostgREST may enforce a lower server-side page size than the
 * requested limit, so a short non-empty page is not proof of completion.
 */
export async function fetchAllExportRows(
  supabase: SupabaseClient,
  dataset: ExportDataset,
  userId: string
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = []
  let cursor: string | null = null
  const selectColumns = getSelectColumns(dataset)
  const selection = selectColumns.join(',')

  for (;;) {
    let query = supabase
      .from(dataset.table)
      .select(selection)
      .eq(dataset.ownerColumn, userId)
      .order('id', { ascending: true })
      .limit(EXPORT_PAGE_SIZE)

    if (cursor !== null) query = query.gt('id', cursor)

    const { data, error } = await query
    if (error || !Array.isArray(data)) {
      throw new DataExportReadError(dataset.name, error)
    }
    if (data.length === 0) return rows
    if (rows.length + data.length > MAX_EXPORT_ROWS_PER_DATASET) {
      throw new DataExportTooLargeError(dataset.name)
    }

    let nextCursor: string | null = cursor
    for (const rawRow of data as unknown[]) {
      if (!rawRow || typeof rawRow !== 'object' || Array.isArray(rawRow)) {
        throw new DataExportReadError(dataset.name, new Error('Invalid row shape'))
      }
      const row = rawRow as Record<string, unknown>
      if (typeof row.id !== 'string' || (nextCursor !== null && row.id <= nextCursor)) {
        throw new DataExportReadError(dataset.name, new Error('Non-monotonic row id'))
      }
      if (selectColumns.some((column) => !Object.hasOwn(row, column))) {
        throw new DataExportReadError(dataset.name, new Error('Incomplete selected row'))
      }

      // Project again at the trust boundary. Even if a mock, proxy, or future
      // PostgREST behavior returns extra fields, the export cannot widen beyond
      // the reviewed allowlist.
      rows.push(
        Object.fromEntries(selectColumns.map((column) => [column, row[column]])) as Record<
          string,
          unknown
        >
      )
      nextCursor = row.id
    }

    if (nextCursor === cursor) {
      throw new DataExportReadError(dataset.name, new Error('Pagination cursor did not advance'))
    }
    cursor = nextCursor
  }
}
