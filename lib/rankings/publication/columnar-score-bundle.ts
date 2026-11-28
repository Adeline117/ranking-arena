/**
 * Decoding of public.arena_score_inputs_publish_bundle_columnar_json
 * (20261127103322).
 *
 * The RPC sends the score rows as { scoreRowColumns, scoreRowValues } so the
 * key names travel once instead of once per row. Decoding rebuilds exactly the
 * object-form bundle ({ scoreRows, physicalBoards }); nothing is validated
 * here beyond the columnar structure. Every rebuilt row then goes through the
 * unchanged strict publication-evidence parse, so an unknown or missing
 * column fails there exactly as it would in object form.
 *
 * Anything that is not a well-formed columnar bundle is returned unchanged,
 * and the strict parse rejects it (invalid_bundle).
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const COLUMNAR_KEYS = ['physicalBoards', 'scoreRowColumns', 'scoreRowValues']

export function decodeColumnarScoreBundle(data: unknown): unknown {
  if (!isRecord(data)) return data
  const keys = Object.keys(data).sort()
  if (keys.length !== COLUMNAR_KEYS.length || keys.some((key, i) => key !== COLUMNAR_KEYS[i])) {
    return data
  }

  const columns = data.scoreRowColumns
  const values = data.scoreRowValues
  if (
    !Array.isArray(columns) ||
    !Array.isArray(values) ||
    columns.some((column) => typeof column !== 'string') ||
    new Set(columns).size !== columns.length
  ) {
    return data
  }

  const scoreRows: Record<string, unknown>[] = []
  for (const value of values) {
    if (!Array.isArray(value) || value.length !== columns.length) return data
    // fromEntries defines own properties, so no column name can reach a prototype.
    scoreRows.push(Object.fromEntries(columns.map((column, index) => [column, value[index]])))
  }
  return { scoreRows, physicalBoards: data.physicalBoards }
}

/** Test and tooling helper: the columnar form of an object-form bundle. */
export function encodeColumnarScoreBundle(bundle: {
  scoreRows: readonly Record<string, unknown>[]
  physicalBoards: unknown
}): { scoreRowColumns: string[]; scoreRowValues: unknown[][]; physicalBoards: unknown } {
  const columns = bundle.scoreRows.length > 0 ? Object.keys(bundle.scoreRows[0]) : []
  const signature = [...columns].sort().join('\u0000')
  for (const row of bundle.scoreRows) {
    if (Object.keys(row).sort().join('\u0000') !== signature) {
      throw new Error('every score row must have the same keys to be encoded')
    }
  }
  return {
    scoreRowColumns: columns,
    scoreRowValues: bundle.scoreRows.map((row) => columns.map((column) => row[column])),
    physicalBoards: bundle.physicalBoards,
  }
}
