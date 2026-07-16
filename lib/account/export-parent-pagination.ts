import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type CursorExportDataset,
  DataExportReadError,
  DataExportTooLargeError,
  fetchAllExportRowsByCursor,
  MAX_EXPORT_ROWS_PER_DATASET,
  validateCursorExportDataset,
} from './export-pagination'

export const MAX_EXPORT_PARENT_KEYS = 10_000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function normalizeParentIds(datasetName: string, parentIds: readonly string[]): string[] {
  if (!Array.isArray(parentIds)) {
    throw new DataExportReadError(datasetName, new Error('Parent keys must be an array'))
  }
  if (parentIds.length > MAX_EXPORT_PARENT_KEYS) {
    throw new DataExportTooLargeError(datasetName)
  }

  const normalized = parentIds.map((parentId) => {
    if (typeof parentId !== 'string' || !UUID.test(parentId)) {
      throw new DataExportReadError(datasetName, new Error('Invalid UUID parent key'))
    }
    return parentId.toLowerCase()
  })
  if (new Set(normalized).size !== normalized.length) {
    throw new DataExportReadError(datasetName, new Error('Duplicate UUID parent key'))
  }
  return normalized.sort()
}

/**
 * Read a child dataset only through an already owner-verified list of UUID
 * parents. The synchronous row cap is shared across every parent rather than
 * being reset for each child query.
 */
export async function fetchAllExportRowsForUuidParents(
  supabase: SupabaseClient,
  dataset: CursorExportDataset,
  parentIds: readonly string[]
): Promise<Record<string, unknown>[]> {
  validateCursorExportDataset(dataset)
  const parentColumn = dataset.ownerPredicate.column
  if (
    dataset.ownerPredicate.operator !== 'eq' ||
    dataset.ownerPredicate.valueType !== 'uuid' ||
    !dataset.selectColumns.includes(parentColumn)
  ) {
    throw new DataExportReadError(
      dataset.name,
      new Error('Child exports must select their UUID parent equality column')
    )
  }

  const normalizedParentIds = normalizeParentIds(dataset.name, parentIds)
  const rows: Record<string, unknown>[] = []

  for (const parentId of normalizedParentIds) {
    const parentRows = await fetchAllExportRowsByCursor(supabase, dataset, parentId)
    if (rows.length + parentRows.length > MAX_EXPORT_ROWS_PER_DATASET) {
      throw new DataExportTooLargeError(dataset.name)
    }

    for (const row of parentRows) {
      const returnedParent = row[parentColumn]
      if (
        typeof returnedParent !== 'string' ||
        !UUID.test(returnedParent) ||
        returnedParent.toLowerCase() !== parentId
      ) {
        throw new DataExportReadError(dataset.name, new Error('Child row escaped its parent key'))
      }
      rows.push(row)
    }
  }

  return rows
}
