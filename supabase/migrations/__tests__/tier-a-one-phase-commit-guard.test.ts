import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const migrationName = '20260729071500_tier_a_one_phase_commit_guard.sql'
const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations', migrationName), 'utf8')

function taggedBlock(tag: string): string {
  const match = migration.match(new RegExp(`DO \\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$;`))
  if (!match) throw new Error(`tagged block not found: ${tag}`)
  return match[1]
}

function helperBody(): string {
  const declaration = 'CREATE OR REPLACE FUNCTION arena.require_tier_a_one_phase_commit()'
  const declarationIndex = migration.indexOf(declaration)
  expect(declarationIndex).toBeGreaterThan(-1)
  const marker = 'AS $function$'
  const bodyStart = migration.indexOf(marker, declarationIndex) + marker.length
  const bodyEnd = migration.indexOf('$function$;', bodyStart)
  expect(bodyEnd).toBeGreaterThan(bodyStart)
  return migration.slice(bodyStart, bodyEnd)
}

describe('Tier-A one-phase commit guard migration', () => {
  it('is a PostgreSQL-17-pinned transaction with the claimed-writer lock order', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain("SET LOCAL lock_timeout = '10s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain('SET LOCAL search_path = pg_catalog, pg_temp;')
    expect(taggedBlock('preflight')).toMatch(
      /current_setting\('server_version_num'\)::integer\s+NOT BETWEEN 170000 AND 179999/
    )
    expect(taggedBlock('preflight')).toMatch(
      /table_row\.relowner = 'postgres'::pg_catalog\.regrole[\s\S]*?table_row\.relkind = 'r'[\s\S]*?table_row\.relrowsecurity[\s\S]*?NOT table_row\.relforcerowsecurity/
    )

    const installLock = migration.indexOf('arena.tier-a-execution-claim-enforcement-install')
    const localLock = migration.indexOf('arena.ingest-worker-authority:region:local')
    const sgLock = migration.indexOf('arena.ingest-worker-authority:region:vps_sg')
    const sourceLock = migration.indexOf("'arena.tier-a-execution-source:' || v_source_id::text")
    const tableLock = migration.indexOf(
      'LOCK TABLE arena.tier_a_execution_write_guards\n  IN ACCESS EXCLUSIVE MODE;'
    )
    const drain = migration.indexOf('DO $drain_check$')
    expect(installLock).toBeGreaterThan(0)
    expect(installLock).toBeLessThan(localLock)
    expect(localLock).toBeLessThan(sgLock)
    expect(sgLock).toBeLessThan(sourceLock)
    expect(sourceLock).toBeLessThan(tableLock)
    expect(tableLock).toBeLessThan(drain)
    expect(taggedBlock('drain_check')).toContain('Tier-A execution writes were not fully drained')
  })

  it('fails closed on the live postmaster 2PC setting before and after install', () => {
    const invariant = "pg_catalog.current_setting('max_prepared_transactions')::integer <> 0"
    expect(taggedBlock('preflight')).toContain(invariant)
    expect(helperBody()).toContain(invariant)
    expect(taggedBlock('postflight')).toContain(invariant)
    expect(
      migration.match(/Tier-A execution requires max_prepared_transactions = 0/g)
    ).toHaveLength(3)
    expect(migration.match(/USING ERRCODE = '55000'/g)).toHaveLength(3)
  })

  it('uses an owner-only stable default helper whose safe result is always true', () => {
    const body = helperBody()
    expect(createHash('sha256').update(body).digest('hex')).toBe(
      'd06a19a74542804b5a56ba6ecbece173e2b3c651aaca480a38abbada7945a431'
    )
    expect(body).toMatch(
      /IF pg_catalog\.current_setting\('max_prepared_transactions'\)::integer <> 0 THEN[\s\S]*?RAISE EXCEPTION[\s\S]*?ERRCODE = '55000'[\s\S]*?RETURN true;/
    )
    expect(migration).toMatch(
      /FUNCTION arena\.require_tier_a_one_phase_commit\(\)[\s\S]*?RETURNS boolean[\s\S]*?LANGUAGE plpgsql[\s\S]*?STABLE[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = pg_catalog, pg_temp[\s\S]*?SET statement_timeout = '5s'/
    )
    expect(migration).toContain(
      'ALTER FUNCTION arena.require_tier_a_one_phase_commit()\n  OWNER TO postgres;'
    )
    expect(migration).toContain('pg_catalog.aclexplode(')
    expect(migration).toContain('expanded.grantee <> function_row.proowner')
    expect(migration).toContain(
      'REVOKE ALL PRIVILEGES ON FUNCTION arena.require_tier_a_one_phase_commit() FROM %I CASCADE'
    )
    expect(migration).not.toMatch(
      /GRANT EXECUTE ON FUNCTION arena\.require_tier_a_one_phase_commit/
    )
  })

  it('binds every fixed assertion-RPC guard insert to the non-bypassable default', () => {
    expect(migration).toMatch(
      /ADD COLUMN IF NOT EXISTS one_phase_commit_required boolean\s+NOT NULL DEFAULT arena\.require_tier_a_one_phase_commit\(\);/
    )
    expect(migration).toMatch(
      /ALTER COLUMN one_phase_commit_required\s+SET DEFAULT arena\.require_tier_a_one_phase_commit\(\),\s+ALTER COLUMN one_phase_commit_required SET NOT NULL;/
    )
    expect(taggedBlock('preflight')).toContain(
      '09dabe40f76d4508e595c6333889a31a1310109ceebcf45522aaaf8309f8e05d'
    )
    expect(taggedBlock('postflight')).toContain(
      '09dabe40f76d4508e595c6333889a31a1310109ceebcf45522aaaf8309f8e05d'
    )
    expect(taggedBlock('postflight')).toMatch(
      /v_assert_function\.proowner <> 'postgres'::pg_catalog\.regrole[\s\S]*?NOT v_assert_function\.prosecdef[\s\S]*?v_assert_function\.prokind <> 'f'[\s\S]*?v_assert_function\.provolatile <> 'v'[\s\S]*?v_assert_function\.prorettype <> 'jsonb'::pg_catalog\.regtype/
    )
    expect(migration).toContain("v_assert_function.prosrc ~ '\\mone_phase_commit_required\\M'")
    expect(taggedBlock('postflight')).toContain("= 'arena.require_tier_a_one_phase_commit()'")
    expect(taggedBlock('postflight')).toMatch(
      /table_row\.relowner = 'postgres'::pg_catalog\.regrole[\s\S]*?table_row\.relkind = 'r'[\s\S]*?table_row\.relrowsecurity[\s\S]*?NOT table_row\.relforcerowsecurity/
    )
    expect(taggedBlock('closed_guard_table_acl')).toContain(
      'expanded.grantee <> table_row.relowner'
    )
    expect(taggedBlock('closed_guard_column_acl')).toContain(
      "expanded.grantee <>\n             'postgres'::pg_catalog.regrole"
    )
    expect(taggedBlock('postflight')).toContain(
      'Tier-A one-phase commit guard ACL is not owner-only'
    )
  })

  it('keeps the 61000 trigger and constraint closed sets unchanged', () => {
    expect(migration).not.toMatch(/CREATE\s+(?:CONSTRAINT\s+)?TRIGGER/i)
    expect(migration).not.toMatch(/ADD\s+CONSTRAINT/i)
    expect(migration).not.toMatch(
      /CREATE OR REPLACE FUNCTION arena\.assert_tier_a_execution_fence_at_commit/
    )
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION arena\.assert_tier_a_execution_write/)
  })
})
