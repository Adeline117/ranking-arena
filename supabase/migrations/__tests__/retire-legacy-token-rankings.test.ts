import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260804043000_retire_legacy_token_rankings.sql'),
  'utf8'
)
const generationBarrier = readFileSync(
  resolve(root, 'supabase/migrations/20260729230000_token_ranking_generation_barrier.sql'),
  'utf8'
)
const unifiedLegacySource = readFileSync(
  resolve(root, 'supabase/migrations/20260715034500_unify_token_rankings_source.sql'),
  'utf8'
)
const pg17Proof = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/token-ranking-generation-barrier.pg17.sh'),
  'utf8'
)

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function functionBody(
  sql: string,
  name: string,
  declaration = 'CREATE OR REPLACE FUNCTION'
): string {
  const marker = `${declaration} ${name}(`
  const start = sql.indexOf(marker)
  if (start < 0) throw new Error(`function declaration not found: ${name}`)
  const bodyStartMarker = 'AS $function$'
  const bodyStart = sql.indexOf(bodyStartMarker, start)
  if (bodyStart < 0) throw new Error(`function body start not found: ${name}`)
  const contentStart = bodyStart + bodyStartMarker.length
  const bodyEnd = sql.indexOf('$function$;', contentStart)
  if (bodyEnd < 0) throw new Error(`function body end not found: ${name}`)
  return sql.slice(contentStart, bodyEnd)
}

const predecessorBodies = new Map<string, string>([
  [
    'arena.token_trader_ranking_page_payload_v1',
    functionBody(generationBarrier, 'arena.token_trader_ranking_page_payload_v1'),
  ],
  [
    'public.get_token_trader_rankings',
    functionBody(generationBarrier, 'public.get_token_trader_rankings'),
  ],
  [
    'public.get_popular_tokens',
    functionBody(unifiedLegacySource, 'public.get_popular_tokens', 'CREATE FUNCTION'),
  ],
  [
    'public.get_token_ranking_publication_head',
    functionBody(generationBarrier, 'public.get_token_ranking_publication_head'),
  ],
  [
    'public.get_token_trader_rankings_v2',
    functionBody(generationBarrier, 'public.get_token_trader_rankings_v2'),
  ],
  ['public.get_popular_tokens_v2', functionBody(generationBarrier, 'public.get_popular_tokens_v2')],
  [
    'public.refresh_popular_tokens_mv',
    functionBody(generationBarrier, 'public.refresh_popular_tokens_mv'),
  ],
])

const targetBodies = new Map(
  [...predecessorBodies.keys()].map((name) => [name, functionBody(migration, name)])
)

describe('legacy token-ranking retirement', () => {
  it('is one PG17-only repeatable transaction serialized with the refresh head', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(migration).toContain('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    expect(migration).toContain("SET LOCAL lock_timeout = '10s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain('20260804-retire-legacy-token-rankings')
    expect(migration).toContain("server_version_num')::integer / 10000 <> 17")
    expect(migration).toContain('FROM ONLY arena.token_ranking_publication_head AS publication')
    expect(migration).toContain('FOR UPDATE NOWAIT')
  })

  it('pins every exact predecessor and target body hash', () => {
    const expectedPredecessors: Record<string, string> = {
      'arena.token_trader_ranking_page_payload_v1':
        '531d6e567c5d40f173fda139d595930eb11e6b643ca85af3b690baba1b469222',
      'public.get_token_trader_rankings':
        '2c04bf68408f89695eff963312fb5407d3d1095c7708d987cee06dd4308c9e65',
      'public.get_popular_tokens':
        '57d5e4bea3513f1f4708c757eb01d83a09118a0e815b277983c932b4ec0d783e',
      'public.get_token_ranking_publication_head':
        '95e5faadb55be164014870f19a848dfeb7b7d10b33261568acdae94f38c0f7cf',
      'public.get_token_trader_rankings_v2':
        '51cb3103a603ae285e620cf59818a363c7d175c77eae28495a9d69aa15cd0f06',
      'public.get_popular_tokens_v2':
        'dc03334d8871a13be430de004a2f72adec3ccaeb6a7872ea294c3b369a9254ff',
      'public.refresh_popular_tokens_mv':
        'bed3694b0b91b860da8aaa2d0fcf94fbe3ca19489e6fed0fcbae4f08f02a5108',
    }

    for (const [name, expectedHash] of Object.entries(expectedPredecessors)) {
      expect(sha256(predecessorBodies.get(name)!)).toBe(expectedHash)
      expect(migration).toContain(expectedHash)
    }

    for (const name of [
      'arena.token_trader_ranking_page_payload_v1',
      'public.get_token_trader_rankings',
      'public.get_popular_tokens',
      'public.get_token_trader_rankings_v2',
      'public.get_popular_tokens_v2',
    ]) {
      expect(sha256(targetBodies.get(name)!)).toBe(
        'b1abcb9e518dc30cbe2b266c30925b305a623df663fce576186fd6d378188a9e'
      )
    }
    expect(sha256(targetBodies.get('public.get_token_ranking_publication_head')!)).toBe(
      'b24f3284f48fda1a79c0f3aff2027b00c7bc51c1669d49dcfc6667a9c84b55b0'
    )
    expect(sha256(targetBodies.get('public.refresh_popular_tokens_mv')!)).toBe(
      '75fe59844b765986a8d631a16cfc14efae8b55ad5afd3906ca616e94253de6f0'
    )
  })

  it('keeps all seven OIDs while removing every legacy publication body', () => {
    expect(migration.match(/CREATE OR REPLACE FUNCTION /g)).toHaveLength(7)
    expect(migration).not.toMatch(/\bDROP\s+(?:MATERIALIZED\s+VIEW|FUNCTION)\b/i)

    for (const [name, body] of targetBodies) {
      expect(body).not.toContain('mv_token_trader_daily_90d')
      expect(body).not.toContain('mv_popular_tokens_90d')
      expect(body).not.toContain('trader_position_history')
      if (name === 'public.get_token_ranking_publication_head') {
        expect(body).toContain('0::bigint')
        expect(body).toContain('NULL::timestamp with time zone')
      } else {
        expect(body).toContain("USING ERRCODE = '55000'")
      }
    }

    expect(migration).toContain('legacy token rankings are retired; authority snapshot required')
    expect(migration).toContain(
      'legacy token ranking refresh is retired; authority snapshot publisher required'
    )
  })

  it('zeros durable publication state and disables only the exact existing cron', () => {
    expect(migration).toContain('UPDATE ONLY arena.token_ranking_publication_head AS publication')
    for (const assignment of [
      'generation_seq = 0',
      'published_at = NULL',
      'window_through_date = NULL',
      'source_as_of = NULL',
      'source_through_date = NULL',
      'daily_row_count = 0',
      'popular_row_count = 0',
    ]) {
      expect(migration).toContain(assignment)
    }
    expect(migration).toContain("job.jobname = 'refresh-mv-popular-tokens'")
    expect(migration).toContain("job.schedule = '*/30 * * * *'")
    expect(migration).toContain(
      "'SET statement_timeout = ''25min''; SELECT public.refresh_popular_tokens_mv();'"
    )
    expect(migration).toContain('SET active = false')
    expect(migration).not.toContain('cron.unschedule')
  })

  it('dynamically removes delegated function, table and column privileges', () => {
    expect(migration).toContain('DO $normalize_function_acls$')
    expect(migration).toContain('DO $normalize_mv_acls$')
    expect(migration.match(/pg_catalog\.aclexplode/g)?.length).toBeGreaterThanOrEqual(6)
    expect(migration).toContain('FROM PUBLIC CASCADE')
    expect(migration).toContain('REVOKE ALL PRIVILEGES ON FUNCTION %I.%I(%s) FROM %I CASCADE')
    expect(migration).toContain('REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM %I CASCADE')
    expect(migration).toContain('attribute_row.attacl')
    expect(migration).toContain('REVOKE %s (%I) ON TABLE %I.%I FROM %I CASCADE')
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.get_token_ranking_publication_head()'
    )
    expect(migration).toContain('TO service_role;')
  })

  it('ships PG17 evidence for cache ordering, wrappers, direct MVs, OIDs and replay', () => {
    for (const marker of [
      'legacy wrappers reach the predecessor publication',
      'retirement unexpectedly cut through an in-flight refresh',
      'in-flight refresh makes retirement fail without a partial cutover',
      'drained predecessor refresh publishes before retirement retry',
      'rolling cache publication reads retired head before any payload',
      'generation zero blocks the cache payload branch',
      'retired owner wrapper unexpectedly succeeded',
      'retirement keeps only service head EXECUTE and closes delegated functions/MVs',
      'all five runtime/delegated roles are closed across every retired object',
      'service_role unexpectedly read the retired token MV',
      'retirement preserves all seven function and two MV OIDs',
      'retirement does not rewrite legacy MV contents',
      'retirement disables the exact cron without changing its identity',
      'legacy token ranking retirement replay is byte-stable',
      'legacy token ranking retirement PostgreSQL 17 proof passed',
    ]) {
      expect(pg17Proof).toContain(marker)
    }
    expect(pg17Proof).toContain('psql_db -q -f "$RETIREMENT_MIGRATION"')
    // One intentional in-flight failure, followed by the successful cutover
    // and one byte-stable replay.
    expect(pg17Proof.match(/psql_db -q -f "\$RETIREMENT_MIGRATION"/g)).toHaveLength(3)
  })
})
