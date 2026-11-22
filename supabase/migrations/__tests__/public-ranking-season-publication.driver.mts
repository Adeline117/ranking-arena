/**
 * PG17 driver for public-ranking-season-publication.pg17.sh.
 *
 * Calls the real orchestrator (lib/rankings/publication/publish-season.ts)
 * against the isolated test cluster named by PGHOST/PGPORT and prints one JSON
 * line. It never reads application credentials: the shell owns a throwaway
 * cluster on a private socket.
 */
import { Pool } from 'pg'

import {
  createDefaultCohortScorer,
  pgRankPublicationDatabase,
  publishLeaderboardSeason,
  RankPublicationError,
} from '@/lib/rankings/publication/publish-season'

const season = process.argv[2]
if (season !== '7D' && season !== '30D' && season !== '90D') {
  console.error(`usage: driver <7D|30D|90D>, got ${String(season)}`)
  process.exit(64)
}

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: 'postgres',
  database: 'postgres',
  max: 2,
})

const alerts: Array<{ severity: string; code: string }> = []

try {
  const result = await publishLeaderboardSeason(season, {
    alert: (alert) => void alerts.push({ severity: alert.severity, code: alert.code }),
    database: pgRankPublicationDatabase(async () => {
      const client = await pool.connect()
      return {
        query: (text: string, values?: readonly unknown[]) =>
          client.query(text, values ? [...values] : undefined),
        release: (destroy?: boolean) => client.release(destroy),
      }
    }),
    scoreCohort: createDefaultCohortScorer(),
    // The fixture declares three sources; the production floor
    // (RANK_PUBLICATION_MIN_EXPECTED_SOURCES) has its own unit tests.
    minExpectedSources: 1,
  })
  process.stdout.write(`RESULT ${JSON.stringify({ ok: true, result, alerts })}\n`)
} catch (error) {
  const code =
    error instanceof RankPublicationError
      ? error.code
      : error instanceof Error
        ? error.name
        : 'unknown'
  const message = error instanceof Error ? error.message : String(error)
  process.stdout.write(`RESULT ${JSON.stringify({ ok: false, code, message, alerts })}\n`)
} finally {
  await pool.end()
}
