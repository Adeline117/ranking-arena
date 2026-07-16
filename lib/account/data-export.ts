import type { SupabaseClient } from '@supabase/supabase-js'
import {
  DataExportReadError,
  fetchAllExportRowsByCursor as fetchCursorRows,
} from './export-pagination'
import { validateExportColumns } from './export-safety'

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

export {
  fetchAllExportRowsForUuidParents,
  MAX_EXPORT_PARENT_KEYS,
} from './export-parent-pagination'

export type ExportDataset = Readonly<{
  name: string
  table: string
  ownerColumn: string
  selectColumns: readonly string[]
}>

function getSelectColumns(
  datasetName: string,
  selectColumns: readonly string[]
): readonly string[] {
  try {
    return validateExportColumns(selectColumns, { requireId: true })
  } catch (error) {
    throw new DataExportReadError(datasetName, error)
  }
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
