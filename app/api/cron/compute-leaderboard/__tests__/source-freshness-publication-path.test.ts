/**
 * @jest-environment node
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = process.env.LEADERBOARD_PUBLICATION_CONTRACT_ROOT ?? process.cwd()
const route = readFileSync(join(repoRoot, 'app/api/cron/compute-leaderboard/route.ts'), 'utf8')
const writer = readFileSync(
  join(repoRoot, 'app/api/cron/compute-leaderboard/write-leaderboard.ts'),
  'utf8'
)
const usesAtomicFinalize = /\bawait\s+finalizeLeaderboardPublish\s*\(/.test(route)

const FINALIZE_DEFINITION =
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?finalize_leaderboard_publish\s*\(/i

function readLatestFinalizeMigration(): { filename: string; sql: string } {
  const migrationsDirectory = join(repoRoot, 'supabase/migrations')
  const candidates = readdirSync(migrationsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => ({
      filename: entry.name,
      sql: readFileSync(join(migrationsDirectory, entry.name), 'utf8'),
    }))
    .filter(({ sql }) => FINALIZE_DEFINITION.test(sql))
    .sort((left, right) => left.filename.localeCompare(right.filename))

  const latest = candidates.at(-1)
  if (!latest) {
    throw new Error('atomic leaderboard publication has no finalize_leaderboard_publish migration')
  }
  return latest
}

function readLatestFinalizeFunction(
  sql: string,
  filename: string
): {
  definition: string
  body: string
} {
  const starts = [...sql.matchAll(new RegExp(FINALIZE_DEFINITION.source, 'gi'))]
  const start = starts.at(-1)?.index
  if (start == null) {
    throw new Error(`${filename} does not define finalize_leaderboard_publish`)
  }

  const definitionTail = sql.slice(start)
  const dollarQuote = /\bAS\s+(\$[a-z0-9_]*\$)/i.exec(definitionTail)
  if (!dollarQuote || dollarQuote.index == null) {
    throw new Error(`${filename} has no dollar-quoted finalize_leaderboard_publish body`)
  }

  const delimiter = dollarQuote[1]
  const bodyStart = dollarQuote.index + dollarQuote[0].length
  const bodyEnd = definitionTail.indexOf(delimiter, bodyStart)
  if (bodyEnd < 0) {
    throw new Error(`${filename} has an unterminated finalize_leaderboard_publish body`)
  }

  return {
    definition: definitionTail.slice(0, bodyEnd + delimiter.length),
    body: definitionTail.slice(bodyStart, bodyEnd),
  }
}

describe('compute leaderboard source freshness publication path', () => {
  it('keeps the legacy freshness write behind the complete, error-free rank-write gate', () => {
    if (usesAtomicFinalize) {
      expect(usesAtomicFinalize).toBe(true)
      return
    }

    expect(route).toMatch(
      /if\s*\(\s*!upsertAborted\s*&&\s*upsertErrors\s*===\s*0\s*\)\s*\{\s*try\s*\{[\s\S]*?\bawait\s+upsertSourceFreshness\s*\(/
    )
  })

  it('publishes source freshness inside the latest atomic finalize function before returning', () => {
    if (!usesAtomicFinalize) {
      expect(usesAtomicFinalize).toBe(false)
      return
    }

    const migration = readLatestFinalizeMigration()
    const finalize = readLatestFinalizeFunction(migration.sql, migration.filename)
    const finalReturn = [...finalize.body.matchAll(/\bRETURN\b/gi)].at(-1)?.index
    const freshnessInsert = /\bINSERT\s+INTO\s+(?:public\.)?leaderboard_source_freshness\b/i.exec(
      finalize.body
    )

    expect(finalReturn).toBeDefined()
    expect(freshnessInsert?.index).toBeDefined()
    expect(freshnessInsert?.index).toBeLessThan(finalReturn as number)

    const statementEnd = finalize.body.indexOf(';', freshnessInsert?.index ?? 0)
    expect(statementEnd).toBeGreaterThan(freshnessInsert?.index ?? -1)
    const freshnessStatement = finalize.body.slice(freshnessInsert?.index ?? 0, statementEnd + 1)

    expect(finalize.definition).toMatch(/\bp_source_publications\b/i)
    expect(freshnessStatement).toMatch(/\bsource_as_of\b/i)
    expect(freshnessStatement).toMatch(/\bpublished_rank_count\b/i)
    expect(freshnessStatement).toMatch(/\bscore_cohort_id\b/i)
    expect(freshnessStatement).not.toMatch(/\bcomputed_at\b/i)
  })

  it('passes source publications through the atomic writer RPC arguments', () => {
    if (!usesAtomicFinalize) {
      expect(usesAtomicFinalize).toBe(false)
      return
    }

    const finalizeWriterStart = writer.indexOf('export async function finalizeLeaderboardPublish')
    expect(finalizeWriterStart).toBeGreaterThan(-1)
    const nextExport = writer.indexOf('\nexport ', finalizeWriterStart + 1)
    const finalizeWriter = writer.slice(
      finalizeWriterStart,
      nextExport < 0 ? writer.length : nextExport
    )

    expect(finalizeWriter).toMatch(
      /\.rpc\(\s*['"]finalize_leaderboard_publish['"]\s*,\s*\{[\s\S]*?\bp_source_publications\s*:/
    )
    expect(finalizeWriter).not.toMatch(/\bsource_as_of\s*:\s*[^,\n]*\bcomputed_at\b/i)
  })
})
