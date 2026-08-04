import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260803104500_close_hot_score_batch_public_execute.sql'
  ),
  'utf8'
)
const pg17Proof = readFileSync(
  join(process.cwd(), 'supabase/migrations/__tests__/close-hot-score-batch-public-execute.pg17.sh'),
  'utf8'
)

const authorities = [
  'refresh_hot_scores',
  'refresh_hot_scores_incremental',
  'update_post_velocity',
  'update_post_report_counts',
] as const

describe('hot-score batch public execute closure', () => {
  it('is transactional and locks migration execution', () => {
    expect(migration).toMatch(/^-- Migration:[\s\S]*\nBEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain('public.post-hot-score-batch:close-public-execute:migration')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })

  it('requires the exact four zero-argument reviewed batch bodies', () => {
    for (const authority of authorities) {
      expect(migration).toContain(`public.${authority}()`)
    }
    for (const marker of [
      'UPDATE posts SET',
      'calculate_hot_score',
      'last_hot_refresh_at',
      'UPDATE posts p SET',
      'comments_last_hour',
      'content_reports',
      'GET DIAGNOSTICS',
      'post hot-score batch overload set drifted',
    ]) {
      expect(migration).toContain(marker)
    }
    expect(migration).toContain('function_row.pronargs <> 0')
    expect(migration).toContain("function_row.prorettype = 'integer'::pg_catalog.regtype")
  })

  it('converges owner, SECURITY DEFINER, timeouts and fixed search path', () => {
    for (const authority of authorities) {
      const signature = `public.${authority}()`
      expect(migration).toContain(`ALTER FUNCTION ${signature}\n  OWNER TO postgres`)
      expect(migration).toContain(
        `ALTER FUNCTION ${signature}\n  SECURITY DEFINER VOLATILE PARALLEL UNSAFE`
      )
      expect(migration).toContain(
        `ALTER FUNCTION ${signature}\n  SET search_path TO pg_catalog, public, pg_temp`
      )
      expect(migration).toContain(`ALTER FUNCTION ${signature}\n  SET row_security TO off`)
      expect(migration).toContain(`ALTER FUNCTION ${signature}\n  SET lock_timeout TO '5s'`)
      expect(migration).toContain(`ALTER FUNCTION ${signature}\n  SET statement_timeout TO '60s'`)
    }
    expect(migration).toContain('pg_catalog.cardinality(function_row.proconfig) = 4')
  })

  it('removes PUBLIC/browser execution and grants only service_role without grant option', () => {
    for (const authority of authorities) {
      const signature = `public.${authority}()`
      expect(migration).toContain(
        `REVOKE ALL ON FUNCTION ${signature}\n  FROM PUBLIC, anon, authenticated, authenticator, service_role`
      )
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION ${signature}\n  TO service_role`)
    }
    expect(migration).toContain('pg_catalog.aclexplode')
    expect(migration).toContain('acl_entry.grantee NOT IN (v_postgres_oid, v_service_oid)')
    expect(migration).toContain('acl_entry.is_grantable')
  })

  it('attests every body and refuses silent source replacement', () => {
    expect(migration).toContain("'post-hot-score-service-authority:v1:'")
    expect(migration).toContain('pg_catalog.md5(v_source)')
    expect(migration).toContain('post hot-score batch source drifted')
    expect(migration).toContain('post hot-score batch authority drifted')
  })

  it('ships PG17 proof for original exposure, closure, replay and fail-closed drift', () => {
    for (const marker of [
      "assert_scalar 't|t|t|t'",
      "assert_scalar 'f|f|f|t'",
      'SET ROLE authenticated; SELECT public.refresh_hot_scores()',
      'permission denied for function refresh_hot_scores',
      'TO service_role WITH GRANT OPTION',
      'ALTER FUNCTION public.refresh_hot_scores_incremental() RESET lock_timeout',
      'refresh_hot_scores(p_limit integer DEFAULT 1)',
      'migration accepted a drifted hot-score body',
      'hot-score batch public execute PG17 proof passed',
    ]) {
      expect(pg17Proof).toContain(marker)
    }
  })
})
