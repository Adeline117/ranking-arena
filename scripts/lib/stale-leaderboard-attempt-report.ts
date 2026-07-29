export const STALE_ATTEMPT_REQUEST_CONTRACT =
  'arena.ingest.stale-leaderboard-attempt-report-request@1' as const
export const STALE_ATTEMPT_RESPONSE_CONTRACT =
  'arena.ingest.stale-leaderboard-attempt-report-response@1' as const
export const STALE_ATTEMPT_CLI_CONTRACT =
  'arena.ingest.stale-leaderboard-attempt-advisory@1' as const

const DEFAULT_PAGE_SIZE = 250
const DEFAULT_STALE_AFTER_SECONDS = 2 * 60 * 60
const MAX_PAGE_SIZE = 1000
const MIN_STALE_AFTER_SECONDS = 5 * 60
const MAX_STALE_AFTER_SECONDS = 30 * 24 * 60 * 60
export const MAX_STALE_ATTEMPT_REPORT_ROWS = 10_000
export const MAX_STALE_ATTEMPT_REPORT_PAGES = 1_000
const DATABASE_CONNECTION_TIMEOUT_MILLIS = 10_000
const DATABASE_QUERY_TIMEOUT_MILLIS = 20_000
const DATABASE_STATEMENT_TIMEOUT_MILLIS = 15_000
const DATABASE_KEEPALIVE_INITIAL_DELAY_MILLIS = 10_000
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const CANONICAL_SEQUENCE = /^(0|[1-9][0-9]{0,18})$/

const RESPONSE_KEYS = Object.freeze([
  'after_attempt_seq',
  'contract',
  'high_water_attempt_seq',
  'observed_at',
  'page',
  'page_size',
  'rows',
  'stale_after_seconds',
] as const)
const PAGE_KEYS = Object.freeze(['has_more', 'next_after_attempt_seq', 'returned_count'] as const)
const ROW_KEYS = Object.freeze([
  'age_state',
  'attempt_id',
  'attempt_phase',
  'attempt_position',
  'attempt_seq',
  'authority_state',
  'capture_contract',
  'execution_phase',
  'observation_cycle_id',
  'ownership',
  'queue_attempt',
  'queue_job_id',
  'recorded_started_at',
  'source_id',
  'source_slug',
  'timeframe',
] as const)

export interface StaleAttemptReportRequest {
  contract: typeof STALE_ATTEMPT_REQUEST_CONTRACT
  observed_at: string
  high_water_attempt_seq: string | null
  after_attempt_seq: string | null
  page_size: number
  stale_after_seconds: number
}

export interface StaleAttemptReportRow {
  attempt_seq: string
  attempt_id: string
  source_id: number
  source_slug: string
  timeframe: 7 | 30 | 90
  observation_cycle_id: string | null
  queue_job_id: string | null
  queue_attempt: number
  capture_contract: string
  recorded_started_at: string
  ownership: 'claimed' | 'legacy'
  attempt_position: 'current' | 'superseded'
  age_state: 'expired'
  attempt_phase: 'open'
  authority_state: 'current' | 'expired' | 'fenced' | 'closed' | 'legacy_unfenced'
  execution_phase: 'active' | 'completed' | 'failed' | 'revoked' | 'idle' | 'missing' | 'legacy'
}

export interface StaleAttemptReportResponse {
  contract: typeof STALE_ATTEMPT_RESPONSE_CONTRACT
  observed_at: string
  high_water_attempt_seq: string
  after_attempt_seq: string | null
  stale_after_seconds: number
  page_size: number
  rows: StaleAttemptReportRow[]
  page: {
    returned_count: number
    has_more: boolean
    next_after_attempt_seq: string | null
  }
}

export interface StaleAttemptAdvisory {
  contract: typeof STALE_ATTEMPT_CLI_CONTRACT
  advisory_only: true
  mutation_authorized: false
  observed_at: string
  high_water_attempt_seq: string
  stale_after_seconds: number
  page_size: number
  page_count: number
  row_count: number
  rows: StaleAttemptReportRow[]
}

export interface StaleAttemptReportOptions {
  observedAt: string
  pageSize: number
  staleAfterSeconds: number
}

export interface StaleAttemptQueryClient {
  query(
    text: string,
    values?: readonly unknown[]
  ): Promise<{ rowCount: number | null; rows: unknown[] }>
}

export interface StaleAttemptDatabaseClientConfig {
  connectionString: string
  application_name: string
  ssl: false | { rejectUnauthorized: true }
  connectionTimeoutMillis: number
  query_timeout: number
  statement_timeout: number
  keepAlive: true
  keepAliveInitialDelayMillis: number
}

const LOCAL_DATABASE_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])
const DATABASE_URL_OVERRIDES = new Set([
  'application_name',
  'connect_timeout',
  'connectiontimeoutmillis',
  'database',
  'fallback_application_name',
  'host',
  'idle_in_transaction_session_timeout',
  'keepalive',
  'keepaliveinitialdelaymillis',
  'keepalives',
  'keepalives_idle',
  'lock_timeout',
  'options',
  'password',
  'port',
  'query_timeout',
  'ssl',
  'sslcert',
  'sslkey',
  'sslmode',
  'sslrootcert',
  'statement_timeout',
  'user',
  'uselibpqcompat',
])

function reportError(reason: string): Error {
  return new Error(`[stale-attempt-report] ${reason}`)
}

export function buildStaleAttemptDatabaseClientConfig(
  connectionString: string
): StaleAttemptDatabaseClientConfig {
  let parsed: URL
  try {
    parsed = new URL(connectionString)
  } catch {
    throw reportError('database URL is malformed')
  }
  if (
    (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') ||
    parsed.hostname.length === 0
  ) {
    throw reportError('database URL must use postgres:// or postgresql:// with a hostname')
  }

  // node-postgres lets query-string values override explicit Client options.
  // Remove routing, TLS, deadline, and keepalive overrides so the authority
  // hostname and the hardened options below remain the effective settings.
  for (const key of [...parsed.searchParams.keys()]) {
    if (DATABASE_URL_OVERRIDES.has(key.toLowerCase())) {
      parsed.searchParams.delete(key)
    }
  }

  const isLocal = LOCAL_DATABASE_HOSTNAMES.has(parsed.hostname)
  return {
    connectionString: parsed.toString(),
    application_name: 'ranking-arena-stale-attempt-readonly-advisory',
    ssl: isLocal ? false : { rejectUnauthorized: true },
    connectionTimeoutMillis: DATABASE_CONNECTION_TIMEOUT_MILLIS,
    query_timeout: DATABASE_QUERY_TIMEOUT_MILLIS,
    statement_timeout: DATABASE_STATEMENT_TIMEOUT_MILLIS,
    keepAlive: true,
    keepAliveInitialDelayMillis: DATABASE_KEEPALIVE_INITIAL_DELAY_MILLIS,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !CANONICAL_TIMESTAMP.test(value)) return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}

function canonicalSequence(value: unknown, { positive = false } = {}): value is string {
  if (typeof value !== 'string' || !CANONICAL_SEQUENCE.test(value)) return false
  if (positive && value === '0') return false
  try {
    const parsed = BigInt(value)
    return parsed <= 9_223_372_036_854_775_807n
  } catch {
    return false
  }
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
}

function nullableBoundedText(value: unknown, maximum: number): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' &&
      value.length >= 1 &&
      value.length <= maximum &&
      value.trim() === value &&
      !/[\u0000-\u001f\u007f]/.test(value))
  )
}

function assertOptions(options: StaleAttemptReportOptions): void {
  if (!canonicalTimestamp(options.observedAt)) {
    throw reportError('observed-at must be a canonical millisecond UTC timestamp')
  }
  if (!boundedInteger(options.pageSize, 1, MAX_PAGE_SIZE)) {
    throw reportError(`page-size must be an integer between 1 and ${MAX_PAGE_SIZE}`)
  }
  if (
    !boundedInteger(options.staleAfterSeconds, MIN_STALE_AFTER_SECONDS, MAX_STALE_AFTER_SECONDS)
  ) {
    throw reportError(
      `stale-after-seconds must be an integer between ${MIN_STALE_AFTER_SECONDS} and ${MAX_STALE_AFTER_SECONDS}`
    )
  }
}

function parseIntegerOption(name: string, raw: string | undefined): number {
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) {
    throw reportError(`${name} requires a positive base-10 integer`)
  }
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed)) throw reportError(`${name} is outside the safe integer range`)
  return parsed
}

export function parseStaleAttemptReportArgs(
  args: readonly string[],
  now: () => Date = () => new Date()
): StaleAttemptReportOptions {
  let observedAt: string | undefined
  let pageSize = DEFAULT_PAGE_SIZE
  let staleAfterSeconds = DEFAULT_STALE_AFTER_SECONDS
  const seen = new Set<string>()

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!flag || value === undefined || !flag.startsWith('--') || seen.has(flag)) {
      throw reportError(
        'usage: --observed-at <ISO> --page-size <1..1000> --stale-after-seconds <300..2592000>'
      )
    }
    seen.add(flag)
    if (flag === '--observed-at') observedAt = value
    else if (flag === '--page-size') pageSize = parseIntegerOption('page-size', value)
    else if (flag === '--stale-after-seconds') {
      staleAfterSeconds = parseIntegerOption('stale-after-seconds', value)
    } else {
      throw reportError(`unknown option ${flag}`)
    }
  }

  const options = {
    observedAt: observedAt ?? now().toISOString(),
    pageSize,
    staleAfterSeconds,
  }
  assertOptions(options)
  return options
}

export function buildStaleAttemptReportRequest({
  options,
  highWaterAttemptSeq,
  afterAttemptSeq,
}: {
  options: StaleAttemptReportOptions
  highWaterAttemptSeq: string | null
  afterAttemptSeq: string | null
}): StaleAttemptReportRequest {
  assertOptions(options)
  if (highWaterAttemptSeq !== null && !canonicalSequence(highWaterAttemptSeq)) {
    throw reportError('high-water attempt sequence is malformed')
  }
  if (afterAttemptSeq !== null && !canonicalSequence(afterAttemptSeq, { positive: true })) {
    throw reportError('after attempt sequence is malformed')
  }
  if (
    highWaterAttemptSeq !== null &&
    afterAttemptSeq !== null &&
    BigInt(afterAttemptSeq) > BigInt(highWaterAttemptSeq)
  ) {
    throw reportError('after attempt sequence exceeds the fixed high-water')
  }
  return {
    contract: STALE_ATTEMPT_REQUEST_CONTRACT,
    observed_at: options.observedAt,
    high_water_attempt_seq: highWaterAttemptSeq,
    after_attempt_seq: afterAttemptSeq,
    page_size: options.pageSize,
    stale_after_seconds: options.staleAfterSeconds,
  }
}

function validateRow(
  value: unknown,
  response: {
    observedAt: string
    highWater: bigint
    after: bigint
    staleAfterSeconds: number
  }
): StaleAttemptReportRow {
  if (!isRecord(value) || !hasExactKeys(value, ROW_KEYS)) {
    throw reportError('response row envelope is malformed')
  }
  if (
    !canonicalSequence(value.attempt_seq, { positive: true }) ||
    typeof value.attempt_id !== 'string' ||
    !CANONICAL_UUID.test(value.attempt_id) ||
    !boundedInteger(value.source_id, 1, 32_767) ||
    typeof value.source_slug !== 'string' ||
    !nullableBoundedText(value.source_slug, 128) ||
    (value.timeframe !== 7 && value.timeframe !== 30 && value.timeframe !== 90) ||
    !nullableBoundedText(value.observation_cycle_id, 512) ||
    !nullableBoundedText(value.queue_job_id, 512) ||
    !boundedInteger(value.queue_attempt, 0, 1_000_000) ||
    typeof value.capture_contract !== 'string' ||
    value.capture_contract.length < 1 ||
    value.capture_contract.length > 256 ||
    !canonicalTimestamp(value.recorded_started_at) ||
    (value.ownership !== 'claimed' && value.ownership !== 'legacy') ||
    (value.attempt_position !== 'current' && value.attempt_position !== 'superseded') ||
    value.age_state !== 'expired' ||
    value.attempt_phase !== 'open' ||
    !['current', 'expired', 'fenced', 'closed', 'legacy_unfenced'].includes(
      value.authority_state as string
    ) ||
    !['active', 'completed', 'failed', 'revoked', 'idle', 'missing', 'legacy'].includes(
      value.execution_phase as string
    )
  ) {
    throw reportError('response row values are malformed')
  }

  const attemptSeq = BigInt(value.attempt_seq)
  const startedAt = new Date(value.recorded_started_at).getTime()
  const staleBoundary = new Date(response.observedAt).getTime() - response.staleAfterSeconds * 1000
  if (
    attemptSeq <= response.after ||
    attemptSeq > response.highWater ||
    startedAt > staleBoundary
  ) {
    throw reportError('response row is outside the frozen report window')
  }

  if (
    value.ownership === 'legacy' &&
    (value.authority_state !== 'legacy_unfenced' || value.execution_phase !== 'legacy')
  ) {
    throw reportError('legacy row authority classification is malformed')
  }
  if (
    value.ownership === 'claimed' &&
    (value.authority_state === 'legacy_unfenced' || value.execution_phase === 'legacy')
  ) {
    throw reportError('claimed row authority classification is malformed')
  }
  if (
    (value.authority_state === 'current' || value.authority_state === 'expired') &&
    value.execution_phase !== 'active'
  ) {
    throw reportError('active authority classification is malformed')
  }
  if (
    value.authority_state === 'closed' &&
    !['completed', 'failed', 'revoked'].includes(value.execution_phase as string)
  ) {
    throw reportError('closed authority classification is malformed')
  }

  return {
    attempt_seq: value.attempt_seq as string,
    attempt_id: value.attempt_id as string,
    source_id: value.source_id as number,
    source_slug: value.source_slug as string,
    timeframe: value.timeframe as 7 | 30 | 90,
    observation_cycle_id: value.observation_cycle_id as string | null,
    queue_job_id: value.queue_job_id as string | null,
    queue_attempt: value.queue_attempt as number,
    capture_contract: value.capture_contract as string,
    recorded_started_at: value.recorded_started_at as string,
    ownership: value.ownership as 'claimed' | 'legacy',
    attempt_position: value.attempt_position as 'current' | 'superseded',
    age_state: 'expired',
    attempt_phase: 'open',
    authority_state: value.authority_state as StaleAttemptReportRow['authority_state'],
    execution_phase: value.execution_phase as StaleAttemptReportRow['execution_phase'],
  }
}

export function validateStaleAttemptReportResponse(
  payload: unknown,
  request: StaleAttemptReportRequest
): StaleAttemptReportResponse {
  if (
    !isRecord(payload) ||
    !hasExactKeys(payload, RESPONSE_KEYS) ||
    payload.contract !== STALE_ATTEMPT_RESPONSE_CONTRACT ||
    payload.observed_at !== request.observed_at ||
    !canonicalSequence(payload.high_water_attempt_seq) ||
    payload.after_attempt_seq !== request.after_attempt_seq ||
    payload.stale_after_seconds !== request.stale_after_seconds ||
    payload.page_size !== request.page_size ||
    !Array.isArray(payload.rows) ||
    payload.rows.length > request.page_size ||
    !isRecord(payload.page) ||
    !hasExactKeys(payload.page, PAGE_KEYS)
  ) {
    throw reportError('response envelope is malformed')
  }

  if (
    request.high_water_attempt_seq !== null &&
    payload.high_water_attempt_seq !== request.high_water_attempt_seq
  ) {
    throw reportError('response changed the fixed high-water')
  }

  const highWater = BigInt(payload.high_water_attempt_seq)
  const after = request.after_attempt_seq === null ? 0n : BigInt(request.after_attempt_seq)
  if (after > highWater) throw reportError('response high-water precedes its cursor')

  const rows = payload.rows.map((row) =>
    validateRow(row, {
      observedAt: request.observed_at,
      highWater,
      after,
      staleAfterSeconds: request.stale_after_seconds,
    })
  )
  for (let index = 1; index < rows.length; index += 1) {
    if (BigInt(rows[index - 1].attempt_seq) >= BigInt(rows[index].attempt_seq)) {
      throw reportError('response attempt sequence is not strictly increasing')
    }
  }

  const page = payload.page
  if (
    !boundedInteger(page.returned_count, 0, request.page_size) ||
    page.returned_count !== rows.length ||
    typeof page.has_more !== 'boolean' ||
    (page.next_after_attempt_seq !== null &&
      !canonicalSequence(page.next_after_attempt_seq, { positive: true }))
  ) {
    throw reportError('response page values are malformed')
  }
  const expectedNext = page.has_more && rows.length > 0 ? rows.at(-1)?.attempt_seq : null
  if (page.next_after_attempt_seq !== expectedNext) {
    throw reportError('response page cursor is malformed')
  }

  return {
    contract: STALE_ATTEMPT_RESPONSE_CONTRACT,
    observed_at: payload.observed_at as string,
    high_water_attempt_seq: payload.high_water_attempt_seq as string,
    after_attempt_seq: payload.after_attempt_seq as string | null,
    stale_after_seconds: payload.stale_after_seconds as number,
    page_size: payload.page_size as number,
    rows,
    page: {
      returned_count: page.returned_count,
      has_more: page.has_more,
      next_after_attempt_seq: page.next_after_attempt_seq as string | null,
    },
  }
}

const REPORT_QUERY =
  'SELECT arena.report_stale_leaderboard_acquisition_attempts($1::jsonb) AS report'

export async function collectStaleAttemptAdvisory(
  client: StaleAttemptQueryClient,
  options: StaleAttemptReportOptions
): Promise<StaleAttemptAdvisory> {
  assertOptions(options)
  let transactionOpen = false
  let result: StaleAttemptAdvisory | undefined
  let primaryError: unknown

  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    transactionOpen = true
    await client.query('SET LOCAL ROLE service_role')
    await client.query("SET LOCAL statement_timeout = '15s'")
    await client.query("SET LOCAL lock_timeout = '3s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'")

    const rows: StaleAttemptReportRow[] = []
    const seenAttemptSeqs = new Set<string>()
    let highWaterAttemptSeq: string | null = null
    let afterAttemptSeq: string | null = null
    let pageCount = 0

    for (;;) {
      pageCount += 1
      if (pageCount > MAX_STALE_ATTEMPT_REPORT_PAGES) {
        throw reportError('page safety bound exceeded')
      }
      const request = buildStaleAttemptReportRequest({
        options,
        highWaterAttemptSeq,
        afterAttemptSeq,
      })
      const queryResult = await client.query(REPORT_QUERY, [JSON.stringify(request)])
      const queryRow = queryResult.rows[0]
      if (
        queryResult.rowCount !== 1 ||
        queryResult.rows.length !== 1 ||
        !isRecord(queryRow) ||
        !hasExactKeys(queryRow, ['report'])
      ) {
        throw reportError('database returned a malformed result envelope')
      }
      const response = validateStaleAttemptReportResponse(queryRow.report, request)
      if (highWaterAttemptSeq === null) highWaterAttemptSeq = response.high_water_attempt_seq

      if (response.rows.length > MAX_STALE_ATTEMPT_REPORT_ROWS - rows.length) {
        throw reportError('row safety bound exceeded')
      }

      for (const row of response.rows) {
        if (seenAttemptSeqs.has(row.attempt_seq)) {
          throw reportError('database repeated an attempt across pages')
        }
        seenAttemptSeqs.add(row.attempt_seq)
        rows.push(row)
      }

      if (!response.page.has_more) break
      if (rows.length >= MAX_STALE_ATTEMPT_REPORT_ROWS) {
        throw reportError('row safety bound exceeded')
      }
      const nextAfter = response.page.next_after_attempt_seq
      if (
        nextAfter === null ||
        (afterAttemptSeq !== null && BigInt(nextAfter) <= BigInt(afterAttemptSeq))
      ) {
        throw reportError('database pagination made no progress')
      }
      afterAttemptSeq = nextAfter
    }

    if (highWaterAttemptSeq === null) throw reportError('database omitted the report high-water')
    result = {
      contract: STALE_ATTEMPT_CLI_CONTRACT,
      advisory_only: true,
      mutation_authorized: false,
      observed_at: options.observedAt,
      high_water_attempt_seq: highWaterAttemptSeq,
      stale_after_seconds: options.staleAfterSeconds,
      page_size: options.pageSize,
      page_count: pageCount,
      row_count: rows.length,
      rows,
    }
  } catch (error) {
    primaryError = error
  }

  if (transactionOpen) {
    try {
      await client.query('ROLLBACK')
      transactionOpen = false
    } catch (rollbackError) {
      if (primaryError === undefined) primaryError = rollbackError
    }
  }
  if (primaryError !== undefined) throw primaryError
  if (!result) throw reportError('advisory did not produce a result')
  return result
}
