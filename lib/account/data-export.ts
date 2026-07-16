import type { SupabaseClient } from '@supabase/supabase-js'
import {
  DataExportReadError,
  fetchAllExportRowsByCursor as fetchCursorRows,
} from './export-pagination'

export {
  DataExportReadError,
  DataExportTooLargeError,
  EXPORT_PAGE_SIZE,
  fetchAllExportRowsByCursor,
  MAX_EXPORT_ROWS_PER_DATASET,
  type CursorExportDataset,
  type ExportCursorColumn,
  type ExportCursorValueType,
  type ExportOwnerPredicate,
} from './export-pagination'

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

function getSelectColumns(
  datasetName: string,
  selectColumns: readonly string[]
): readonly string[] {
  if (
    selectColumns.length === 0 ||
    !selectColumns.includes('id') ||
    new Set(selectColumns).size !== selectColumns.length ||
    selectColumns.some(
      (column) =>
        !SIMPLE_COLUMN_NAME.test(column) ||
        FORBIDDEN_EXPORT_COLUMNS.some((forbidden) => forbidden.test(column))
    )
  ) {
    throw new DataExportReadError(datasetName, new Error('Unsafe export column configuration'))
  }

  return selectColumns
}

export function projectExportRecord(
  datasetName: string,
  rawRow: unknown,
  requestedColumns: readonly string[]
): Record<string, unknown> {
  const selectColumns = getSelectColumns(datasetName, requestedColumns)
  if (!rawRow || typeof rawRow !== 'object' || Array.isArray(rawRow)) {
    throw new DataExportReadError(datasetName, new Error('Invalid row shape'))
  }
  const row = rawRow as Record<string, unknown>
  if (typeof row.id !== 'string' || selectColumns.some((column) => !Object.hasOwn(row, column))) {
    throw new DataExportReadError(datasetName, new Error('Incomplete selected row'))
  }

  return Object.fromEntries(selectColumns.map((column) => [column, row[column]])) as Record<
    string,
    unknown
  >
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
  return fetchCursorRows(
    supabase,
    {
      name: dataset.name,
      table: dataset.table,
      selectColumns: dataset.selectColumns,
      ownerPredicate: {
        column: dataset.ownerColumn,
        operator: 'eq',
        valueType: 'string',
      },
      cursor: {
        order: 'asc',
        columns: [{ column: 'id', valueType: 'string' }],
      },
    },
    userId
  )
}
