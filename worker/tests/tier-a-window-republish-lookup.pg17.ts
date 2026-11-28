/**
 * Driver for supabase/migrations/__tests__/tier-a-window-republish-lookup.pg17.sh: runs the worker's own
 * lookup and classifier against the disposable PG17 cluster the script
 * prepares (PG_SOCKET_DIR / PG_PORT) and asserts what they return.
 */
import { Client } from 'pg'
import { validateWorkerDbFencedWriteStatement } from '@/lib/ingest/db-fenced-write-contract'
import { hasTierAExecutionWindowRepublishReceipt } from '@/worker/src/ingest/tier-a-execution-window-receipt'
import {
  classifyTierAWindowRepublishCandidate,
  findLatestTierAWindowAttempt,
  LATEST_TIER_A_WINDOW_ATTEMPT_SQL,
} from '@/worker/src/ingest/tier-a-window-republish'

function check(label: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    console.error(`FAIL: ${label}`, detail === undefined ? '' : JSON.stringify(detail))
    process.exit(1)
  }
  console.log(`ok: ${label}`)
}

async function main(): Promise<void> {
  check(
    'the lookup passes the fenced-statement contract',
    validateWorkerDbFencedWriteStatement(LATEST_TIER_A_WINDOW_ATTEMPT_SQL) ===
      LATEST_TIER_A_WINDOW_ATTEMPT_SQL.trim()
  )
  const client = new Client({
    host: process.env.PG_SOCKET_DIR,
    port: Number(process.env.PG_PORT),
    user: 'postgres',
    database: 'postgres',
  })
  await client.connect()
  try {
    await client.query('SET ROLE service_role')
    const current = {
      sourceId: 1,
      observationCycleId: 'cycle-1',
      queueJobId: 'job-1',
      queueAttempt: 2,
      claimId: '10000000-0000-4000-8000-000000000002',
      generationSeq: 17,
      gitSha: 'c'.repeat(40),
      maxFreshnessMs: 6 * 60 * 60 * 1000,
    }
    const now = '2026-11-27T12:30:00.000Z'

    const week = await findLatestTierAWindowAttempt(client, { sourceId: 1, timeframe: 7 })
    check('7D: the newest attempt wins', week?.attempt.attemptSeq === 2, week?.attempt)
    check(
      '7D: attempt fields are parsed from the real columns',
      week?.attempt.attemptId === '00000000-0000-4000-8000-000000000002' &&
        week.attempt.recordedStartedAt === '2026-11-27T10:02:00.123Z' &&
        week.attempt.queueAttempt === 1 &&
        week.attempt.executionGenerationSeq === 16 &&
        week.attempt.captureContract === 'arena.ingest.leaderboard-acquisition-manifest@3',
      week?.attempt
    )
    check(
      '7D: the exhausted outcome reports its proof and its GATED snapshot',
      week?.outcome?.terminalState === 'unknown' &&
        week.outcome.reasonCode === 'population_unknown' &&
        week.outcome.reportedPopulation === null &&
        week.outcome.exhaustionEvidencePresent === true &&
        week.outcome.gatedSnapshotPresent === true,
      week?.outcome
    )
    const weekClass = classifyTierAWindowRepublishCandidate(week && { ...week, databaseNow: now }, {
      ...current,
      timeframe: 7,
    })
    check(
      '7D: the classifier skips it as count_check_gated',
      weekClass.kind === 'skip' && weekClass.reason === 'count_check_gated',
      weekClass
    )

    const month = await findLatestTierAWindowAttempt(client, { sourceId: 1, timeframe: 30 })
    check(
      '30D: the in-progress attempt is the latest and has no outcome',
      month?.attempt.attemptSeq === 4 && month.outcome === null,
      month
    )
    check(
      '30D: no candidate',
      classifyTierAWindowRepublishCandidate(month, { ...current, timeframe: 30 }).kind === 'none'
    )

    const quarter = await findLatestTierAWindowAttempt(client, { sourceId: 1, timeframe: 90 })
    check(
      '90D: the complete outcome maps every pointer and count',
      quarter?.attempt.attemptSeq === 5 &&
        quarter.outcome?.terminalState === 'complete' &&
        quarter.outcome.sourceRunId === 'e'.repeat(64) &&
        quarter.outcome.sourcePayload.id === 1005 &&
        quarter.outcome.sourcePayload.contentHash === 'd'.repeat(64) &&
        quarter.outcome.sourcePayload.storagePath ===
          'binance_futures/tier_a_trust/source_payload_5.json.gz' &&
        quarter.outcome.populationManifest.id === 2005 &&
        quarter.outcome.captureCompletedAt === '2026-11-27T11:52:00.123Z' &&
        quarter.outcome.reportedPopulation === 10 &&
        quarter.outcome.acceptedPopulation === 10 &&
        quarter.outcome.rejectedRowCount === 0 &&
        quarter.outcome.diagnosticRawObjectId === null &&
        quarter.outcome.exhaustionEvidencePresent === false &&
        quarter.outcome.gatedSnapshotPresent === false,
      quarter
    )
    const quarterClass = classifyTierAWindowRepublishCandidate(
      quarter && { ...quarter, databaseNow: now },
      { ...current, timeframe: 90 }
    )
    check('90D: it is a candidate', quarterClass.kind === 'candidate', quarterClass)

    const none = await findLatestTierAWindowAttempt(client, { sourceId: 2, timeframe: 7 })
    check('a window without attempts returns null', none === null, none)

    // Receipt RPC probe: absent, present without EXECUTE, present with it.
    check(
      'probe: an absent republish receipt RPC reports false',
      (await hasTierAExecutionWindowRepublishReceipt(client)) === false
    )
    await client.query('RESET ROLE')
    await client.query(
      `CREATE FUNCTION arena.record_tier_a_execution_window_republish_receipt(
         p_claim_id uuid, p_generation_seq bigint, p_attempt_id uuid, p_snapshot_id bigint
       ) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb'`
    )
    await client.query(
      `REVOKE ALL ON FUNCTION arena.record_tier_a_execution_window_republish_receipt(
         uuid, bigint, uuid, bigint) FROM PUBLIC, service_role`
    )
    await client.query('SET ROLE service_role')
    check(
      'probe: the RPC without EXECUTE for current_user reports false',
      (await hasTierAExecutionWindowRepublishReceipt(client)) === false
    )
    await client.query('RESET ROLE')
    await client.query(
      `GRANT EXECUTE ON FUNCTION arena.record_tier_a_execution_window_republish_receipt(
         uuid, bigint, uuid, bigint) TO service_role`
    )
    await client.query('SET ROLE service_role')
    check(
      'probe: the RPC with EXECUTE for current_user reports true',
      (await hasTierAExecutionWindowRepublishReceipt(client)) === true
    )
  } finally {
    await client.end()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
