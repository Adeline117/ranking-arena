/**
 * Transaction-local metric-trust writer for captured Tier-A boards.
 *
 * RAW objects are durably written before this module is called. Everything
 * below runs on the SAME PoolClient transaction as the serving snapshot so a
 * trusted success can never leave entries without its run, observations, and
 * immutable artifact references.
 */

import type { PoolClient } from 'pg'

import {
  getRegisteredMetricSourceContract,
  type MetricProvenance,
  type RankingMetric,
  type RawEvidenceRole,
  type SourceMetricFieldContract,
} from '../../metric-trust'
import {
  parseLeaderboardAcquisitionManifest,
  type LeaderboardAcquisitionManifest,
} from '../acquisition-manifest'
import type { ParsedLeaderboardRow, RankingTimeframe, SourceRow } from '../core/types'
import type { LeaderboardRawArtifactSetReceipt } from '../raw'
import { strictCanonicalSha256 } from '../strict-canonical-json'

const SHA256 = /^[0-9a-f]{64}$/
const PROVIDER_PROVENANCE = new Set<MetricProvenance>(['source_reported', 'source_normalized'])

export interface LeaderboardMetricTrustBundle {
  sourceRunId: string
  manifest: LeaderboardAcquisitionManifest
  artifacts: LeaderboardRawArtifactSetReceipt
}

export interface PrepareLeaderboardMetricTrustInput {
  src: SourceRow
  timeframe: RankingTimeframe
  rows: ParsedLeaderboardRow[]
  rejectedRowCount: number
  bundle: LeaderboardMetricTrustBundle
}

export interface PreparedLeaderboardMetricTrust {
  src: SourceRow
  timeframe: RankingTimeframe
  rows: ParsedLeaderboardRow[]
  manifest: LeaderboardAcquisitionManifest
  sourceRunId: string
  artifacts: LeaderboardRawArtifactSetReceipt
  sourceAsOf: string
  windowStart: string
  expectedFields: SourceMetricFieldContract[]
}

export interface MetricTrustSnapshotContext {
  snapshotId: number
  snapshotScrapedAt: string
  traderIds: Map<string, number>
}

export interface MetricTrustWriteReceipt {
  sourceRunId: string
  observationsWritten: number
  artifactRefsWritten: number
}

export interface ExistingTrustedPublication {
  snapshotId: number
  scrapedAt: string
  expectedCount: number | null
  actualCount: number
  baselineUsed: number | null
  traderIds: Map<string, number>
  trust: MetricTrustWriteReceipt & { replayed: true }
}

interface MetricContractRow {
  id: string
  contract_version: string
  metric: RankingMetric
  field_path: string
  provenance: MetricProvenance
  methodology_version: string
  metric_set_id: string
  timeframes: number[]
  value_unit: string
  currencies: string[]
  required_raw_roles: RawEvidenceRole[]
  source_payload_scope: string
  max_freshness_ms: string
  max_window_end_lag_ms: string
  allow_derived_population: boolean
}

interface ObservationInput {
  contract_id: string
  trader_id: number
  exchange_trader_id: string
  value: number | null
  quality: 'complete' | 'unknown'
  history_state: 'source_owned'
  price_state: 'source_owned'
  cost_basis_state: 'source_owned'
  population_state: 'verified'
  window_state: 'verified' | 'unknown'
  unit_state: 'verified'
  freshness_state: 'verified'
  blocking_reasons: Array<{ code: string; state: 'unknown' }>
}

interface InsertedObservationRow {
  id: string
  contract_id: string
  trader_id: string
}

interface ExistingRunRow {
  source_id: number
  timeframe: number
  snapshot_id: string
  snapshot_scraped_at: string
  population_raw_object_id: string
  manifest_raw_object_id: string
  started_at: string
  completed_at: string
  reported_population: number | null
  fetched_population: number
  caller_limited: boolean
  acquisition_state: string
  population_state: string
  expected_count: number | null
  actual_count: number
  baseline_used: number | null
  count_check_passed: boolean
  is_derived: boolean
  snapshot_raw_object_id: string | null
  current_snapshot_source_id: number
  current_snapshot_timeframe: number
  current_snapshot_scraped_at: string
  population_content_hash: string
  population_quarantined: boolean
  population_source_run_id: string | null
  population_role: string | null
  population_meta: unknown
  manifest_content_hash: string
  manifest_quarantined: boolean
  manifest_source_run_id: string | null
  manifest_role: string | null
  manifest_meta: unknown
}

interface ExistingEntryRow {
  trader_id: string
  trader_source_id: number
  exchange_trader_id: string
  timeframe: number
  scraped_at: string
  rank: number
  headline_roi: string | null
  headline_pnl: string | null
  headline_win_rate: string | null
  currency: string
}

interface ExistingObservationRow {
  id: string
  contract_id: string
  trader_id: string
  exchange_trader_id: string
  value: string | null
  quality: string
  history_state: string
  price_state: string
  cost_basis_state: string
  population_state: string
  window_state: string
  unit_state: string
  freshness_state: string
  blocking_reasons: unknown
  source_as_of: string
  valid_until: string
  window_start: string
  window_end: string
}

interface ExistingArtifactRow {
  observation_id: string
  role: RawEvidenceRole
  raw_object_id: string
  content_hash: string
}

function publicationError(detail: string): Error {
  return new Error(`[metric-trust-publish] ${detail}`)
}

/** Runtime-compatible deep snapshot for JSON-shaped ingestion values. */
export function snapshotLeaderboardTrustValue<T>(value: T): T {
  const seen = new WeakSet<object>()
  const clone = (current: unknown): unknown => {
    if (current === null || typeof current !== 'object') return current
    if (seen.has(current)) throw publicationError('trusted input contains a cyclic value')
    seen.add(current)
    if (Array.isArray(current)) {
      const output = current.map(clone)
      seen.delete(current)
      return output
    }
    const prototype = Object.getPrototypeOf(current)
    if (prototype !== Object.prototype && prototype !== null) {
      throw publicationError('trusted input must contain only plain JSON-shaped objects')
    }
    const output: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(current)) output[key] = clone(child)
    seen.delete(current)
    return output
  }
  return clone(value) as T
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw publicationError(`${label} must be a positive safe integer`)
  }
}

function canonicalTimestamp(value: string, label: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw publicationError(`${label} must be an ISO timestamp`)
  return new Date(timestamp).toISOString()
}

function timeframeKey(timeframe: RankingTimeframe): '7D' | '30D' | '90D' {
  return `${timeframe}D` as '7D' | '30D' | '90D'
}

function registeredPopulationFields(
  src: Pick<SourceRow, 'slug' | 'currency'>,
  timeframe: RankingTimeframe
): SourceMetricFieldContract[] {
  return (getRegisteredMetricSourceContract(src.slug)?.fields ?? []).filter(
    (field) =>
      field.sourcePayloadScope === 'population_snapshot' &&
      field.windowKeys.includes(timeframeKey(timeframe)) &&
      field.currencies.includes(src.currency as never)
  )
}

/**
 * Whether this source/window/currency has a reviewed population contract.
 * Captured sources without one must stay on the legacy publication path; they
 * cannot create a zero-observation run that looks trusted.
 */
export function hasRegisteredLeaderboardMetricTrust(
  src: Pick<SourceRow, 'slug' | 'currency'>,
  timeframe: RankingTimeframe
): boolean {
  return registeredPopulationFields(src, timeframe).length > 0
}

function sorted<T extends string | number>(values: readonly T[]): T[] {
  return [...values].sort((a, b) => String(a).localeCompare(String(b)))
}

function fieldKey(field: {
  metric: string
  fieldPath?: string
  field_path?: string
  provenance: string
  methodologyVersion?: string
  methodology_version?: string
}): string {
  return [
    field.metric,
    field.fieldPath ?? field.field_path,
    field.provenance,
    field.methodologyVersion ?? field.methodology_version,
  ].join('\u0000')
}

function reportedPopulation(manifest: LeaderboardAcquisitionManifest): number | null {
  const report = manifest.population.reports.population
  return report.state === 'consistent' ? report.value : null
}

function metricValue(row: ParsedLeaderboardRow, metric: RankingMetric): number | null {
  switch (metric) {
    case 'roi':
      return row.headlineRoi
    case 'pnl':
      return row.headlinePnl
    case 'win_rate':
      return row.headlineWinRate
    case 'mdd':
      return row.headlineMdd ?? null
    case 'sharpe':
      return row.headlineSharpe ?? null
  }
}

function sameNumeric(actual: string | number | null, expected: number | null): boolean {
  if (actual === null || expected === null) return actual === null && expected === null
  const numeric = Number(actual)
  return Number.isFinite(numeric) && numeric === expected
}

function sameTimestamp(actual: string, expected: string): boolean {
  return canonicalTimestamp(actual, 'database timestamp') === expected
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function sameJson(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(parseJson(actual)) === JSON.stringify(expected)
}

function hasCanonicalRawIntegrity(value: unknown): boolean {
  const parsed = parseJson(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const integrity = (parsed as Record<string, unknown>).raw_integrity
  return (
    !!integrity &&
    typeof integrity === 'object' &&
    !Array.isArray(integrity) &&
    (integrity as Record<string, unknown>).hash_algorithm === 'sha256' &&
    (integrity as Record<string, unknown>).hash_scope === 'json_utf8'
  )
}

export function prepareLeaderboardMetricTrust(
  input: PrepareLeaderboardMetricTrustInput
): PreparedLeaderboardMetricTrust {
  // Freeze every value read after the publisher's first await. Callers retain
  // references to adapter rows and source metadata; a concurrent mutation must
  // not race the database transaction into certifying different bytes.
  const src = snapshotLeaderboardTrustValue(input.src)
  const rows = snapshotLeaderboardTrustValue(input.rows)
  const timeframe = input.timeframe
  const rejectedRowCount = input.rejectedRowCount
  const bundle = {
    sourceRunId: input.bundle.sourceRunId,
    manifest: input.bundle.manifest,
    artifacts: {
      sourcePayload: { ...input.bundle.artifacts.sourcePayload },
      populationManifest: { ...input.bundle.artifacts.populationManifest },
    },
  }
  assertPositiveSafeInteger(src.id, 'source id')
  if (!Number.isSafeInteger(rejectedRowCount) || rejectedRowCount < 0) {
    throw publicationError('rejected row count must be a non-negative safe integer')
  }
  if (!SHA256.test(bundle.sourceRunId)) {
    throw publicationError('source run id must be a lowercase SHA-256 digest')
  }
  const manifest = parseLeaderboardAcquisitionManifest(bundle.manifest)
  if (strictCanonicalSha256(manifest) !== bundle.sourceRunId) {
    throw publicationError('source run id does not match the canonical manifest')
  }
  if (
    manifest.source.id !== src.id ||
    manifest.source.slug !== src.slug ||
    manifest.source.adapter_slug !== src.adapter_slug ||
    manifest.timeframe !== timeframe
  ) {
    throw publicationError('manifest source or timeframe does not match publication input')
  }
  if (
    manifest.capture_evidence_state !== 'verified' ||
    manifest.assessment.acquisition_state !== 'complete' ||
    manifest.assessment.population_state !== 'verified' ||
    manifest.caller_limited ||
    manifest.safety_limited
  ) {
    throw publicationError('trusted publication requires a complete verified uncapped capture')
  }
  if (
    manifest.population.accepted_population !== rows.length ||
    manifest.population.rejected_row_count !== rejectedRowCount
  ) {
    throw publicationError('manifest accepted/rejected counts do not match staged rows')
  }
  if (manifest.source_pages.length === 0) {
    throw publicationError('complete capture must contain source page evidence')
  }

  assertPositiveSafeInteger(bundle.artifacts.sourcePayload.id, 'source payload RAW id')
  assertPositiveSafeInteger(bundle.artifacts.populationManifest.id, 'manifest RAW id')
  if (bundle.artifacts.sourcePayload.id === bundle.artifacts.populationManifest.id) {
    throw publicationError('population payload and manifest must use distinct RAW pointers')
  }
  if (!SHA256.test(bundle.artifacts.sourcePayload.contentHash)) {
    throw publicationError('source payload RAW hash must be SHA-256')
  }
  if (bundle.artifacts.populationManifest.contentHash !== bundle.sourceRunId) {
    throw publicationError('manifest RAW hash must equal source run id')
  }

  const startedAt = canonicalTimestamp(manifest.started_at, 'manifest started_at')
  const completedAt = canonicalTimestamp(manifest.completed_at, 'manifest completed_at')
  if (Date.parse(startedAt) > Date.parse(completedAt)) {
    throw publicationError('manifest acquisition interval is inverted')
  }
  const sourceAsOf = manifest.source_pages
    .map((sourcePage) => canonicalTimestamp(sourcePage.fetched_at, 'source page fetched_at'))
    .sort()[0]
  const windowStart = new Date(
    Date.parse(sourceAsOf) - timeframe * 24 * 60 * 60 * 1000
  ).toISOString()

  const exchangeIds = rows.map((row) => row.exchangeTraderId)
  if (exchangeIds.some((id) => id.trim().length === 0)) {
    throw publicationError('ranked row has an empty exchange trader id')
  }
  if (new Set(exchangeIds).size !== exchangeIds.length) {
    throw publicationError('ranked rows contain duplicate exchange trader ids')
  }
  for (const row of rows) {
    for (const metric of ['roi', 'pnl', 'win_rate', 'mdd', 'sharpe'] as const) {
      const value = metricValue(row, metric)
      if (value !== null && !Number.isFinite(value)) {
        throw publicationError(`${metric} is non-finite for ${row.exchangeTraderId}`)
      }
    }
  }

  const expectedFields = registeredPopulationFields(src, timeframe)
  if (expectedFields.length === 0) {
    throw publicationError(
      `no registered population metric contracts for ${src.slug} ${timeframe}D ${src.currency}`
    )
  }
  for (const field of expectedFields) {
    if (!PROVIDER_PROVENANCE.has(field.provenance)) {
      throw publicationError(
        `population publisher cannot self-certify ${field.provenance} field ${field.fieldPath}`
      )
    }
  }

  return {
    src,
    timeframe,
    rows,
    manifest,
    sourceRunId: bundle.sourceRunId,
    artifacts: bundle.artifacts,
    sourceAsOf,
    windowStart,
    expectedFields,
  }
}

async function loadMetricContracts(
  client: PoolClient,
  prepared: PreparedLeaderboardMetricTrust
): Promise<MetricContractRow[]> {
  const { rows } = await client.query<MetricContractRow>(
    `SELECT id::text AS id,
            contract_version,
            metric,
            field_path,
            provenance,
            methodology_version,
            metric_set_id,
            timeframes,
            value_unit,
            currencies,
            required_raw_roles,
            source_payload_scope,
            ((EXTRACT(EPOCH FROM max_freshness) * 1000)::bigint)::text
              AS max_freshness_ms,
            ((EXTRACT(EPOCH FROM max_window_end_lag) * 1000)::bigint)::text
              AS max_window_end_lag_ms,
            allow_derived_population
       FROM arena.metric_source_contracts
      WHERE source_id = $1
        AND active
        AND source_payload_scope = 'population_snapshot'
        AND $2::smallint = ANY(timeframes)
        AND $3::text = ANY(currencies)
      ORDER BY metric, field_path, provenance, methodology_version`,
    [prepared.src.id, prepared.timeframe, prepared.src.currency]
  )

  const expectedByKey = new Map(prepared.expectedFields.map((field) => [fieldKey(field), field]))
  const actualByKey = new Map(rows.map((field) => [fieldKey(field), field]))
  if (rows.length !== actualByKey.size || expectedByKey.size !== actualByKey.size) {
    throw publicationError(
      `code/database contract drift: expected ${expectedByKey.size}, found ${actualByKey.size}`
    )
  }
  for (const [key, expected] of expectedByKey) {
    const actual = actualByKey.get(key)
    if (
      !actual ||
      actual.contract_version !== getRegisteredMetricSourceContract(prepared.src.slug)?.version ||
      actual.metric_set_id !== expected.metricSetId ||
      actual.value_unit !== expected.valueUnit ||
      actual.source_payload_scope !== expected.sourcePayloadScope ||
      Number(actual.max_freshness_ms) !== expected.maxFreshnessMs ||
      Number(actual.max_window_end_lag_ms) !== expected.maxWindowEndLagMs ||
      JSON.stringify(sorted(actual.timeframes)) !==
        JSON.stringify(sorted(expected.windowKeys.map((window) => Number(window.slice(0, -1))))) ||
      JSON.stringify(sorted(actual.currencies)) !== JSON.stringify(sorted(expected.currencies)) ||
      JSON.stringify(sorted(actual.required_raw_roles)) !==
        JSON.stringify(sorted(expected.requiredRawRoles)) ||
      actual.allow_derived_population
    ) {
      throw publicationError(
        `code/database contract drift for ${expected.metric}:${expected.fieldPath}`
      )
    }
  }
  return rows
}

function buildObservationInputs(
  prepared: PreparedLeaderboardMetricTrust,
  context: MetricTrustSnapshotContext,
  contracts: MetricContractRow[]
): ObservationInput[] {
  const observations: ObservationInput[] = []
  for (const row of prepared.rows) {
    const traderId = context.traderIds.get(row.exchangeTraderId)
    if (!traderId) {
      throw publicationError(`missing trader id for ${row.exchangeTraderId}`)
    }
    for (const contract of contracts) {
      const value = metricValue(row, contract.metric)
      const claim = row.headlineMetricSources?.[contract.metric]
      const exactLineage = claim?.fieldPath === contract.field_path
      const blockingReasons: ObservationInput['blocking_reasons'] = []
      if (value === null) blockingReasons.push({ code: 'value_unknown', state: 'unknown' })
      if (!exactLineage) {
        blockingReasons.push({
          code: claim ? 'field_lineage_mismatch' : 'field_lineage_unknown',
          state: 'unknown',
        })
      }
      // The capture currently proves the native timeframe label and keeps a
      // conservative freshness watermark, but it does not bind each row to a
      // page timestamp or persist provider-defined exact rolling boundaries.
      // Keep the value visible in shadow evidence while failing ranking closed
      // until that request/window contract is durably proven.
      blockingReasons.push({
        code: 'native_window_boundary_unverified',
        state: 'unknown',
      })
      observations.push({
        contract_id: contract.id,
        trader_id: traderId,
        exchange_trader_id: row.exchangeTraderId,
        value,
        quality: 'unknown',
        history_state: 'source_owned',
        price_state: 'source_owned',
        cost_basis_state: 'source_owned',
        population_state: 'verified',
        window_state: 'unknown',
        unit_state: 'verified',
        freshness_state: 'verified',
        blocking_reasons: blockingReasons,
      })
    }
  }
  return observations
}

function rawRefForRole(
  prepared: PreparedLeaderboardMetricTrust,
  role: RawEvidenceRole
): { raw_object_id: number; content_hash: string } | null {
  if (role === 'source_payload') {
    return {
      raw_object_id: prepared.artifacts.sourcePayload.id,
      content_hash: prepared.artifacts.sourcePayload.contentHash,
    }
  }
  if (role === 'population_manifest') {
    return {
      raw_object_id: prepared.artifacts.populationManifest.id,
      content_hash: prepared.artifacts.populationManifest.contentHash,
    }
  }
  return null
}

export async function writeLeaderboardMetricTrust(
  client: PoolClient,
  prepared: PreparedLeaderboardMetricTrust,
  context: MetricTrustSnapshotContext
): Promise<MetricTrustWriteReceipt> {
  const manifest = prepared.manifest
  const run = await client.query(
    `INSERT INTO arena.metric_trust_runs
       (source_run_id, source_id, timeframe, snapshot_id, snapshot_scraped_at,
        population_raw_object_id, manifest_raw_object_id, started_at, completed_at,
        reported_population, fetched_population, caller_limited,
        acquisition_state, population_state)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      prepared.sourceRunId,
      prepared.src.id,
      prepared.timeframe,
      context.snapshotId,
      context.snapshotScrapedAt,
      prepared.artifacts.sourcePayload.id,
      prepared.artifacts.populationManifest.id,
      manifest.started_at,
      manifest.completed_at,
      reportedPopulation(manifest),
      manifest.population.accepted_population,
      manifest.caller_limited,
      manifest.assessment.acquisition_state,
      manifest.assessment.population_state,
    ]
  )
  if (run.rowCount !== 1) throw publicationError('metric trust run insert count mismatch')

  const contracts = await loadMetricContracts(client, prepared)
  const observationInputs = buildObservationInputs(prepared, context, contracts)
  if (observationInputs.length === 0) {
    return { sourceRunId: prepared.sourceRunId, observationsWritten: 0, artifactRefsWritten: 0 }
  }

  for (const contract of contracts) {
    for (const role of contract.required_raw_roles) {
      if (!rawRefForRole(prepared, role)) {
        throw publicationError(
          `required RAW role ${role} is unavailable for ${contract.field_path}`
        )
      }
    }
  }

  const inserted = await client.query<InsertedObservationRow>(
    `INSERT INTO arena.metric_trust_observations
       (contract_id, trader_id, source_id, snapshot_id, snapshot_scraped_at,
        source_run_id, source_contract_version, timeframe, metric, field_path,
        provenance, methodology_version, value, value_unit, currency,
        source_as_of, valid_until, window_start, window_end, quality,
        history_state, price_state, cost_basis_state, population_state,
        window_state, unit_state, freshness_state, blocking_reasons)
     SELECT contract.id,
            input.trader_id,
            $2,
            $3,
            $4,
            $5,
            contract.contract_version,
            $6,
            contract.metric,
            contract.field_path,
            contract.provenance,
            contract.methodology_version,
            input.value,
            contract.value_unit,
            $7,
            $8,
            $8::timestamptz + contract.max_freshness,
            $9,
            $8,
            input.quality,
            input.history_state,
            input.price_state,
            input.cost_basis_state,
            input.population_state,
            input.window_state,
            input.unit_state,
            input.freshness_state,
            input.blocking_reasons
       FROM jsonb_to_recordset($1::jsonb) AS input(
         contract_id bigint,
         trader_id bigint,
         value numeric,
         quality text,
         history_state text,
         price_state text,
         cost_basis_state text,
         population_state text,
         window_state text,
         unit_state text,
         freshness_state text,
         blocking_reasons jsonb
       )
       JOIN arena.metric_source_contracts AS contract
         ON contract.id = input.contract_id
     RETURNING id::text AS id, contract_id::text AS contract_id, trader_id::text AS trader_id`,
    [
      JSON.stringify(observationInputs),
      prepared.src.id,
      context.snapshotId,
      context.snapshotScrapedAt,
      prepared.sourceRunId,
      prepared.timeframe,
      prepared.src.currency,
      prepared.sourceAsOf,
      prepared.windowStart,
    ]
  )
  if (
    inserted.rowCount !== observationInputs.length ||
    inserted.rows.length !== observationInputs.length
  ) {
    throw publicationError('metric observation insert count mismatch')
  }
  const expectedObservationKeys = new Set(
    observationInputs.map((row) => `${row.contract_id}:${row.trader_id}`)
  )
  const insertedObservationKeys = new Set(
    inserted.rows.map((row) => `${row.contract_id}:${row.trader_id}`)
  )
  if (
    expectedObservationKeys.size !== insertedObservationKeys.size ||
    [...expectedObservationKeys].some((key) => !insertedObservationKeys.has(key))
  ) {
    throw publicationError('metric observation receipts do not match requested rows')
  }

  const contractsById = new Map(contracts.map((contract) => [contract.id, contract]))
  const artifactInputs = inserted.rows.flatMap((observation) => {
    const contract = contractsById.get(observation.contract_id)
    if (!contract) throw publicationError(`unknown inserted contract ${observation.contract_id}`)
    return contract.required_raw_roles.map((role) => {
      const raw = rawRefForRole(prepared, role)
      if (!raw) throw publicationError(`required RAW role ${role} disappeared during publication`)
      return { observation_id: observation.id, role, ...raw }
    })
  })
  const artifacts = await client.query<ExistingArtifactRow>(
    `INSERT INTO arena.metric_trust_artifacts
       (observation_id, role, raw_object_id, content_hash)
     SELECT observation_id, role, raw_object_id, content_hash
       FROM jsonb_to_recordset($1::jsonb) AS input(
         observation_id bigint,
         role text,
         raw_object_id bigint,
         content_hash text
       )
     RETURNING observation_id::text AS observation_id,
               role,
               raw_object_id::text AS raw_object_id,
               content_hash`,
    [JSON.stringify(artifactInputs)]
  )
  if (
    artifacts.rowCount !== artifactInputs.length ||
    artifacts.rows.length !== artifactInputs.length
  ) {
    throw publicationError('metric artifact insert count mismatch')
  }
  const expectedArtifactKeys = new Set(
    artifactInputs.map(
      (row) => `${row.observation_id}:${row.role}:${row.raw_object_id}:${row.content_hash}`
    )
  )
  const insertedArtifactKeys = new Set(
    artifacts.rows.map(
      (row) => `${row.observation_id}:${row.role}:${row.raw_object_id}:${row.content_hash}`
    )
  )
  if (
    expectedArtifactKeys.size !== insertedArtifactKeys.size ||
    [...expectedArtifactKeys].some((key) => !insertedArtifactKeys.has(key))
  ) {
    throw publicationError('metric artifact receipts do not match requested references')
  }

  return {
    sourceRunId: prepared.sourceRunId,
    observationsWritten: observationInputs.length,
    artifactRefsWritten: artifactInputs.length,
  }
}

/**
 * Return an existing, byte-bound successful publication only after checking
 * every serving row, observation, and artifact reference. Used both before a
 * retry writes and after an uncertain COMMIT response.
 */
export async function reconcileLeaderboardMetricTrust(
  client: PoolClient,
  prepared: PreparedLeaderboardMetricTrust
): Promise<ExistingTrustedPublication | null> {
  const runResult = await client.query<ExistingRunRow>(
    `SELECT run.source_id,
            run.timeframe,
            run.snapshot_id::text AS snapshot_id,
            run.snapshot_scraped_at::text AS snapshot_scraped_at,
            run.population_raw_object_id::text AS population_raw_object_id,
            run.manifest_raw_object_id::text AS manifest_raw_object_id,
            run.started_at::text AS started_at,
            run.completed_at::text AS completed_at,
            run.reported_population,
            run.fetched_population,
            run.caller_limited,
            run.acquisition_state,
            run.population_state,
            snapshot.expected_count,
            snapshot.actual_count,
            snapshot.baseline_used,
            snapshot.count_check_passed,
            snapshot.is_derived,
            snapshot.raw_object_id::text AS snapshot_raw_object_id,
            snapshot.source_id AS current_snapshot_source_id,
            snapshot.timeframe AS current_snapshot_timeframe,
            snapshot.scraped_at::text AS current_snapshot_scraped_at,
            population.content_hash AS population_content_hash,
            population.quarantined AS population_quarantined,
            population.source_run_id AS population_source_run_id,
            population.trust_artifact_role AS population_role,
            population.meta AS population_meta,
            manifest.content_hash AS manifest_content_hash,
            manifest.quarantined AS manifest_quarantined,
            manifest.source_run_id AS manifest_source_run_id,
            manifest.trust_artifact_role AS manifest_role,
            manifest.meta AS manifest_meta
       FROM arena.metric_trust_runs AS run
       JOIN arena.leaderboard_snapshots AS snapshot ON snapshot.id = run.snapshot_id
       JOIN arena.raw_objects AS population ON population.id = run.population_raw_object_id
       JOIN arena.raw_objects AS manifest ON manifest.id = run.manifest_raw_object_id
      WHERE run.source_run_id = $1`,
    [prepared.sourceRunId]
  )
  if (runResult.rows.length === 0) return null
  if (runResult.rows.length !== 1)
    throw publicationError('source run resolved to multiple snapshots')
  const run = runResult.rows[0]
  const manifest = prepared.manifest
  if (
    run.source_id !== prepared.src.id ||
    run.timeframe !== prepared.timeframe ||
    Number(run.population_raw_object_id) !== prepared.artifacts.sourcePayload.id ||
    Number(run.manifest_raw_object_id) !== prepared.artifacts.populationManifest.id ||
    Number(run.snapshot_raw_object_id) !== prepared.artifacts.sourcePayload.id ||
    run.current_snapshot_source_id !== prepared.src.id ||
    run.current_snapshot_timeframe !== prepared.timeframe ||
    !sameTimestamp(run.current_snapshot_scraped_at, manifest.completed_at) ||
    !sameTimestamp(run.started_at, manifest.started_at) ||
    !sameTimestamp(run.completed_at, manifest.completed_at) ||
    !sameTimestamp(run.snapshot_scraped_at, manifest.completed_at) ||
    run.reported_population !== reportedPopulation(manifest) ||
    run.fetched_population !== prepared.rows.length ||
    run.caller_limited !== manifest.caller_limited ||
    run.acquisition_state !== manifest.assessment.acquisition_state ||
    run.population_state !== manifest.assessment.population_state ||
    run.actual_count !== prepared.rows.length ||
    !run.count_check_passed ||
    run.is_derived ||
    run.population_content_hash !== prepared.artifacts.sourcePayload.contentHash ||
    run.population_quarantined ||
    run.population_source_run_id !== prepared.sourceRunId ||
    run.population_role !== 'source_payload' ||
    !hasCanonicalRawIntegrity(run.population_meta) ||
    run.manifest_content_hash !== prepared.sourceRunId ||
    run.manifest_quarantined ||
    run.manifest_source_run_id !== prepared.sourceRunId ||
    run.manifest_role !== 'population_manifest' ||
    !hasCanonicalRawIntegrity(run.manifest_meta)
  ) {
    throw publicationError('existing source run does not exactly match the requested publication')
  }

  const snapshotId = Number(run.snapshot_id)
  assertPositiveSafeInteger(snapshotId, 'existing snapshot id')
  const entries = await client.query<ExistingEntryRow>(
    `SELECT trader.id::text AS trader_id,
            trader.source_id AS trader_source_id,
            trader.exchange_trader_id,
            entry.timeframe,
            entry.scraped_at::text AS scraped_at,
            entry.rank,
            entry.headline_roi::text AS headline_roi,
            entry.headline_pnl::text AS headline_pnl,
            entry.headline_win_rate::text AS headline_win_rate,
            entry.currency
       FROM arena.leaderboard_entries AS entry
       JOIN arena.traders AS trader ON trader.id = entry.trader_id
      WHERE entry.snapshot_id = $1
      ORDER BY trader.exchange_trader_id`,
    [snapshotId]
  )
  if (entries.rows.length !== prepared.rows.length) {
    throw publicationError('existing snapshot entry count does not match requested rows')
  }
  const inputByExchangeId = new Map(
    prepared.rows.map((row) => [row.exchangeTraderId, row] as const)
  )
  const traderIds = new Map<string, number>()
  for (const entry of entries.rows) {
    const expected = inputByExchangeId.get(entry.exchange_trader_id)
    const traderId = Number(entry.trader_id)
    if (
      !expected ||
      !Number.isSafeInteger(traderId) ||
      traderId <= 0 ||
      entry.trader_source_id !== prepared.src.id ||
      entry.timeframe !== prepared.timeframe ||
      !sameTimestamp(entry.scraped_at, manifest.completed_at) ||
      entry.rank !== expected.rank ||
      !sameNumeric(entry.headline_roi, expected.headlineRoi) ||
      !sameNumeric(entry.headline_pnl, expected.headlinePnl) ||
      !sameNumeric(entry.headline_win_rate, expected.headlineWinRate) ||
      entry.currency !== prepared.src.currency
    ) {
      throw publicationError(`existing entry mismatch for ${entry.exchange_trader_id}`)
    }
    traderIds.set(entry.exchange_trader_id, traderId)
  }

  const contracts = await loadMetricContracts(client, prepared)
  const context = {
    snapshotId,
    snapshotScrapedAt: canonicalTimestamp(run.snapshot_scraped_at, 'snapshot scraped_at'),
    traderIds,
  }
  const expectedObservations = buildObservationInputs(prepared, context, contracts)
  const observations = await client.query<ExistingObservationRow>(
    `SELECT observation.id::text AS id,
            observation.contract_id::text AS contract_id,
            observation.trader_id::text AS trader_id,
            trader.exchange_trader_id,
            observation.value::text AS value,
            observation.quality,
            observation.history_state,
            observation.price_state,
            observation.cost_basis_state,
            observation.population_state,
            observation.window_state,
            observation.unit_state,
            observation.freshness_state,
            observation.blocking_reasons,
            observation.source_as_of::text AS source_as_of,
            observation.valid_until::text AS valid_until,
            observation.window_start::text AS window_start,
            observation.window_end::text AS window_end
       FROM arena.metric_trust_observations AS observation
       JOIN arena.traders AS trader ON trader.id = observation.trader_id
      WHERE observation.snapshot_id = $1
      ORDER BY observation.contract_id, observation.trader_id`,
    [snapshotId]
  )
  if (observations.rows.length !== expectedObservations.length) {
    throw publicationError('existing metric observation count mismatch')
  }
  const expectedByObservationKey = new Map(
    expectedObservations.map((observation) => [
      `${observation.contract_id}:${observation.trader_id}`,
      observation,
    ])
  )
  const contractsById = new Map(contracts.map((contract) => [contract.id, contract]))
  const observationIds = new Set<string>()
  for (const observation of observations.rows) {
    const expected = expectedByObservationKey.get(
      `${observation.contract_id}:${observation.trader_id}`
    )
    const contract = contractsById.get(observation.contract_id)
    if (!expected || !contract || expected.exchange_trader_id !== observation.exchange_trader_id) {
      throw publicationError('existing metric observation identity mismatch')
    }
    const validUntil = new Date(
      Date.parse(prepared.sourceAsOf) + Number(contract.max_freshness_ms)
    ).toISOString()
    if (
      !sameNumeric(observation.value, expected.value) ||
      observation.quality !== expected.quality ||
      observation.history_state !== expected.history_state ||
      observation.price_state !== expected.price_state ||
      observation.cost_basis_state !== expected.cost_basis_state ||
      observation.population_state !== expected.population_state ||
      observation.window_state !== expected.window_state ||
      observation.unit_state !== expected.unit_state ||
      observation.freshness_state !== expected.freshness_state ||
      !sameJson(observation.blocking_reasons, expected.blocking_reasons) ||
      !sameTimestamp(observation.source_as_of, prepared.sourceAsOf) ||
      !sameTimestamp(observation.valid_until, validUntil) ||
      !sameTimestamp(observation.window_start, prepared.windowStart) ||
      !sameTimestamp(observation.window_end, prepared.sourceAsOf)
    ) {
      throw publicationError(
        `existing metric observation mismatch for ${observation.exchange_trader_id}`
      )
    }
    observationIds.add(observation.id)
  }

  const artifactRows =
    observationIds.size === 0
      ? []
      : (
          await client.query<ExistingArtifactRow>(
            `SELECT observation_id::text AS observation_id,
                    role,
                    raw_object_id::text AS raw_object_id,
                    content_hash
               FROM arena.metric_trust_artifacts
              WHERE observation_id = ANY($1::bigint[])
              ORDER BY observation_id, role, raw_object_id`,
            [[...observationIds]]
          )
        ).rows
  const expectedArtifacts = observations.rows.flatMap((observation) => {
    const contract = contractsById.get(observation.contract_id)
    if (!contract) throw publicationError('existing observation references an unknown contract')
    return contract.required_raw_roles.map((role) => {
      const raw = rawRefForRole(prepared, role)
      if (!raw) throw publicationError(`required RAW role ${role} is unavailable during replay`)
      return `${observation.id}:${role}:${raw.raw_object_id}:${raw.content_hash}`
    })
  })
  const actualArtifacts = artifactRows.map(
    (artifact) =>
      `${artifact.observation_id}:${artifact.role}:${artifact.raw_object_id}:${artifact.content_hash}`
  )
  const sortedExpectedArtifacts = sorted(expectedArtifacts)
  const sortedActualArtifacts = sorted(actualArtifacts)
  if (
    sortedExpectedArtifacts.length !== sortedActualArtifacts.length ||
    sortedExpectedArtifacts.some((value, index) => value !== sortedActualArtifacts[index])
  ) {
    throw publicationError('existing metric artifact references do not match requested evidence')
  }

  return {
    snapshotId,
    scrapedAt: canonicalTimestamp(run.snapshot_scraped_at, 'snapshot scraped_at'),
    expectedCount: run.expected_count,
    actualCount: run.actual_count,
    baselineUsed: run.baseline_used,
    traderIds,
    trust: {
      sourceRunId: prepared.sourceRunId,
      observationsWritten: expectedObservations.length,
      artifactRefsWritten: expectedArtifacts.length,
      replayed: true,
    },
  }
}
