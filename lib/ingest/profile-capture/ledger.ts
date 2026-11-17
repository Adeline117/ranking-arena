/**
 * Worker client for the append-only profile acquisition ledger
 * (arena.start/finish_profile_acquisition_attempt, migration 20261116215328).
 *
 * The database owns attempt order and start time and re-checks every binding
 * (registered contract hash, trader of the source, RAW of exactly this
 * attempt, manifest of this attempt and trader, metrics inside the contract).
 * Recording a complete outcome authorizes nothing by itself: publication
 * accepts a value only through the trader_stats profile pointer, which the
 * table trigger checks against this outcome.
 */

import { randomUUID } from 'node:crypto'

import type { RankingTimeframe } from '../core/types'
import type { IngestQueryExecutor } from '../db'
import type { ProfileCaptureResult } from './capture'
import { profileCaptureContractSha256, type ProfileCaptureContract } from './contract'

export interface ProfileAcquisitionAttempt {
  readonly attemptSeq: number
  readonly attemptId: string
  readonly sourceId: number
  readonly traderId: number
  readonly timeframe: RankingTimeframe
  readonly captureContract: string
  readonly contractSha256: string
  readonly recordedStartedAt: string
}

export interface StartProfileAcquisitionAttemptInput {
  sourceId: number
  traderId: number
  timeframe: RankingTimeframe
  contract: ProfileCaptureContract
  runnerGitSha?: string | null
  attemptId?: string
}

export async function startProfileAcquisitionAttempt(
  db: IngestQueryExecutor,
  input: StartProfileAcquisitionAttemptInput
): Promise<ProfileAcquisitionAttempt> {
  const attemptId = input.attemptId ?? randomUUID()
  const contractSha256 = profileCaptureContractSha256(input.contract)
  const { rows } = await db.query<{ attempt_seq: number | string; recorded_started_at: Date }>(
    `SELECT attempt_seq, recorded_started_at
       FROM arena.start_profile_acquisition_attempt($1::uuid, $2, $3, $4, $5, $6, $7)`,
    [
      attemptId,
      input.sourceId,
      input.traderId,
      input.timeframe,
      input.contract.captureContract,
      contractSha256,
      input.runnerGitSha ?? null,
    ]
  )
  if (rows.length !== 1) throw new Error('[profile-capture] start returned no attempt')
  const attemptSeq = Number(rows[0].attempt_seq)
  if (!Number.isSafeInteger(attemptSeq) || attemptSeq < 1) {
    throw new Error('[profile-capture] start returned an invalid attempt sequence')
  }
  return Object.freeze({
    attemptSeq,
    attemptId,
    sourceId: input.sourceId,
    traderId: input.traderId,
    timeframe: input.timeframe,
    captureContract: input.contract.captureContract,
    contractSha256,
    recordedStartedAt: new Date(rows[0].recorded_started_at).toISOString(),
  })
}

/** RAW metadata that claims the tier_b RAW for its attempt (checked at finish). */
export function profileCaptureRawMeta(attempt: ProfileAcquisitionAttempt): Record<string, unknown> {
  return {
    profile_capture: {
      attempt_id: attempt.attemptId,
      capture_contract: attempt.captureContract,
    },
  }
}

export async function finishProfileAcquisitionAttempt(
  db: IngestQueryExecutor,
  attempt: ProfileAcquisitionAttempt,
  result: ProfileCaptureResult,
  rawObjectId: number | null
): Promise<void> {
  if (result.terminalState === 'complete') {
    if (
      rawObjectId === null ||
      result.manifest.attempt_id !== attempt.attemptId ||
      result.manifest.capture_contract !== attempt.captureContract ||
      result.manifest.capture_contract_sha256 !== attempt.contractSha256 ||
      result.manifest.timeframe !== attempt.timeframe
    ) {
      throw new Error('[profile-capture] complete outcome is not bound to its attempt')
    }
  }
  const { rows } = await db.query<{ terminal_state: string }>(
    `SELECT terminal_state
       FROM arena.finish_profile_acquisition_attempt($1, $2::uuid, $3, $4, $5, $6, $7::jsonb)`,
    [
      attempt.attemptSeq,
      attempt.attemptId,
      result.terminalState,
      result.reasonCode,
      rawObjectId,
      result.sourceRunId,
      result.manifest === null ? null : JSON.stringify(result.manifest),
    ]
  )
  if (rows.length !== 1 || rows[0].terminal_state !== result.terminalState) {
    throw new Error('[profile-capture] finish did not record the outcome')
  }
}
