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
  it('treats legacy freshness as a required database gate after every cohort finalizer', () => {
    if (usesAtomicFinalize) {
      expect(usesAtomicFinalize).toBe(true)
      return
    }

    const incompleteGate = route.indexOf('if (upsertAborted || upsertErrors > 0)')
    const zeroOut = route.indexOf('await zeroOutExcluded({', incompleteGate)
    const cleanup = route.indexOf('await atomicPlatformCleanup(', zeroOut)
    const rerank = route.indexOf('await rerankAllRows(', cleanup)
    const freshness = route.indexOf('await upsertSourceFreshness({', rerank)
    const finalized = route.indexOf("status: 'database_finalized'", freshness)

    expect(incompleteGate).toBeGreaterThan(-1)
    expect(route.slice(incompleteGate, zeroOut)).toContain('throw new Error(')
    expect(zeroOut).toBeGreaterThan(incompleteGate)
    expect(cleanup).toBeGreaterThan(zeroOut)
    expect(rerank).toBeGreaterThan(cleanup)
    expect(freshness).toBeGreaterThan(rerank)
    expect(finalized).toBeGreaterThan(freshness)
    expect(route.slice(freshness, finalized)).not.toContain('catch (freshness')
  })

  it('never authorizes a global-count fallback or fail-open publication write', () => {
    expect(route).not.toContain('saveScoredCount(')
    expect(route).toMatch(
      /leaderboardCheckpointKey\(result\.season\),[\s\S]*?\{\s*count:\s*result\.count,\s*at:/
    )
    expect(route).not.toMatch(/tieredSet\(\s*checkpointKey\s*,/)
    expect(route).toMatch(
      /if\s*\(upsertAborted\s*\|\|\s*upsertErrors\s*>\s*0\)[\s\S]*?throw\s+new\s+Error\([\s\S]*?database finalization withheld/
    )
    expect(route).not.toContain('Proceeding anyway')
    expect(route).not.toContain('Advisory lock RPC failed (non-critical)')
    expect(route).not.toContain("rpc('acquire_leaderboard_lock'")
    expect(route).toContain('await acquireLeaderboardRunLease(targetSeasons)')
    expect(route).toContain('await runLease.release()')
  })

  it('never substitutes a different timeframe for missing PnL', () => {
    expect(route).not.toMatch(/\.rpc\(\s*['"]fill_null_pnl_from_siblings['"]\s*\)/)
  })

  it('withholds every authority and cache side effect unless all targets were finalized', () => {
    const completeResult = route.indexOf(
      'const databaseFinalizationComplete = isCompleteDatabaseFinalizationRun('
    )
    const authorityGate = route.indexOf(
      'if (databaseFinalizationComplete && remainingMs() > 30_000)',
      completeResult
    )
    const scopedRefresh = route.indexOf(
      "'refresh_public_rank_count_cache_for_seasons'",
      authorityGate
    )
    const authorityReadyGate = route.indexOf('if (publicationAuthorityReady)', scopedRefresh)
    const cacheInvalidate = route.indexOf(
      'await revalidateRankingPages(runLease)',
      authorityReadyGate
    )
    const cacheWarm = route.indexOf('warmupLeaderboardCache(supabase, SEASONS)', cacheInvalidate)
    const cacheSettled = route.indexOf('await Promise.allSettled(', cacheWarm)
    const marker = route.indexOf('`leaderboard:last-success:${result.season}`', cacheSettled)
    const checkpoint = route.indexOf('leaderboardCheckpointKey(result.season)', marker)

    expect(completeResult).toBeGreaterThan(-1)
    expect(authorityGate).toBeGreaterThan(completeResult)
    expect(scopedRefresh).toBeGreaterThan(authorityGate)
    expect(authorityReadyGate).toBeGreaterThan(scopedRefresh)
    expect(cacheInvalidate).toBeGreaterThan(authorityReadyGate)
    expect(cacheWarm).toBeGreaterThan(cacheInvalidate)
    expect(cacheSettled).toBeGreaterThan(cacheWarm)
    expect(marker).toBeGreaterThan(cacheSettled)
    expect(checkpoint).toBeGreaterThan(marker)
    expect(route).not.toContain('SELECT refresh_leaderboard_count_cache()')
    expect(route).not.toContain('warmupLeaderboardCache(supabase, targetSeasons)')
    expect(route).not.toContain('syncRedisSortedSet(')
    expect(route).not.toMatch(/tieredSet\(\s*['"]leaderboard:last-success['"]\s*,/)
    expect(route).toContain('tieredSetRequired(')
    expect(route).not.toContain('fireAndForget(')
    expect(route).not.toContain('deriveWinRateMDD(')
  })

  it('treats checkpoints as one target-set preflight and never skips inside computeSeason', () => {
    const contract = route.indexOf("LEADERBOARD_CHECKPOINT_CONTRACT = 'publication-v2'")
    const forceTombstone = route.indexOf('if (forceWrite) {', contract)
    const preflight = route.indexOf('const checkpointHits = new Map<Period, number>()')
    const allHit = route.indexOf('if (checkpointHits.size === targetSeasons.length)', preflight)
    const partialHit = route.indexOf('if (checkpointHits.size > 0)', allHit)
    const compute = route.indexOf('await computeSeason(', partialHit)
    const computeSeason = route.indexOf('async function computeSeason(')

    expect(contract).toBeGreaterThan(-1)
    expect(forceTombstone).toBeGreaterThan(contract)
    expect(route.slice(forceTombstone, preflight)).toContain('tieredSetRequired(')
    expect(preflight).toBeGreaterThan(forceTombstone)
    expect(route.slice(preflight, allHit)).toContain('tieredGetRequired<')
    expect(route.slice(preflight, allHit)).not.toContain('tieredGet<')
    expect(allHit).toBeGreaterThan(preflight)
    expect(partialHit).toBeGreaterThan(allHit)
    expect(compute).toBeGreaterThan(partialHit)
    expect(route.slice(computeSeason)).not.toContain('tieredGet<')
    expect(route.slice(computeSeason)).not.toContain("status: 'checkpoint_skip'")
  })

  it('acquires one owner-token run lease before compute and releases it in finally', () => {
    const acquire = route.indexOf('await acquireLeaderboardRunLease(targetSeasons)')
    const compute = route.indexOf('await computeSeason(', acquire)
    const outerFinally = route.lastIndexOf(
      '} finally {',
      route.indexOf('async function computeSeason')
    )
    const release = route.indexOf('await runLease.release()', outerFinally)

    expect(acquire).toBeGreaterThan(-1)
    expect(compute).toBeGreaterThan(acquire)
    expect(outerFinally).toBeGreaterThan(compute)
    expect(release).toBeGreaterThan(outerFinally)
    expect(route).not.toContain('IDEMPOTENCY_KEY')
    expect(route).not.toMatch(/runLease[\s\S]*?\.del\s*\(/)
  })

  it('proves migration-first RPC availability before any live leaderboard work', () => {
    const preflight = route.indexOf('await assertRankPublicationDatabaseContract(supabase)')
    const forceCheckpoint = route.indexOf('if (forceWrite)', preflight)
    const compute = route.indexOf('await computeSeason(', preflight)
    const liveDml = route.indexOf('await upsertLeaderboard({', compute)

    expect(preflight).toBeGreaterThan(-1)
    expect(forceCheckpoint).toBeGreaterThan(preflight)
    expect(compute).toBeGreaterThan(preflight)
    expect(liveDml).toBeGreaterThan(compute)
  })

  it('reports lease contention as pending instead of a completed cached publication', () => {
    const contentionBranch = route.slice(
      route.indexOf('if (!leaseResult.acquired)'),
      route.indexOf('const runLease = leaseResult.lease')
    )

    expect(contentionBranch).toContain('publication_pending: true')
    expect(contentionBranch).toContain('status: contended ? 423 : 503')
    expect(contentionBranch).not.toContain('cached: true')
    expect(contentionBranch).not.toContain('ok: true')
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
