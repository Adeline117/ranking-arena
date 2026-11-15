/**
 * Test helper: turn one identity capture into the attempt-bound V3 evidence
 * that the season publisher accepts, and evaluate a port of
 * public.rank_publication_trust_evidence on it (both completeness modes).
 *
 * Adapter tests call `attemptBoundEvidenceForCapture` with the capture their
 * `captureLeaderboard` returned, the accepted/rejected counts from
 * validateLeaderboardRows, and (exhausted mode) the declaration the source's
 * migration registers. `trustBound` is true only when the DB predicate would
 * bind the board; `reason` says which condition failed.
 *
 * Not used by production code.
 */

import {
  exhaustionCompletenessHolds,
  type LeaderboardExhaustionDeclaration,
} from '../acquisition-exhaustion'
import {
  LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
  buildLeaderboardAcquisitionManifestV3,
  type BuiltLeaderboardAcquisitionManifestV3,
} from '../acquisition-manifest'
import {
  ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT,
  projectLeaderboardManifestV3Outcome,
  type LeaderboardAcquisitionAttempt,
  type LeaderboardManifestOutcomeProjection,
} from '../acquisition-attempts'
import type { RankingTimeframe, SourceRow } from '../core/types'
import type { LeaderboardCapture } from '../fetch/capture'
import { strictCanonicalJson } from '../strict-canonical-json'

export interface AttemptBoundEvidenceInput {
  capture: LeaderboardCapture
  source: Pick<SourceRow, 'id' | 'slug' | 'adapter_slug' | 'page_size' | 'pagination_kind'>
  timeframe: RankingTimeframe
  acceptedPopulation: number
  rejectedRowCount: number
  /** The source's arena.leaderboard_exhaustion_contracts declaration; null = not registered. */
  registeredExhaustion?: LeaderboardExhaustionDeclaration | null
}

export interface AttemptBoundEvidenceResult {
  built: BuiltLeaderboardAcquisitionManifestV3
  projection: LeaderboardManifestOutcomeProjection
  completenessMode: 'reported_total' | 'exhausted' | 'none'
  trustBound: boolean
  reason: string | null
}

export function attemptBoundEvidenceForCapture(
  input: AttemptBoundEvidenceInput
): AttemptBoundEvidenceResult {
  const { capture, source } = input
  const fetched = capture.sourcePages.map((page) => page.rawPage.fetchedAt).sort()
  const startedAt = fetched[0] ?? new Date(0).toISOString()
  const completedAt = fetched.at(-1) ?? startedAt
  const attempt: LeaderboardAcquisitionAttempt = {
    attemptId: '00000000-0000-4000-8000-000000000001',
    attemptSeq: 7,
    sourceId: source.id,
    sourceSlug: source.slug,
    adapterSlug: source.adapter_slug,
    timeframe: input.timeframe,
    observationCycleId: `tier-a:${source.slug}:fixture`,
    queueJobId: 'job-1',
    queueAttempt: 1,
    captureContract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT,
    attemptBindingContract: LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
    runnerGitSha: 'a'.repeat(40),
    workerRegion: 'local',
    sourceStatus: 'active',
    sourceServingMode: 'serving',
    sourceCurrency: 'USDT',
    sourceFetchRegion: 'local',
    recordedStartedAt: startedAt,
  }
  const built = buildLeaderboardAcquisitionManifestV3({
    source: {
      id: source.id,
      slug: source.slug,
      adapter_slug: source.adapter_slug,
      configured_page_size: source.page_size,
      configured_pagination_kind: source.pagination_kind,
    },
    surface: 'tier_a_leaderboard',
    timeframe: input.timeframe,
    started_at: startedAt,
    completed_at: completedAt,
    runner_git_sha: attempt.runnerGitSha,
    observation_cycle_id: attempt.observationCycleId,
    capture_evidence_state: 'verified',
    termination_reason: capture.terminationReason,
    capture_config: capture.captureConfig,
    source_pages: capture.sourcePages.map((page) => ({
      raw_page: page.rawPage,
      source_row_count: page.sourceRowCount,
      request_sha256: page.requestSha256,
      http_status: page.httpStatus,
      pagination_position: page.paginationPosition,
      source_reports: page.sourceReports,
    })),
    parse_pages: capture.parsePages,
    parser_transformation: capture.parserTransformation,
    accepted_population: input.acceptedPopulation,
    rejected_row_count: input.rejectedRowCount,
    acquisition_attempt: {
      binding_contract: LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
      attempt_id: attempt.attemptId,
      attempt_seq: attempt.attemptSeq,
    },
    ...(capture.completeness ? { completeness: capture.completeness } : {}),
  })
  const projection = projectLeaderboardManifestV3Outcome(attempt, built)
  const manifest = built.manifest
  const fail = (reason: string, mode: AttemptBoundEvidenceResult['completenessMode']) => ({
    built,
    projection,
    completenessMode: mode,
    trustBound: false,
    reason,
  })

  if (projection.terminalState !== 'complete') {
    return fail(
      `terminal ${projection.terminalState} (population ${projection.populationState})`,
      'none'
    )
  }
  if (projection.populationReportState === 'consistent') {
    return { built, projection, completenessMode: 'reported_total', trustBound: true, reason: null }
  }
  // Exhausted: arena.leaderboard_outcome_exhaustion_bound.
  const completeness = manifest.completeness
  if (!completeness) return fail('complete without a reported total or exhaustion proof', 'none')
  if (
    !input.registeredExhaustion ||
    strictCanonicalJson(input.registeredExhaustion) !==
      strictCanonicalJson(completeness.declaration)
  ) {
    return fail('exhaustion declaration is not the registered contract', 'exhausted')
  }
  const holds = exhaustionCompletenessHolds(completeness, {
    termination_reason: manifest.termination_reason,
    configured_page_size: manifest.source.configured_page_size,
    population_report_state: manifest.population.reports.population.state,
    source_pages: manifest.source_pages.map((page) => ({
      ordinal: page.ordinal,
      request_sha256: page.request_sha256,
      payload_sha256: page.payload.sha256,
      source_row_count: page.source_row_count,
    })),
    observed_row_count: manifest.population.observed_row_count,
    accepted_population: manifest.population.accepted_population,
    rejected_row_count: manifest.population.rejected_row_count,
    deduplicated_row_count: manifest.population.deduplicated_row_count,
  })
  if (!holds) return fail('exhaustion completeness does not hold', 'exhausted')
  return { built, projection, completenessMode: 'exhausted', trustBound: true, reason: null }
}
