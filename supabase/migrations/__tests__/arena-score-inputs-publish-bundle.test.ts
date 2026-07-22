import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260721175746_arena_score_inputs_publish_bundle.sql'),
  'utf8'
)

const functionBodyMatch = migration.match(
  /CREATE OR REPLACE FUNCTION public\.arena_score_inputs_publish_bundle_json\([\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/
)
const functionBody = functionBodyMatch?.[1] ?? ''
const registryBoards = functionBody.slice(
  functionBody.indexOf('registry_boards AS MATERIALIZED'),
  functionBody.indexOf('latest_snapshot_attempt AS MATERIALIZED')
)
const latestPassed = functionBody.slice(
  functionBody.indexOf('latest_passed_snapshot AS MATERIALIZED'),
  functionBody.indexOf('passed_entry_counts AS MATERIALIZED')
)
const physicalEvidence = functionBody.slice(
  functionBody.indexOf('physical_board_evidence AS MATERIALIZED'),
  functionBody.indexOf('physical_boards_json AS MATERIALIZED')
)

describe('arena score-input publish bundle migration', () => {
  it('adds one bounded function without replacing either legacy score-input surface', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("'public.arena_score_inputs_json(text,integer,integer)'")
    expect(migration.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1)
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.arena_score_inputs_publish_bundle_json\(\s*p_window text,\s*p_per_platform_limit int DEFAULT 1000,\s*p_max_age_hours int DEFAULT 48\s*\)\s*RETURNS jsonb/
    )
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.arena_score_inputs_json\s*\(/)
    expect(migration).not.toMatch(/CREATE OR REPLACE VIEW arena\.score_inputs/)
    expect(migration).not.toMatch(/DROP\s+(?:FUNCTION|VIEW|TABLE)/i)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('returns both payloads from one hardened SQL read statement snapshot', () => {
    expect(functionBodyMatch).not.toBeNull()
    expect(migration).toMatch(
      /LANGUAGE plpgsql\s+STABLE\s+SECURITY DEFINER\s+SET search_path = pg_catalog, pg_temp/
    )
    expect(functionBody.match(/\bRETURN\s*\(/g)).toHaveLength(1)
    expect(functionBody).toMatch(/RETURN \(\s+WITH requested_window AS MATERIALIZED/)
    expect(functionBody).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|MERGE)\b/)
    expect(functionBody).toContain("'scoreRows', public.arena_score_inputs_json(")
    expect(functionBody).toContain("'physicalBoards', physical_boards.payload")
    expect(functionBody).toContain('p_per_platform_limit')
    expect(functionBody).toContain('p_max_age_hours')
  })

  it('rejects invalid windows and non-positive read bounds before returning a bundle', () => {
    expect(functionBody).toContain("p_window NOT IN ('7D', '30D', '90D')")
    expect(functionBody).toContain('p_per_platform_limit <= 0')
    expect(functionBody).toContain('p_max_age_hours <= 0')
    expect(functionBody.match(/USING ERRCODE = '22023'/g)).toHaveLength(3)
  })

  it('starts from every active serving physical source declaring the requested window', () => {
    expect(registryBoards).toContain('source_row.slug AS registry_slug')
    expect(registryBoards).toContain('AS filter_source')
    expect(registryBoards).toContain("source_row.status = 'active'")
    expect(registryBoards).toContain("source_row.serving_mode = 'serving'")
    expect(registryBoards).toContain('source_row.timeframes_native')
    expect(registryBoards).toContain('source_row.timeframes_derived')
    expect(registryBoards).toContain('requested.timeframe = ANY')
    expect(registryBoards).toContain("<> 'null'")
    expect(registryBoards).not.toMatch(/leaderboard_(?:ranks|count_cache|source_freshness)/)
  })

  it('keeps every physical alias member so consumers can take the shared-alias MIN', () => {
    expect(functionBody).toContain('registry.registry_slug')
    expect(functionBody).toContain('registry.filter_source')
    expect(functionBody).toContain('ORDER BY evidence.registry_slug')
    expect(functionBody).not.toMatch(/GROUP BY\s+(?:registry\.)?filter_source/)
  })

  it('binds the latest PASSED snapshot deterministically and audits entry count', () => {
    expect(latestPassed).toContain('SELECT DISTINCT ON (snapshot.source_id)')
    expect(latestPassed).toContain('registry.timeframe = snapshot.timeframe')
    expect(latestPassed).toContain('WHERE snapshot.count_check_passed')
    expect(latestPassed).toMatch(
      /ORDER BY\s+snapshot\.source_id,\s+snapshot\.scraped_at DESC,\s+snapshot\.id DESC/
    )
    expect(functionBody).toContain('LEFT JOIN arena.leaderboard_entries AS entry')
    expect(functionBody).toContain('entry.scraped_at = passed.scraped_at')
    expect(functionBody).toContain('pg_catalog.count(entry.snapshot_id)::bigint')
    for (const field of [
      'registry_slug',
      'filter_source',
      'snapshot_id',
      'scraped_at',
      'actual_count',
      'entry_count',
    ]) {
      expect(functionBody).toContain(`'${field}'`)
    }
  })

  it('keeps trusted empty boards and makes unusable evidence explicit', () => {
    expect(physicalEvidence).toContain('FROM registry_boards AS registry')
    expect(physicalEvidence).toContain('LEFT JOIN latest_passed_snapshot AS passed')
    expect(physicalEvidence).toContain('ELSE COALESCE(entry_count.entry_count, 0::bigint)')
    expect(physicalEvidence).toContain("THEN 'missing'")
    expect(physicalEvidence).toContain("THEN 'failed'")
    expect(physicalEvidence).toContain("THEN 'future'")
    expect(physicalEvidence).toContain("THEN 'stale'")
    expect(physicalEvidence).toContain("THEN 'entry_count_mismatch'")
    expect(physicalEvidence).toContain("ELSE 'passed'")
    expect(physicalEvidence).toContain("interval '5 minutes'")
    expect(physicalEvidence).toContain('pg_catalog.make_interval(hours => p_max_age_hours)')
    expect(functionBody).toContain("'latest_attempt_passed'")
  })

  it('is service-role-only and reloads the PostgREST schema cache', () => {
    expect(migration).toMatch(
      /REVOKE ALL\s+ON FUNCTION public\.arena_score_inputs_publish_bundle_json\(text, int, int\)\s+FROM PUBLIC, anon, authenticated;/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE\s+ON FUNCTION public\.arena_score_inputs_publish_bundle_json\(text, int, int\)\s+TO service_role;/
    )
    expect(migration).toContain('pg_catalog.has_function_privilege(')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })
})
