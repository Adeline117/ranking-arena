import type IORedis from 'ioredis'

import { alert } from '@/lib/ingest/alerting'
import { ingestClientConnect } from '@/lib/ingest/db'

export const BITGET_BOT_ATTEMPT_HEALTH_POLL_INTERVAL_MS = 5 * 60_000
export const BITGET_BOT_ATTEMPT_HEALTH_STARTUP_GRACE_MS = 2 * 60 * 60_000

export const BITGET_BOT_ATTEMPT_HEALTH_STATES = Object.freeze([
  'not_started',
  'open_fresh',
  'open_stale_suspect',
  'partial',
  'unknown',
  'processing_failed',
  'abandoned',
  'complete_in_publication_grace',
  'complete_unpublished',
  'published_gated',
  'published',
] as const)

export type BitgetBotAttemptHealthState = (typeof BITGET_BOT_ATTEMPT_HEALTH_STATES)[number]

const HEALTHY_STATES = new Set<BitgetBotAttemptHealthState>([
  'open_fresh',
  'complete_in_publication_grace',
  'published',
])
const TERMINAL_STATES = new Set([
  'complete',
  'partial',
  'unknown',
  'processing_failed',
  'abandoned',
])
const EXPECTED_SOURCE_SLUGS = ['bitget_bots_futures', 'bitget_bots_spot'] as const
const EXPECTED_ROW_KEYS = [
  'acquisition_contract',
  'attempt_id',
  'attempt_seq',
  'health_state',
  'manifest_raw_object_id',
  'publication_count_check_passed',
  'publication_scraped_at',
  'publication_snapshot_id',
  'recorded_completed_at',
  'recorded_started_at',
  'source_id',
  'source_payload_raw_object_id',
  'source_run_id',
  'source_slug',
  'terminal_state',
  'timeframe',
] as const
const V4_CAPTURE_CONTRACT = 'arena.ingest.leaderboard-acquisition-manifest@4'
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const CANONICAL_SOURCE_RUN_ID = /^[0-9a-f]{64}$/
const ZERO_SOURCE_RUN_ID = '0'.repeat(64)

const HEALTH_SQL = `SELECT
    source_id,
    source_slug,
    timeframe,
    attempt_seq,
    attempt_id,
    health_state,
    terminal_state,
    recorded_started_at,
    recorded_completed_at,
    source_run_id,
    acquisition_contract,
    source_payload_raw_object_id,
    manifest_raw_object_id,
    publication_snapshot_id,
    publication_scraped_at,
    publication_count_check_passed
  FROM public.arena_bitget_bot_acquisition_attempt_health()`

export interface BitgetBotAttemptHealthRow {
  source_id: number
  source_slug: (typeof EXPECTED_SOURCE_SLUGS)[number]
  timeframe: 30
  attempt_seq: number | null
  attempt_id: string | null
  health_state: BitgetBotAttemptHealthState
  terminal_state: string | null
  recorded_started_at: Date | null
  recorded_completed_at: Date | null
  source_run_id: string | null
  acquisition_contract: string | null
  source_payload_raw_object_id: number | null
  manifest_raw_object_id: number | null
  publication_snapshot_id: number | null
  publication_scraped_at: Date | null
  publication_count_check_passed: boolean | null
}

export interface BitgetBotAttemptHealthWatchdog {
  poll(): Promise<void>
  stop(): void
}

type AttemptHealthAlert = typeof alert
type LoadHealth = () => Promise<unknown>

function watchdogError(reason: string): Error {
  return new Error(`[attempt-health-watchdog] health contract is ${reason}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...EXPECTED_ROW_KEYS].sort())
}

function isNullablePositiveInteger(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) > 0)
}

function isNullableDate(value: unknown): value is Date | null {
  return value === null || (value instanceof Date && Number.isFinite(value.getTime()))
}

function isCanonicalSourceRunId(value: unknown): value is string {
  return (
    typeof value === 'string' && CANONICAL_SOURCE_RUN_ID.test(value) && value !== ZERO_SOURCE_RUN_ID
  )
}

function hasCompleteEvidence(row: Record<string, unknown>): boolean {
  return (
    isCanonicalSourceRunId(row.source_run_id) &&
    typeof row.source_payload_raw_object_id === 'number' &&
    row.source_payload_raw_object_id > 0 &&
    typeof row.manifest_raw_object_id === 'number' &&
    row.manifest_raw_object_id > 0 &&
    row.source_payload_raw_object_id !== row.manifest_raw_object_id
  )
}

function hasNoEvidence(row: Record<string, unknown>): boolean {
  return (
    row.source_run_id === null &&
    row.source_payload_raw_object_id === null &&
    row.manifest_raw_object_id === null
  )
}

function hasNoPublication(row: Record<string, unknown>): boolean {
  return (
    row.publication_snapshot_id === null &&
    row.publication_scraped_at === null &&
    row.publication_count_check_passed === null
  )
}

function hasAttemptShape(row: Record<string, unknown>): boolean {
  if (row.health_state === 'not_started') {
    return [
      row.attempt_seq,
      row.attempt_id,
      row.terminal_state,
      row.recorded_started_at,
      row.recorded_completed_at,
      row.source_run_id,
      row.acquisition_contract,
      row.source_payload_raw_object_id,
      row.manifest_raw_object_id,
      row.publication_snapshot_id,
      row.publication_scraped_at,
      row.publication_count_check_passed,
    ].every((value) => value === null)
  }

  if (
    !Number.isSafeInteger(row.attempt_seq) ||
    (row.attempt_seq as number) <= 0 ||
    typeof row.attempt_id !== 'string' ||
    !CANONICAL_UUID.test(row.attempt_id) ||
    !(row.recorded_started_at instanceof Date) ||
    !Number.isFinite(row.recorded_started_at.getTime()) ||
    typeof row.acquisition_contract !== 'string' ||
    row.acquisition_contract.length === 0
  ) {
    return false
  }
  if (row.health_state !== 'unknown' && row.acquisition_contract !== V4_CAPTURE_CONTRACT) {
    return false
  }

  if (row.health_state === 'open_fresh' || row.health_state === 'open_stale_suspect') {
    return (
      row.terminal_state === 'in_progress' &&
      row.recorded_completed_at === null &&
      hasNoEvidence(row) &&
      hasNoPublication(row)
    )
  }

  if (row.health_state === 'unknown') {
    if (!hasNoPublication(row)) return false
    if (row.terminal_state === 'in_progress') {
      return row.recorded_completed_at === null && hasNoEvidence(row)
    }
    if (
      !TERMINAL_STATES.has(row.terminal_state as string) ||
      !(row.recorded_completed_at instanceof Date)
    ) {
      return false
    }
    if (row.terminal_state === 'complete' || row.terminal_state === 'partial') {
      return hasCompleteEvidence(row)
    }
    if (row.terminal_state === 'processing_failed' || row.terminal_state === 'abandoned') {
      return hasNoEvidence(row)
    }
    return hasCompleteEvidence(row) || hasNoEvidence(row)
  }

  if (
    !TERMINAL_STATES.has(row.terminal_state as string) ||
    !(row.recorded_completed_at instanceof Date)
  ) {
    return false
  }

  if (
    row.health_state === 'partial' ||
    row.health_state === 'processing_failed' ||
    row.health_state === 'abandoned'
  ) {
    if (row.terminal_state !== row.health_state || !hasNoPublication(row)) return false
    return row.health_state === 'partial' ? hasCompleteEvidence(row) : hasNoEvidence(row)
  }

  if (row.terminal_state !== 'complete') return false
  if (!hasCompleteEvidence(row)) return false
  if (row.health_state === 'published' || row.health_state === 'published_gated') {
    return (
      typeof row.publication_snapshot_id === 'number' &&
      row.publication_snapshot_id > 0 &&
      row.publication_scraped_at instanceof Date &&
      row.publication_count_check_passed === (row.health_state === 'published')
    )
  }

  return hasNoPublication(row)
}

export function validateBitgetBotAttemptHealth(payload: unknown): BitgetBotAttemptHealthRow[] {
  if (!Array.isArray(payload) || payload.length !== 2) {
    throw watchdogError('malformed')
  }

  const rows: BitgetBotAttemptHealthRow[] = []
  for (const [index, expectedSourceSlug] of EXPECTED_SOURCE_SLUGS.entries()) {
    const row = payload[index]
    if (
      !isRecord(row) ||
      !hasExactKeys(row) ||
      row.source_slug !== expectedSourceSlug ||
      !Number.isInteger(row.source_id) ||
      (row.source_id as number) <= 0 ||
      row.timeframe !== 30 ||
      !BITGET_BOT_ATTEMPT_HEALTH_STATES.includes(row.health_state as BitgetBotAttemptHealthState) ||
      (row.terminal_state !== null &&
        row.terminal_state !== 'in_progress' &&
        !TERMINAL_STATES.has(row.terminal_state as string)) ||
      !isNullablePositiveInteger(row.source_payload_raw_object_id) ||
      !isNullablePositiveInteger(row.manifest_raw_object_id) ||
      !isNullablePositiveInteger(row.publication_snapshot_id) ||
      !isNullableDate(row.recorded_started_at) ||
      !isNullableDate(row.recorded_completed_at) ||
      !isNullableDate(row.publication_scraped_at) ||
      (row.source_run_id !== null && !isCanonicalSourceRunId(row.source_run_id)) ||
      (row.acquisition_contract !== null && typeof row.acquisition_contract !== 'string') ||
      (row.publication_count_check_passed !== null &&
        typeof row.publication_count_check_passed !== 'boolean') ||
      !hasAttemptShape(row)
    ) {
      throw watchdogError('malformed')
    }
    rows.push({
      source_id: row.source_id as number,
      source_slug: expectedSourceSlug,
      timeframe: 30,
      attempt_seq: row.attempt_seq as number | null,
      attempt_id: row.attempt_id as string | null,
      health_state: row.health_state as BitgetBotAttemptHealthState,
      terminal_state: row.terminal_state as string | null,
      recorded_started_at: row.recorded_started_at as Date | null,
      recorded_completed_at: row.recorded_completed_at as Date | null,
      source_run_id: row.source_run_id as string | null,
      acquisition_contract: row.acquisition_contract as string | null,
      source_payload_raw_object_id: row.source_payload_raw_object_id as number | null,
      manifest_raw_object_id: row.manifest_raw_object_id as number | null,
      publication_snapshot_id: row.publication_snapshot_id as number | null,
      publication_scraped_at: row.publication_scraped_at as Date | null,
      publication_count_check_passed: row.publication_count_check_passed as boolean | null,
    })
  }
  if (rows[0].source_id === rows[1].source_id) throw watchdogError('malformed')
  return rows
}

export async function loadBitgetBotAttemptHealth(): Promise<BitgetBotAttemptHealthRow[]> {
  const client = await ingestClientConnect()
  let inTransaction = false
  try {
    await client.query('BEGIN TRANSACTION READ ONLY')
    inTransaction = true
    await client.query("SET LOCAL statement_timeout = '10s'")
    const result = await client.query(HEALTH_SQL)
    if (result.rowCount !== 2 || result.rows.length !== 2) throw watchdogError('malformed')
    const rows = validateBitgetBotAttemptHealth(result.rows)
    await client.query('COMMIT')
    inTransaction = false
    return rows
  } catch (error) {
    if (inTransaction) await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export function startBitgetBotAttemptHealthWatchdog({
  redis,
  load = loadBitgetBotAttemptHealth,
  sendAlert = alert,
  now = Date.now,
  pollIntervalMs = BITGET_BOT_ATTEMPT_HEALTH_POLL_INTERVAL_MS,
  startupGraceMs = BITGET_BOT_ATTEMPT_HEALTH_STARTUP_GRACE_MS,
  track = () => undefined,
}: {
  redis: IORedis
  load?: LoadHealth
  sendAlert?: AttemptHealthAlert
  now?: () => number
  pollIntervalMs?: number
  startupGraceMs?: number
  track?: (operation: PromiseLike<unknown>) => void
}): BitgetBotAttemptHealthWatchdog {
  const startedAt = now()
  const lastAlertedState = new Map<string, string>()
  let lastFailure: 'malformed' | 'unavailable' | undefined
  let inFlight: Promise<void> | undefined
  let stopped = false

  const emit = async (sourceSlug: string, message: string): Promise<void> => {
    await sendAlert(redis, {
      sourceSlug,
      phase: 0,
      tier: 'A',
      message,
    })
  }

  const observe = async (): Promise<void> => {
    let rows: BitgetBotAttemptHealthRow[]
    try {
      rows = validateBitgetBotAttemptHealth(await load())
    } catch (error) {
      const failure =
        error instanceof Error && error.message === watchdogError('malformed').message
          ? 'malformed'
          : 'unavailable'
      if (lastFailure !== failure) {
        try {
          await emit('bitget_bots_attempt_health', `health contract ${failure}`)
          lastFailure = failure
        } catch {
          console.error('[attempt-health-watchdog] alert delivery failed')
        }
        console.error(`[attempt-health-watchdog] health contract ${failure}`)
      }
      return
    }

    lastFailure = undefined
    for (const row of rows) {
      const healthy = HEALTHY_STATES.has(row.health_state)
      const graceActive = row.health_state === 'not_started' && now() - startedAt < startupGraceMs
      const previousAlert = lastAlertedState.get(row.source_slug)

      if (healthy || graceActive) {
        if (healthy && previousAlert !== undefined) {
          console.log(
            `[attempt-health-watchdog] recovered source=${row.source_slug} ` +
              `timeframe=${row.timeframe} state=${row.health_state}`
          )
        }
        if (healthy) lastAlertedState.delete(row.source_slug)
        continue
      }
      if (previousAlert === row.health_state) continue

      console.warn(
        `[attempt-health-watchdog] degraded source=${row.source_slug} ` +
          `timeframe=${row.timeframe} state=${row.health_state}`
      )
      try {
        await emit(
          row.source_slug,
          `acquisition attempt health degraded: state=${row.health_state} timeframe=${row.timeframe}`
        )
        lastAlertedState.set(row.source_slug, row.health_state)
      } catch {
        console.error('[attempt-health-watchdog] alert delivery failed')
      }
    }
  }

  const poll = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (inFlight !== undefined) return inFlight
    const operation = observe()
    inFlight = operation
    const clear = () => {
      if (inFlight === operation) inFlight = undefined
    }
    void operation.then(clear, clear)
    track(operation)
    return operation
  }

  const timer = setInterval(() => void poll(), pollIntervalMs)
  timer.unref?.()
  void poll()

  return Object.freeze({
    poll,
    stop: () => {
      if (stopped) return
      stopped = true
      clearInterval(timer)
    },
  })
}
