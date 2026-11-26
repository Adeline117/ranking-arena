/**
 * @jest-environment node
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

const MIGRATION_NAME = '20261124225312_hero_stats_exclude_idle_window.sql'
const BASELINE_NAME = '20261114103025_hero_stats_sealed_public_cohort.sql'
const migration = read(`supabase/migrations/${MIGRATION_NAME}`)
const baseline = read(`supabase/migrations/${BASELINE_NAME}`)
const proof = read('supabase/migrations/__tests__/hero-stats-exclude-idle-window.pg17.sh')
const seasonProof = read('supabase/migrations/__tests__/public-ranking-season-publication.pg17.sh')
const staleSourceProof = read(
  'supabase/migrations/__tests__/stale-source-hides-only-its-own-rows.pg17.sh'
)
const launchRunner = read('scripts/maintenance/apply-launch-migrations.sh')
const packageJson = read('package.json')
const ciWorkflow = read('.github/workflows/ci.yml')

const CURRENT_BODY_SHA256 = '9462c36f5e983078e8e25479aa8ad7235a448d428f7abeaebaa2ab3bfcaaf944'
const NEW_BODY_SHA256 = '9cfaca2859c780d4ae0b2c886a4f1c0f5cf48accb5341ff3308710a132528b4b'

/** The declaration of public.get_hero_stats() in a migration, body included. */
function functionStatement(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.get_hero_stats()')
  expect(start).toBeGreaterThanOrEqual(0)
  const end = sql.indexOf('\n$function$;', start)
  expect(end).toBeGreaterThan(start)
  return sql.slice(start, end + '\n$function$;'.length)
}

/** What PostgreSQL stores as prosrc: the text between the dollar quotes. */
function functionBody(sql: string): string {
  const statement = functionStatement(sql)
  const open = 'AS $function$'
  return statement.slice(statement.indexOf(open) + open.length, -'$function$;'.length)
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

describe('get_hero_stats excludes idle-window rows (20261124225312)', () => {
  it('replaces the latest definition in the repository, and only that one', () => {
    const definitions = readdirSync(join(process.cwd(), 'supabase/migrations'))
      .filter((name) => name.endsWith('.sql'))
      .filter((name) =>
        /CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?get_hero_stats\(/.test(
          read(`supabase/migrations/${name}`)
        )
      )
      .sort()
    expect(definitions.slice(-2)).toEqual([BASELINE_NAME, MIGRATION_NAME])
    expect(sha256(functionBody(baseline))).toBe(CURRENT_BODY_SHA256)
    expect(sha256(functionBody(migration))).toBe(NEW_BODY_SHA256)
  })

  it('is the previous declaration with one predicate added and a 5 second timeout', () => {
    const before = functionStatement(baseline)
    const after = functionStatement(migration)
    expect(before).toContain("  WHERE ranked.season_id = '90D';\n")
    expect(before).toContain("SET statement_timeout = '2s'\n")
    expect(after).toBe(
      before
        .replace(
          "  WHERE ranked.season_id = '90D';\n",
          "  WHERE ranked.season_id = '90D'\n    AND NOT ranked.idle_window;\n"
        )
        .replace("SET statement_timeout = '2s'\n", "SET statement_timeout = '5s'\n")
    )
    // Two built-in settings, no custom (dotted) one.
    expect(after.match(/^SET .+$/gm)).toEqual([
      'SET search_path = pg_catalog, pg_temp',
      "SET statement_timeout = '5s'",
    ])
    expect(after).toContain('SECURITY DEFINER')
    expect(after).toContain('RETURNS TABLE(exchange_count bigint, trader_count bigint)')
  })

  it('accepts only the current body or itself, and drops or regrants nothing', () => {
    expect(migration.match(/'[0-9a-f]{64}'/g)).toEqual([
      `'${CURRENT_BODY_SHA256}'`,
      `'${NEW_BODY_SHA256}'`,
      `'${CURRENT_BODY_SHA256}'`,
      `'${NEW_BODY_SHA256}'`,
    ])
    const statements = migration.replace(/--.*$/gm, '')
    expect(statements).not.toMatch(
      /\b(?:DROP|ALTER|GRANT|REVOKE|COMMENT ON|TRUNCATE|CREATE (?:OR REPLACE )?VIEW|CREATE (?:TEMP(?:ORARY)? )?TABLE)\b/
    )
    expect(statements.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1)
    expect(statements.match(/^DO \$migration\$/gm)).toHaveLength(1)
    expect(migration.match(/^SET LOCAL (\S+)/gm)).toEqual([
      'SET LOCAL lock_timeout',
      'SET LOCAL statement_timeout',
      'SET LOCAL search_path',
    ])
    // Owner, SECURITY and ACL are compared before and after.
    for (const attribute of ['proowner', 'prosecdef', 'proacl', 'result_type']) {
      expect(statements).toContain(`v_after.${attribute} IS DISTINCT FROM v_before.${attribute}`)
    }
    // Configuration: the current body only with 2s, this migration's body only
    // with 5s; afterwards exactly search_path plus 5s (so nothing custom).
    expect(statements.match(/'statement_timeout=2s'/g)).toHaveLength(1)
    expect(statements.match(/'statement_timeout=5s'/g)).toHaveLength(2)
    expect(statements).toContain(`WHEN '${CURRENT_BODY_SHA256}'
        THEN ARRAY['search_path=pg_catalog, pg_temp', 'statement_timeout=2s']
      ELSE ARRAY['search_path=pg_catalog, pg_temp', 'statement_timeout=5s']`)
    expect(statements).toContain(`IF v_after.proconfig IS DISTINCT FROM
       ARRAY['search_path=pg_catalog, pg_temp', 'statement_timeout=5s']::pg_catalog.text[] THEN`)
    expect(statements).toContain('apply 20261123021904 first')
  })

  it('is registered as postdeploy after every other entry, with 192134 still last', () => {
    const list = launchRunner.slice(
      launchRunner.indexOf('POSTDEPLOY_MIGRATIONS=('),
      launchRunner.indexOf('readonly -a POSTDEPLOY_MIGRATIONS')
    )
    const entries = list.match(/^ {2}\d{14}_\S+\.sql$/gm)?.map((entry) => entry.trim()) ?? []
    expect(entries.slice(-3)).toEqual([
      '20261122204058_resolve_trader_public_source.sql',
      MIGRATION_NAME,
      '20261111192134_tier_a_execution_claim_enforcement_later_raw_guards.sql',
    ])
  })

  it('is proven on PostgreSQL 17 as a non-superuser, in CI, and end to end', () => {
    expect(proof).toContain('CREATE ROLE postgres LOGIN NOSUPERUSER')
    expect(proof).toContain(`CURRENT_BODY_SHA256='${CURRENT_BODY_SHA256}'`)
    expect(proof).toContain(`NEW_BODY_SHA256='${NEW_BODY_SHA256}'`)
    for (const covered of [
      'the repository body is the body the migration accepts',
      'after: 6 rows with performance on 2 sources',
      'old rule: the function returns exactly what it returned before',
      'owner, security, ACL, return type and comment',
      'installed configuration: search_path plus a 5 second statement_timeout',
      'second replay configuration',
      'current body with the 5 second timeout',
      "this migration's body with the 2 second timeout",
      'unreviewed body',
      'another owner',
      'security invoker',
      'another statement_timeout',
      'custom parameter attached',
      'missing function',
      'view without idle_window',
      'the timing statement returns what the function returns',
    ]) {
      expect(proof).toContain(covered)
    }
    expect(packageJson).toContain(
      '"qa:hero-stats-exclude-idle-pg17": "bash supabase/migrations/__tests__/hero-stats-exclude-idle-window.pg17.sh"'
    )
    expect(ciWorkflow).toContain('run: npm run qa:hero-stats-exclude-idle-pg17')
    // The real orchestrator publishes an idle row and the hero count leaves it out.
    expect(seasonProof).toContain(MIGRATION_NAME)
    expect(seasonProof).toContain('hero stats count the 7 rows with performance, not the idle one')
    // ...and on the view as the later migration 20261124114140 re-creates it.
    expect(staleSourceProof).toContain(MIGRATION_NAME)
    expect(staleSourceProof).toContain(
      'hero stats after: only served rows that are not idle, and their sources'
    )
  })
})
