import type { SupabaseClient } from '@supabase/supabase-js'
import { validateExportColumns } from './export-safety'

export const EXPORT_PAGE_SIZE = 1_000
export const MAX_EXPORT_ROWS_PER_DATASET = 250_000

export type ExportCursorValueType = 'string' | 'uuid' | 'bigint' | 'timestamp'

export type ExportOwnerPredicate = Readonly<{
  column: string
  operator: 'eq'
  valueType: ExportCursorValueType
}>

export type ExportCursorColumn = Readonly<{
  column: string
  valueType: ExportCursorValueType
}>

export type CursorExportDataset = Readonly<{
  name: string
  table: string
  selectColumns: readonly string[]
  textCastColumns?: readonly string[]
  ownerPredicate: ExportOwnerPredicate
  cursor: Readonly<{
    order: 'asc'
    columns: readonly ExportCursorColumn[]
  }>
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

const SIMPLE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CANONICAL_BIGINT = /^-?(?:0|[1-9][0-9]*)$/
const UNQUOTED_POSTGREST_VALUE = /^[a-z0-9_-]+$/i
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/
const POSTGRES_BIGINT_MIN = -(1n << 63n)
const POSTGRES_BIGINT_MAX = (1n << 63n) - 1n

const VALUE_TYPES = new Set<ExportCursorValueType>(['string', 'uuid', 'bigint', 'timestamp'])

type NormalizedCursorValue = Readonly<{
  wireValue: string
  comparable: string | bigint
  projectedValue: string
  valueType: ExportCursorValueType
}>

type ValidatedDataset = Readonly<{
  name: string
  table: string
  selectColumns: readonly string[]
  selection: string
  textCastColumns: readonly string[]
  ownerPredicate: ExportOwnerPredicate
  cursorColumns: readonly ExportCursorColumn[]
}>

function invalidConfiguration(dataset: string, message: string): never {
  throw new DataExportReadError(dataset, new Error(message))
}

function validateColumnName(dataset: string, column: unknown, purpose: string): string {
  if (typeof column !== 'string' || !SIMPLE_IDENTIFIER.test(column)) {
    invalidConfiguration(dataset, `Unsafe ${purpose} column configuration`)
  }
  return column
}

function validateValueType(
  dataset: string,
  valueType: unknown,
  purpose: string
): ExportCursorValueType {
  if (typeof valueType !== 'string' || !VALUE_TYPES.has(valueType as ExportCursorValueType)) {
    invalidConfiguration(dataset, `Unsafe ${purpose} value type configuration`)
  }
  return valueType as ExportCursorValueType
}

function validateDataset(dataset: CursorExportDataset): ValidatedDataset {
  const candidate = dataset as Partial<CursorExportDataset> | null | undefined
  const name =
    typeof candidate?.name === 'string' && candidate.name.trim() ? candidate.name : 'unknown'

  if (
    !candidate ||
    typeof candidate.table !== 'string' ||
    !SIMPLE_IDENTIFIER.test(candidate.table)
  ) {
    invalidConfiguration(name, 'Unsafe export table configuration')
  }
  let selectColumns: readonly string[]
  try {
    selectColumns = validateExportColumns(candidate.selectColumns)
  } catch {
    invalidConfiguration(name, 'Unsafe export column configuration')
  }

  const textCastCandidate = candidate.textCastColumns ?? []
  if (!Array.isArray(textCastCandidate)) {
    invalidConfiguration(name, 'Export text casts must be an explicit column array')
  }
  const textCastColumns = textCastCandidate.map((column) =>
    validateColumnName(name, column, 'text cast')
  )
  if (
    new Set(textCastColumns).size !== textCastColumns.length ||
    textCastColumns.some((column) => !selectColumns.includes(column))
  ) {
    invalidConfiguration(name, 'Every unique text cast column must be explicitly selected')
  }

  const ownerCandidate = candidate.ownerPredicate as Partial<ExportOwnerPredicate> | undefined
  if (!ownerCandidate || ownerCandidate.operator !== 'eq') {
    invalidConfiguration(name, 'Export owner predicate must be an explicit equality predicate')
  }
  const ownerPredicate: ExportOwnerPredicate = {
    column: validateColumnName(name, ownerCandidate.column, 'owner predicate'),
    operator: 'eq',
    valueType: validateValueType(name, ownerCandidate.valueType, 'owner predicate'),
  }

  const cursorCandidate = candidate.cursor as
    | Partial<CursorExportDataset['cursor']>
    | null
    | undefined
  if (
    !cursorCandidate ||
    cursorCandidate.order !== 'asc' ||
    !Array.isArray(cursorCandidate.columns) ||
    cursorCandidate.columns.length === 0
  ) {
    invalidConfiguration(name, 'Export cursor must explicitly define ascending key columns')
  }

  const cursorColumns = cursorCandidate.columns.map((rawColumn) => {
    const cursorColumn = rawColumn as Partial<ExportCursorColumn> | null | undefined
    if (!cursorColumn) invalidConfiguration(name, 'Invalid export cursor column configuration')
    return {
      column: validateColumnName(name, cursorColumn.column, 'cursor'),
      valueType: validateValueType(name, cursorColumn.valueType, 'cursor'),
    }
  })
  const cursorColumnNames = cursorColumns.map(({ column }) => column)
  if (
    new Set(cursorColumnNames).size !== cursorColumnNames.length ||
    cursorColumnNames.some((column) => !selectColumns.includes(column))
  ) {
    invalidConfiguration(name, 'Every unique cursor column must be explicitly selected')
  }

  // PostgREST serializes PostgreSQL int8 as a JSON number unless it is cast.
  // Casting cursor bigint columns to text before JSON parsing is the only point
  // at which values above Number.MAX_SAFE_INTEGER can still be kept exact.
  const bigintCursorColumns = new Set(
    cursorColumns.filter(({ valueType }) => valueType === 'bigint').map(({ column }) => column)
  )
  const textSelectionColumns = new Set([...bigintCursorColumns, ...textCastColumns])
  const selection = selectColumns
    .map((column) => (textSelectionColumns.has(column) ? `${column}::text` : column))
    .join(',')

  return {
    name,
    table: candidate.table,
    selectColumns,
    selection,
    textCastColumns,
    ownerPredicate,
    cursorColumns,
  }
}

export function validateCursorExportDataset(dataset: CursorExportDataset): void {
  validateDataset(dataset)
}

function normalizeTimestamp(value: unknown): NormalizedCursorValue {
  if (typeof value !== 'string') throw new Error('Timestamp cursor values must be strings')

  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      value
    )
  if (!match) throw new Error('Timestamp cursor value is not a canonical ISO timestamp')

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = '', zone] =
    match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)

  const localDate = new Date(0)
  localDate.setUTCFullYear(year, month - 1, day)
  localDate.setUTCHours(hour, minute, second, 0)
  if (
    localDate.getUTCFullYear() !== year ||
    localDate.getUTCMonth() !== month - 1 ||
    localDate.getUTCDate() !== day ||
    localDate.getUTCHours() !== hour ||
    localDate.getUTCMinutes() !== minute ||
    localDate.getUTCSeconds() !== second
  ) {
    throw new Error('Timestamp cursor value is outside the supported calendar range')
  }

  let offsetMinutes = 0
  if (zone !== 'Z') {
    const zoneHours = Number(zone.slice(1, 3))
    const zoneMinutes = Number(zone.slice(4, 6))
    if (zoneHours > 14 || zoneMinutes > 59 || (zoneHours === 14 && zoneMinutes !== 0)) {
      throw new Error('Timestamp cursor timezone offset is invalid')
    }
    offsetMinutes = (zone[0] === '-' ? -1 : 1) * (zoneHours * 60 + zoneMinutes)
  }

  const microseconds =
    BigInt(localDate.getTime()) * 1_000n +
    BigInt(fraction.padEnd(6, '0')) -
    BigInt(offsetMinutes) * 60_000_000n

  return {
    wireValue: value,
    comparable: microseconds,
    projectedValue: value,
    valueType: 'timestamp',
  }
}

function normalizeCursorValue(
  value: unknown,
  valueType: ExportCursorValueType,
  allowEmptyString = false
): NormalizedCursorValue {
  if (valueType === 'timestamp') return normalizeTimestamp(value)

  if (valueType === 'bigint') {
    // A number cannot prove that JSON parsing did not already round an int8.
    // Even apparently integral values are therefore rejected fail-closed.
    if (typeof value !== 'string' && typeof value !== 'bigint') {
      throw new Error('Bigint cursor values must arrive as exact decimal strings')
    }
    const wireValue = typeof value === 'bigint' ? value.toString() : value
    if (!CANONICAL_BIGINT.test(wireValue)) {
      throw new Error('Bigint cursor value is not a canonical decimal integer')
    }
    const comparable = BigInt(wireValue)
    if (comparable < POSTGRES_BIGINT_MIN || comparable > POSTGRES_BIGINT_MAX) {
      throw new Error('Bigint cursor value is outside the PostgreSQL bigint range')
    }
    return { wireValue, comparable, projectedValue: wireValue, valueType }
  }

  if (
    typeof value !== 'string' ||
    CONTROL_CHARACTER.test(value) ||
    (valueType === 'string' && value.length === 0 && !allowEmptyString)
  ) {
    throw new Error(`${valueType} cursor value must be a safe string`)
  }
  if (valueType === 'uuid' && !UUID.test(value)) {
    throw new Error('UUID cursor value is malformed')
  }

  const wireValue = valueType === 'uuid' ? value.toLowerCase() : value
  return { wireValue, comparable: wireValue, projectedValue: wireValue, valueType }
}

function compareCursorValues(left: NormalizedCursorValue, right: NormalizedCursorValue): number {
  if (left.valueType !== right.valueType || typeof left.comparable !== typeof right.comparable) {
    throw new Error('Cursor value types changed while paging')
  }
  if (left.comparable === right.comparable) return 0
  return left.comparable < right.comparable ? -1 : 1
}

function compareCursorTuples(
  left: readonly NormalizedCursorValue[],
  right: readonly NormalizedCursorValue[]
): number {
  if (left.length !== right.length) throw new Error('Cursor tuple shape changed while paging')
  for (let index = 0; index < left.length; index += 1) {
    const comparison = compareCursorValues(left[index], right[index])
    if (comparison !== 0) return comparison
  }
  return 0
}

function cursorTupleKey(cursor: readonly NormalizedCursorValue[]): string {
  return cursor
    .map(({ valueType, wireValue }) => `${valueType}:${wireValue.length}:${wireValue}`)
    .join('|')
}

function formatPostgrestValue(value: NormalizedCursorValue): string {
  if (value.valueType === 'bigint' || UNQUOTED_POSTGREST_VALUE.test(value.wireValue)) {
    return value.wireValue
  }

  // Values inside .or() use raw PostgREST grammar. Double quotes protect its
  // reserved punctuation; quotes and backslashes are escaped per that grammar.
  return `"${value.wireValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function buildLexicographicFilter(
  columns: readonly ExportCursorColumn[],
  cursor: readonly NormalizedCursorValue[]
): string {
  return columns
    .map((cursorColumn, index) => {
      const conditions = columns
        .slice(0, index)
        .map(
          (prefixColumn, prefixIndex) =>
            `${prefixColumn.column}.eq.${formatPostgrestValue(cursor[prefixIndex])}`
        )
      conditions.push(`${cursorColumn.column}.gt.${formatPostgrestValue(cursor[index])}`)
      return conditions.length === 1 ? conditions[0] : `and(${conditions.join(',')})`
    })
    .join(',')
}

/**
 * Fetch a complete owner-scoped dataset using a reviewed ascending keyset.
 *
 * Short non-empty pages deliberately do not terminate pagination: PostgREST
 * can enforce a server-side maximum lower than the requested limit. Completion
 * is proven only by a subsequent empty page. No range/offset pagination is used.
 */
export async function fetchAllExportRowsByCursor(
  supabase: SupabaseClient,
  dataset: CursorExportDataset,
  ownerValue: unknown
): Promise<Record<string, unknown>[]> {
  const validated = validateDataset(dataset)
  let normalizedOwner: NormalizedCursorValue
  try {
    normalizedOwner = normalizeCursorValue(ownerValue, validated.ownerPredicate.valueType)
  } catch (error) {
    throw new DataExportReadError(validated.name, error)
  }

  const rows: Record<string, unknown>[] = []
  let cursor: readonly NormalizedCursorValue[] | null = null
  const seenCursorTuples = new Set<string>()
  // Text ordering belongs to PostgreSQL: a database collation (or citext)
  // does not necessarily have the same order as JavaScript UTF-16 strings.
  // We still prove progress by rejecting every repeated tuple. Cursor types
  // with database-independent canonical order retain stricter local checks.
  const usesDatabaseTextOrdering = validated.cursorColumns.some(
    ({ valueType }) => valueType === 'string'
  )

  for (;;) {
    let query = supabase
      .from(validated.table)
      .select(validated.selection)
      .eq(validated.ownerPredicate.column, formatPostgrestValue(normalizedOwner))

    for (const cursorColumn of validated.cursorColumns) {
      query = query.order(cursorColumn.column, { ascending: true })
    }
    query = query.limit(EXPORT_PAGE_SIZE)

    if (cursor !== null) {
      if (validated.cursorColumns.length === 1) {
        query = query.gt(validated.cursorColumns[0].column, formatPostgrestValue(cursor[0]))
      } else {
        query = query.or(buildLexicographicFilter(validated.cursorColumns, cursor))
      }
    }

    let data: unknown
    let error: unknown
    try {
      const result = await query
      data = result.data
      error = result.error
    } catch (queryError) {
      throw new DataExportReadError(validated.name, queryError)
    }

    if (error || !Array.isArray(data)) {
      throw new DataExportReadError(validated.name, error)
    }
    if (data.length === 0) return rows
    if (rows.length + data.length > MAX_EXPORT_ROWS_PER_DATASET) {
      throw new DataExportTooLargeError(validated.name)
    }

    let nextCursor: readonly NormalizedCursorValue[] | null = cursor
    for (const rawRow of data) {
      if (!rawRow || typeof rawRow !== 'object' || Array.isArray(rawRow)) {
        throw new DataExportReadError(validated.name, new Error('Invalid row shape'))
      }
      const row = rawRow as Record<string, unknown>
      if (validated.selectColumns.some((column) => !Object.hasOwn(row, column))) {
        throw new DataExportReadError(validated.name, new Error('Incomplete selected row'))
      }
      if (
        validated.textCastColumns.some(
          (column) => row[column] !== null && typeof row[column] !== 'string'
        )
      ) {
        throw new DataExportReadError(validated.name, new Error('Inexact text-cast export field'))
      }

      let rowCursor: NormalizedCursorValue[]
      try {
        rowCursor = validated.cursorColumns.map(({ column, valueType }) =>
          normalizeCursorValue(row[column], valueType, valueType === 'string')
        )
        if (
          !usesDatabaseTextOrdering &&
          nextCursor !== null &&
          compareCursorTuples(rowCursor, nextCursor) <= 0
        ) {
          throw new Error('Pagination cursor did not advance monotonically')
        }
        const tupleKey = cursorTupleKey(rowCursor)
        if (seenCursorTuples.has(tupleKey)) {
          throw new Error('Pagination cursor tuple repeated')
        }
        seenCursorTuples.add(tupleKey)
      } catch (cursorError) {
        throw new DataExportReadError(validated.name, cursorError)
      }

      const normalizedCursorFields = new Map(
        validated.cursorColumns.map(({ column }, index) => [
          column,
          rowCursor[index].projectedValue,
        ])
      )
      rows.push(
        Object.fromEntries(
          validated.selectColumns.map((column) => [
            column,
            normalizedCursorFields.has(column) ? normalizedCursorFields.get(column) : row[column],
          ])
        ) as Record<string, unknown>
      )
      nextCursor = rowCursor
    }

    if (
      nextCursor === null ||
      (cursor !== null &&
        (usesDatabaseTextOrdering
          ? cursorTupleKey(nextCursor) === cursorTupleKey(cursor)
          : compareCursorTuples(nextCursor, cursor) <= 0))
    ) {
      throw new DataExportReadError(validated.name, new Error('Pagination cursor did not advance'))
    }
    cursor = nextCursor
  }
}
