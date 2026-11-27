// Driver for count-shift-anchor.pg17.sh (not a Jest test: .mts is outside the
// Jest test pattern). Replays one snapshot sequence through the real count
// check (getCountBaseline + evaluateCount) against a disposable PostgreSQL 17
// table, writing each snapshot the way publish.ts does, and prints one line
// per observation: "<t> <count> base <baseline> PASS|fail [shift adopted]
// [down-shift pending ack]".
import pg from 'pg'
import {
  BOOTSTRAP_DEVIATION_PCT,
  COUNT_SHIFT_ADOPTED_META_KEY,
  ROLLING_DEVIATION_PCT,
  evaluateCount,
  getCountBaseline,
} from '../count-check.ts'

const [connection, sequenceJson] = process.argv.slice(2)
const sequence = JSON.parse(sequenceJson) as Array<{ t: string; cycle: string; count: number }>
const client = new pg.Client({ connectionString: connection })
await client.connect()
try {
  for (const observation of sequence) {
    const result = await getCountBaseline(
      1,
      30,
      781,
      { actualCount: observation.count, cycleId: observation.cycle },
      client
    )
    const verdict = evaluateCount(
      observation.count,
      result.baseline,
      result.isBootstrap ? BOOTSTRAP_DEVIATION_PCT : ROLLING_DEVIATION_PCT
    )
    const meta: Record<string, unknown> = { observation_cycle_id: observation.cycle }
    if (result.shifted && verdict.passed && result.baseline !== null) {
      meta[COUNT_SHIFT_ADOPTED_META_KEY] = result.baseline
    }
    if (result.shiftPendingConfirmation) {
      meta.count_shift_pending = {
        proposed_baseline: result.shiftPendingConfirmation.proposedBaseline,
        current_baseline: result.shiftPendingConfirmation.currentBaseline,
      }
    }
    await client.query(
      `INSERT INTO arena.leaderboard_snapshots
         (source_id, timeframe, scraped_at, actual_count, baseline_used, count_check_passed, meta)
       VALUES (1, 30, clock_timestamp(), $1, $2, $3, $4)`,
      [observation.count, verdict.baselineUsed, verdict.passed, JSON.stringify(meta)]
    )
    process.stdout.write(
      `${observation.t} ${observation.count} base ${verdict.baselineUsed} ${verdict.passed ? 'PASS' : 'fail'}` +
        (result.shifted && verdict.passed ? ' shift adopted' : '') +
        (result.shiftPendingConfirmation
          ? ` down-shift ${result.shiftPendingConfirmation.proposedBaseline} pending ack`
          : '') +
        '\n'
    )
  }
} finally {
  await client.end()
}
