import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260803183000_post_interaction_read_privacy.sql'),
  'utf8'
)

const pg17Proof = readFileSync(
  join(process.cwd(), 'supabase/migrations/__tests__/post-interaction-read-privacy.pg17.sh'),
  'utf8'
)

function dollarBlock(name: string): string {
  const block = migration.match(new RegExp(`DO \\$${name}\\$[\\s\\S]*?\\$${name}\\$;`))?.[0]
  if (!block) throw new Error(`missing ${name} block`)
  return block
}

describe('post interaction read privacy migration', () => {
  it('is bounded, serialized, and fails closed on prerequisite drift', () => {
    expect(migration).toMatch(/^-- Post interaction read privacy\./)
    expect(migration).toContain('\nBEGIN;')
    expect(migration).toContain("SET LOCAL lock_timeout = '10s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '120s'")
    expect(migration).toMatch(
      /pg_advisory_xact_lock\([\s\S]*ranking-arena:post-interaction-read-privacy:v1/
    )
    expect(migration).toContain("pg_catalog.to_regprocedure('auth.uid()')")
    expect(migration).toContain("'public.toggle_post_reaction(uuid,uuid,text)'")
    expect(migration).toContain("'public.toggle_post_vote_atomic(uuid,uuid,text)'")
    expect(migration).toContain("'public.get_hashtag_posts_page(uuid,text,integer,integer,text)'")
    expect(migration).toContain('post interaction owner functions are incompatible')
    expect(migration).toMatch(/function_row\.prosecdef[\s\S]*function_row\.proowner/)
    expect(migration).toMatch(/relation\.relkind <> 'r'/)
    expect(migration).toContain("relation.relpersistence <> 'p'")
    expect(migration).toContain('relation.relispartition')
    expect(migration).toContain("pg_catalog.pg_get_userbyid(relation.relowner) <> 'postgres'")
    expect(migration).toMatch(
      /LOCK TABLE public\.post_likes, public\.post_votes\s+IN ACCESS EXCLUSIVE MODE/
    )
    expect(migration).toContain("'user_id'::name")
    expect(migration).toContain("'uuid'::pg_catalog.regtype")
    expect(migration).toContain('\nCOMMIT;')
  })

  it('does not require authenticator but handles it when installed', () => {
    const preflight = dollarBlock('preflight')
    expect(preflight).toContain("('anon'::name)")
    expect(preflight).toContain("('authenticated'::name)")
    expect(preflight).toContain("('service_role'::name)")
    expect(preflight).toContain("('postgres'::name)")
    expect(preflight).not.toContain("('authenticator'::name)")
    expect(migration).toMatch(
      /SELECT role_row\.oid INTO v_authenticator_oid[\s\S]*role_row\.rolname = 'authenticator'/
    )
    expect(migration).toMatch(
      /v_authenticator_oid IS NOT NULL[\s\S]*has_table_privilege\([\s\S]*'authenticator'/
    )
  })

  it('removes every SELECT or FOR ALL policy while preserving pure DML policies', () => {
    const convergence = dollarBlock('policy_convergence')
    expect(convergence).toMatch(/policy_table\.relname IN \('post_likes', 'post_votes'\)/)
    expect(convergence).toContain(`policy_row.polcmd IN ('r'::"char", '*'::"char")`)
    expect(convergence).toMatch(/DROP POLICY %I ON %I\.%I/)
    expect(convergence).not.toMatch(
      /polcmd IN \([^)]*'a'|polcmd IN \([^)]*'w'|polcmd IN \([^)]*'d'/
    )

    // The migration changes only SELECT ACLs.  Existing direct DML grants and
    // pure INSERT/UPDATE/DELETE policies remain the source of end-user writes.
    expect(migration).not.toMatch(/REVOKE\s+(?:INSERT|UPDATE|DELETE)/)
    expect(migration).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE)/)
    expect(migration).not.toMatch(/FOR\s+(?:INSERT|UPDATE|DELETE)\s+TO authenticated/)
  })

  it('forces RLS and installs the exact viewer, service, and owner read authorities', () => {
    for (const table of ['post_likes', 'post_votes']) {
      expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`)
      expect(migration).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`)
      expect(migration).toMatch(
        new RegExp(
          `CREATE POLICY ${table}_authenticated_own_read[\\s\\S]*ON public\\.${table}[\\s\\S]*FOR SELECT[\\s\\S]*TO authenticated[\\s\\S]*USING \\(user_id = \\(SELECT auth\\.uid\\(\\)\\)\\)`
        )
      )
      expect(migration).toMatch(
        new RegExp(
          `CREATE POLICY ${table}_service_read[\\s\\S]*ON public\\.${table}[\\s\\S]*FOR SELECT[\\s\\S]*TO service_role[\\s\\S]*USING \\(true\\)`
        )
      )
      expect(migration).toMatch(
        new RegExp(
          `CREATE POLICY ${table}_postgres_access[\\s\\S]*ON public\\.${table}[\\s\\S]*FOR ALL[\\s\\S]*TO postgres[\\s\\S]*USING \\(true\\)[\\s\\S]*WITH CHECK \\(true\\)`
        )
      )
    }
  })

  it('converges both table and direct column SELECT ACLs for every grantee', () => {
    const tableAcl = dollarBlock('revoke_table_select')
    const columnAcl = dollarBlock('revoke_column_select')

    expect(tableAcl).toMatch(
      /pg_catalog\.aclexplode\([\s\S]*relation\.relacl[\s\S]*pg_catalog\.acldefault\('r', relation\.relowner\)/
    )
    expect(tableAcl).toContain("acl_entry.privilege_type = 'SELECT'")
    expect(tableAcl).toContain("v_grantee_sql := 'PUBLIC'")
    expect(tableAcl).toMatch(/REVOKE SELECT ON TABLE %s FROM %s/)

    expect(columnAcl).toMatch(
      /pg_catalog\.pg_attribute[\s\S]*pg_catalog\.aclexplode\(attribute_row\.attacl\)/
    )
    expect(columnAcl).toContain("acl_entry.privilege_type = 'SELECT'")
    expect(columnAcl).toMatch(/string_agg\([\s\S]*installed_column\.attnum/)
    expect(columnAcl).toMatch(/REVOKE SELECT \(%s\) ON TABLE %s FROM %s/)

    expect(migration).toMatch(
      /GRANT SELECT ON TABLE public\.post_likes, public\.post_votes\s+TO authenticated, service_role, postgres/
    )
    expect(migration).not.toMatch(/GRANT SELECT[^;]*\b(?:anon|authenticator)\b/)
  })

  it('postflights exact read-capable policies, FORCE RLS, and effective ACLs', () => {
    const postflight = dollarBlock('postflight')
    expect(postflight).toMatch(/NOT relation\.relrowsecurity OR NOT relation\.relforcerowsecurity/)
    expect(postflight).toMatch(/policy_row\.polcmd IN \('r'::"char", '\*'::"char"\)/)
    expect(postflight).toContain('HAVING pg_catalog.count(*) <> 6')
    expect(postflight).toContain("'post_likes_authenticated_own_read'::name")
    expect(postflight).toContain("'post_votes_authenticated_own_read'::name")
    expect(postflight).toContain("'post_likes_service_read'::name")
    expect(postflight).toContain("'post_votes_service_read'::name")
    expect(postflight).toContain("'post_likes_postgres_access'::name")
    expect(postflight).toContain("'post_votes_postgres_access'::name")
    expect(postflight).toMatch(/pg_catalog\.aclexplode\(attribute_row\.attacl\)/)
    expect(postflight).toContain("has_table_privilege('anon', v_table, 'SELECT')")
    expect(postflight).toContain("'authenticated', v_table, 'SELECT'")
    expect(postflight).toContain("'service_role', v_table, 'SELECT'")
    expect(postflight).toContain("'postgres', v_table, 'SELECT'")
    expect(postflight).toContain('pg_catalog.has_column_privilege(')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })

  it('has a real PostgreSQL 17 proof for leak closure and replay safety', () => {
    expect(pg17Proof).toContain('--username=cluster_admin')
    expect(pg17Proof).toContain('-U cluster_admin')
    expect(pg17Proof).toContain('PSQL_POSTGRES=(')
    expect(pg17Proof).toMatch(/run_migration\(\)[\s\S]*"\$\{PSQL_POSTGRES\[@\]\}" -f/)
    expect(pg17Proof).toContain('CREATE ROLE postgres LOGIN NOSUPERUSER NOBYPASSRLS')
    expect(pg17Proof).toContain('CREATE ROLE service_role NOLOGIN NOSUPERUSER NOBYPASSRLS')
    expect(pg17Proof).toContain('CREATE ROLE authenticator LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS')
    expect(pg17Proof).toMatch(
      /GRANT anon, authenticated, service_role TO authenticator[\s\S]*WITH INHERIT FALSE, SET TRUE/
    )
    expect(pg17Proof).toContain('ALTER TABLE public.post_likes OWNER TO postgres')
    expect(pg17Proof).toContain('ALTER TABLE public.post_votes OWNER TO postgres')
    expect(pg17Proof).toContain('migration-before-anon-leak')
    expect(pg17Proof).toContain('migration-before-authenticated-leak')
    expect(pg17Proof).toContain('run_migration prerequisite_owner_drift')
    expect(pg17Proof).toContain('migration accepted a drifted interaction dependency owner')
    expect(pg17Proof).toContain('migration-after-anon-denied')
    expect(pg17Proof).toContain('authenticated own-only read proof failed')
    expect(pg17Proof).toContain('service_role NOBYPASSRLS full read proof failed')
    expect(pg17Proof).toContain('hashtag projection interaction read proof failed')
    expect(pg17Proof).toContain('postgres owner interaction write proof failed')
    expect(pg17Proof).toContain('post interaction cascade proof failed')
    expect(pg17Proof).toContain('CREATE POLICY drift_public_select')
    expect(pg17Proof).toContain('CREATE POLICY drift_anon_all')
    expect(pg17Proof).toContain('GRANT SELECT (choice)')
    expect(pg17Proof).toContain('run_migration drift_repair')
    expect(pg17Proof).toContain('run_migration idempotent_replay')
    expect(pg17Proof).toContain('post interaction read privacy PostgreSQL 17 checks passed')
  })
})
