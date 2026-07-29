/**
 * Print a read-only advisory report for open acquisition attempts older than
 * the selected threshold.
 *
 * Usage:
 *   INGEST_DATABASE_URL=... pnpm report:stale-leaderboard-attempts
 *   INGEST_DATABASE_URL=... pnpm report:stale-leaderboard-attempts -- \
 *     --observed-at 2026-07-29T12:00:00.000Z \
 *     --stale-after-seconds 7200 \
 *     --page-size 250
 *
 * The database session is REPEATABLE READ + READ ONLY and always ends with
 * ROLLBACK. This command has no repair, finish, abandon, or write mode.
 */

import { pathToFileURL } from 'node:url'

import { Client } from 'pg'

import {
  buildStaleAttemptDatabaseClientConfig,
  collectStaleAttemptAdvisory,
  parseStaleAttemptReportArgs,
} from './lib/stale-leaderboard-attempt-report'

function databaseUrl(): string {
  const value = process.env.INGEST_DATABASE_URL
  if (!value) {
    throw new Error(
      '[stale-attempt-report] INGEST_DATABASE_URL is required; DATABASE_URL fallback is disabled'
    )
  }
  return value
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown stale-attempt report failure'
  return message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-database-url]')
    .replace(/\b[0-9a-f]{64}\b/gi, '[redacted-digest]')
    .split(/\r?\n/, 1)[0]
    .slice(0, 500)
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseStaleAttemptReportArgs(args)
  const connectionString = databaseUrl()
  const client = new Client(buildStaleAttemptDatabaseClientConfig(connectionString))
  const suppressUnstructuredClientError = () => {
    // The command boundary emits one sanitized error below.
  }
  client.on('error', suppressUnstructuredClientError)
  let connected = false
  try {
    await client.connect()
    connected = true
    const report = await collectStaleAttemptAdvisory(client, options)
    process.stdout.write(`${JSON.stringify(report)}\n`)
  } finally {
    if (connected) await client.end().catch(() => undefined)
    client.removeListener('error', suppressUnstructuredClientError)
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`${safeErrorMessage(error)}\n`)
    process.exitCode = 1
  })
}
