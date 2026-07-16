import type { SupabaseClient } from '@supabase/supabase-js'

export const EXPORT_PAGE_SIZE = 1_000
export const MAX_EXPORT_ROWS_PER_DATASET = 250_000

export type ExportDataset = Readonly<{
  name: string
  table: string
  ownerColumn: string
}>

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

  for (;;) {
    let query = supabase
      .from(dataset.table)
      .select('*')
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
      rows.push(row)
      nextCursor = row.id
    }

    if (nextCursor === cursor) {
      throw new DataExportReadError(dataset.name, new Error('Pagination cursor did not advance'))
    }
    cursor = nextCursor
  }
}
