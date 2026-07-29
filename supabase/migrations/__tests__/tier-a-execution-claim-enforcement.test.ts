import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const migrationName = '20260729061000_tier_a_execution_claim_enforcement.sql'
const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations', migrationName), 'utf8')

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function functionBody(name: string): string {
  const escaped = escapeRegExp(name)
  const match = migration.match(
    new RegExp(
      `CREATE OR REPLACE FUNCTION ${escaped}\\(\\)[\\s\\S]*?AS \\$function\\$([\\s\\S]*?)\\$function\\$;`
    )
  )
  if (!match) throw new Error(`function body not found: ${name}`)
  return match[1]
}

function taggedBlock(tag: string): string {
  const escaped = escapeRegExp(tag)
  const match = migration.match(new RegExp(`DO \\$${escaped}\\$([\\s\\S]*?)\\$${escaped}\\$;`))
  if (!match) throw new Error(`tagged block not found: ${tag}`)
  return match[1]
}

describe('Tier-A claimed execution postdeploy enforcement', () => {
  it('is a drain-only transactional postdeploy migration with fixed lock order', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain("SET LOCAL lock_timeout = '10s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain('SET LOCAL search_path = pg_catalog, pg_temp;')
    expect(taggedBlock('preflight')).toMatch(
      /pg_catalog\.current_setting\('server_version_num'\)::integer\s+NOT BETWEEN 170000 AND 179999/
    )
    expect(taggedBlock('preflight')).toContain('Tier-A claim enforcement requires PostgreSQL 17')
    expect(migration).toContain(
      'Operations must drain every legacy Tier-A worker/queue before applying this'
    )
    expect(migration).toContain('Active claimed executions may continue after the cutover.')

    const globalLock = migration.indexOf('arena.tier-a-execution-claim-enforcement-install')
    const localLock = migration.indexOf('arena.ingest-worker-authority:region:local')
    const sgLock = migration.indexOf('arena.ingest-worker-authority:region:vps_sg')
    const sourceLock = migration.indexOf("'arena.tier-a-execution-source:' || v_source_id::text")
    const tableLock = migration.indexOf('LOCK TABLE arena.leaderboard_acquisition_attempts,')
    const tableLockEnd = migration.indexOf('IN SHARE ROW EXCLUSIVE MODE;', tableLock)
    const dependentColumnContract = migration.indexOf('DO $dependent_column_contract$')
    expect(globalLock).toBeGreaterThan(0)
    expect(globalLock).toBeLessThan(localLock)
    expect(localLock).toBeLessThan(sgLock)
    expect(sgLock).toBeLessThan(sourceLock)
    expect(sourceLock).toBeLessThan(tableLock)
    expect(tableLockEnd).toBeGreaterThan(tableLock)
    expect(dependentColumnContract).toBeGreaterThan(tableLockEnd)
    expect(dependentColumnContract).toBeLessThan(migration.indexOf('DO $drain_check$'))
    expect(migration).toContain('Tier-A execution writes were not fully drained')
  })

  it('requires current-xid guards for non-derived snapshots with OLD and NEW protection', () => {
    expect(migration).toContain('arena.require_current_tier_a_execution_guard(')
    expect(migration).toContain('pg_catalog.pg_current_xact_id()::text')
    expect(migration).toMatch(
      /JOIN arena\.sources AS source[\s\S]*?source\.status = 'active'[\s\S]*?source\.fetch_region = execution_guard\.worker_region[\s\S]*?FOR SHARE OF source/
    )
    expect(migration).toMatch(
      /IF TG_OP = 'UPDATE' AND NOT COALESCE\(OLD\.is_derived, false\)[\s\S]*?OLD\.source_id/
    )
    expect(migration).toMatch(/IF NOT COALESCE\(NEW\.is_derived, false\)[\s\S]*?NEW\.source_id/)
    expect(migration).toMatch(
      /CREATE TRIGGER leaderboard_snapshots_require_tier_a_execution\s+BEFORE INSERT OR UPDATE/
    )
    expect(migration).toMatch(
      /CREATE TRIGGER zz_leaderboard_snapshots_verify_tier_a_execution\s+AFTER INSERT OR UPDATE/
    )
    expect(migration).not.toMatch(
      /leaderboard_snapshots_require_tier_a_execution\s+BEFORE[\s\S]{0,80}\bDELETE\b/
    )
  })

  it('guards only exact Tier-A RAW and field-inventory job types without blocking deletes', () => {
    const rawBody = functionBody('arena.require_tier_a_raw_execution_guard')
    expect(rawBody).toContain("OLD.job_type IN ('tier_a', 'tier_a_manifest', 'tier_a_failure')")
    expect(rawBody).toContain("NEW.job_type IN ('tier_a', 'tier_a_manifest', 'tier_a_failure')")
    expect(rawBody).not.toMatch(/tier_b|tier_c|tier_d/)
    expect(migration).toMatch(
      /CREATE TRIGGER raw_objects_require_tier_a_execution\s+BEFORE INSERT OR UPDATE/
    )
    expect(migration).toMatch(
      /CREATE TRIGGER zz_raw_objects_verify_tier_a_execution\s+AFTER INSERT OR UPDATE/
    )
    expect(migration).not.toMatch(
      /raw_objects_require_tier_a_execution\s+BEFORE[\s\S]{0,80}\bDELETE\b/
    )

    const inventoryBody = functionBody('arena.require_tier_a_field_inventory_execution_guard')
    expect(inventoryBody).toContain("OLD.job_type = 'tier_a'")
    expect(inventoryBody).toContain("NEW.job_type = 'tier_a'")
    expect(inventoryBody).not.toContain("'tier_b'")
    expect(migration).toMatch(
      /CREATE TRIGGER upstream_field_inventory_require_tier_a_execution\s+BEFORE INSERT OR UPDATE/
    )
    expect(migration).toMatch(
      /CREATE TRIGGER zz_upstream_field_inventory_verify_tier_a_execution\s+AFTER INSERT OR UPDATE/
    )
  })

  it('keeps source authority active and region-bound through the guarded transaction', () => {
    expect(migration).toMatch(
      /JOIN arena\.sources AS source[\s\S]*?source\.status = 'active'[\s\S]*?source\.fetch_region = execution_guard\.worker_region[\s\S]*?FOR SHARE OF source/
    )
    expect(migration).toContain('arena.reject_guarded_tier_a_source_transition()')
    expect(migration).toContain('guarded Tier-A source authority cannot change before COMMIT')
    expect(migration).toMatch(
      /CREATE TRIGGER sources_reject_guarded_tier_a_transition\s+AFTER UPDATE ON arena\.sources/
    )
  })

  it('retires unclaimed begin and finish while retaining historical null rows', () => {
    expect(migration).toContain("RAISE EXCEPTION 'unclaimed acquisition begin is retired'")
    expect(migration).toContain("RAISE EXCEPTION 'unclaimed acquisition finish is retired'")
    expect(migration).toContain("USING ERRCODE = '42501'")
    expect(migration).toMatch(
      /ADD CONSTRAINT leaderboard_acquisition_attempts_execution_required[\s\S]*?execution_claim_id IS NOT NULL[\s\S]*?execution_generation_seq IS NOT NULL[\s\S]*?NOT VALID;/
    )
    expect(migration).not.toMatch(/VALIDATE CONSTRAINT/)
    expect(migration).toContain(
      "'execution_claim_id IS NOT NULL AND execution_generation_seq IS NOT NULL'"
    )
    expect(migration).toContain('pg_catalog.pg_get_expr(')
    expect(migration).toContain('constraint_row.conparentid = 0')
    expect(migration).toContain(
      "RAISE EXCEPTION 'Tier-A attempt execution requirement is already drifted'"
    )
    expect(migration).not.toMatch(/pg_get_constraintdef\([\s\S]{0,160}LIKE/)
  })

  it('rechecks source authority from both claimed attempt and outcome trigger paths', () => {
    const attemptBody = functionBody('arena.bind_tier_a_execution_attempt')
    const outcomeBody = functionBody('arena.assert_tier_a_execution_outcome')

    expect(attemptBody).toMatch(
      /IF NOT FOUND[\s\S]*?acquisition attempt does not match current Tier-A claim[\s\S]*?PERFORM arena\.require_current_tier_a_execution_guard\(v_claim\.source_id\);[\s\S]*?NEW\.execution_claim_id := v_claim_id/
    )
    expect(
      attemptBody.match(/PERFORM arena\.require_current_tier_a_execution_guard\(/g)
    ).toHaveLength(1)
    expect(outcomeBody).toMatch(
      /IF NOT COALESCE\(v_valid, false\)[\s\S]*?acquisition outcome does not match current Tier-A claim[\s\S]*?PERFORM arena\.require_current_tier_a_execution_guard\(v_source_id\);[\s\S]*?RETURN NEW/
    )
    expect(
      outcomeBody.match(/PERFORM arena\.require_current_tier_a_execution_guard\(/g)
    ).toHaveLength(1)
  })

  it('uses a two-round deferred sentinel and rejects an early forced second round', () => {
    const fenceBody = functionBody('arena.assert_tier_a_execution_fence_at_commit')

    expect(createHash('sha256').update(fenceBody).digest('hex')).toBe(
      '376421b57d55b7d4638952fb538df9a255bb0441c78e0fccb22f431b3cb4933d'
    )
    expect(migration).toMatch(
      /ALTER TABLE arena\.tier_a_execution_write_guards\s+ADD COLUMN IF NOT EXISTS verification_round smallint NOT NULL DEFAULT 0;/
    )
    expect(migration).toMatch(
      /ADD CONSTRAINT tier_a_execution_write_guards_verification_check\s+CHECK \(verification_round IN \(0, 1\)\);/
    )
    expect(taggedBlock('dependent_column_contract')).toContain(
      "'verification_round'::name, 'smallint'::pg_catalog.regtype, true"
    )
    expect(fenceBody).toMatch(
      /IF NEW\.verification_round NOT IN \(0, 1\)[\s\S]*?Tier-A execution guard verification round is invalid/
    )

    const earlyForceCheck = fenceBody.indexOf(
      'IF NEW.verification_round = 1 AND pg_catalog.pg_trigger_depth() > 1 THEN'
    )
    const liveFenceCheck = fenceBody.indexOf('IF NOT COALESCE(v_valid, false) THEN')
    const transition = fenceBody.indexOf('IF NEW.verification_round = 0 THEN')
    expect(earlyForceCheck).toBeGreaterThan(0)
    expect(earlyForceCheck).toBeLessThan(liveFenceCheck)
    expect(liveFenceCheck).toBeLessThan(transition)
    expect(fenceBody).toContain('Tier-A execution COMMIT fence cannot be forced early')
    expect(fenceBody).toMatch(
      /IF NEW\.verification_round = 0 THEN[\s\S]*?SET verification_round = 1[\s\S]*?execution_guard\.verification_round = 0;[\s\S]*?ELSE[\s\S]*?DELETE FROM arena\.tier_a_execution_write_guards[\s\S]*?execution_guard\.verification_round = 1;[\s\S]*?END IF;/
    )
    expect(fenceBody).toMatch(
      /GET DIAGNOSTICS v_changed = ROW_COUNT;[\s\S]*?IF v_changed <> 1 THEN[\s\S]*?Tier-A execution guard transition was not exact/
    )
  })

  it('proves trigger kind, final-row guards, and lazy PL/pgSQL column dependencies exactly', () => {
    expect(migration).toContain('is_constraint boolean NOT NULL DEFAULT false')
    expect(migration).toContain('expected.is_constraint')
    expect(migration).toContain('trigger_row.tgconstraint = 0')
    expect(migration).toContain('trigger_row.tgconstraint <> 0')
    expect(migration).toContain('trigger_row.tgconstrrelid <> 0')
    expect(migration).toContain('Tier-A execution trigger allowlist is not exact')
    expect(migration).toContain('zz_leaderboard_acquisition_attempts_verify_tier_a_execution')
    expect(migration).toContain('zz_leaderboard_acquisition_outcomes_verify_tier_a_execution')
    expect(migration).toContain('DO $dependent_column_contract$')
    expect(migration).toContain('attribute.atttypid IS DISTINCT FROM expected.type_oid')
    expect(migration).toContain(
      "RAISE EXCEPTION 'Tier-A enforcement dependent column contract drifted'"
    )

    expect(migration).toMatch(
      /CREATE CONSTRAINT TRIGGER tier_a_execution_fence_commit_assertion\s+AFTER INSERT OR UPDATE ON arena\.tier_a_execution_write_guards\s+DEFERRABLE INITIALLY DEFERRED/
    )
    expect(migration).toMatch(
      /'arena\.tier_a_execution_write_guards'::pg_catalog\.regclass,\s*'tier_a_execution_fence_commit_assertion',\s*'arena\.assert_tier_a_execution_fence_at_commit\(\)'::pg_catalog\.regprocedure,\s*21,\s*true,\s*true/
    )
    expect(migration).toMatch(
      /UPDATE tier_a_claim_enforcement_expected_triggers\s+SET is_constraint = true[\s\S]*?trigger_name = 'tier_a_execution_fence_commit_assertion'/
    )
    expect(taggedBlock('postflight')).toMatch(
      /trigger_row\.tgtype IS DISTINCT FROM expected\.trigger_type[\s\S]*?trigger_row\.tgdeferrable IS DISTINCT FROM expected\.is_deferrable[\s\S]*?trigger_row\.tginitdeferred IS DISTINCT FROM\s+expected\.is_initially_deferred[\s\S]*?expected\.is_constraint[\s\S]*?trigger_row\.tgconstraint = 0/
    )
  })

  it('keeps legacy RPC bodies and OIDs but closes their external ACL', () => {
    expect(migration).toContain('old_start_source text NOT NULL')
    expect(migration).toContain('old_finish_source text NOT NULL')
    expect(migration).toContain('Tier-A acquisition RPC body or identity changed')
    expect(migration).not.toMatch(/DROP FUNCTION/i)
    expect(migration).not.toMatch(
      /CREATE OR REPLACE FUNCTION arena\.start_leaderboard_acquisition_attempt\(/
    )
    expect(migration).not.toMatch(
      /CREATE OR REPLACE FUNCTION arena\.finish_leaderboard_acquisition_attempt\(/
    )
    expect(migration).toContain(
      "'arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text)'::pg_catalog.regprocedure"
    )
    expect(migration).toContain(
      "'arena.finish_leaderboard_acquisition_attempt(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,bigint,bigint,bigint,integer,text,integer,integer,text,integer,integer,integer,integer,boolean,boolean,text,text)'::pg_catalog.regprocedure"
    )
  })

  it('pins exact hashes and metadata for historical trigger functions', () => {
    const postflight = taggedBlock('postflight')
    const historicalFunctions = [
      [
        'arena.reject_direct_leaderboard_acquisition_mutation()',
        '79757dc5b663d38bf00aa5f19675d765eb6d6863a2cfc9fb99e797854fb234b0',
      ],
      [
        'arena.protect_metric_trust_raw_object()',
        'ae03cfdeb594edba511c6bffbb425e971c273626c0571c7522e2f942c242c8a0',
      ],
      [
        'arena.protect_leaderboard_acquisition_raw_evidence()',
        '3967f6e165ffeecb8c15b1df38802c74edd201f9bd4aac6fcddee8a6fa6384e2',
      ],
      [
        'arena.serialize_leaderboard_terminal_publication()',
        '3059e24b558fea0d12872eeb9892325e029e1112ca2729cbc728a8edb426430a',
      ],
    ] as const

    for (const [signature, hash] of historicalFunctions) {
      expect(postflight).toMatch(
        new RegExp(`'${escapeRegExp(signature)}'(?::\\:text)?,\\s*'${hash}'`)
      )
    }
    expect(postflight).toMatch(
      /function_row\.proowner <> 'postgres'::pg_catalog\.regrole[\s\S]*?function_row\.prosecdef IS DISTINCT FROM expected\.security_definer[\s\S]*?function_row\.provolatile::text IS DISTINCT FROM expected\.volatility[\s\S]*?function_row\.proconfig IS DISTINCT FROM expected\.config/
    )
    expect(postflight).toMatch(
      /pg_catalog\.sha256\(\s*pg_catalog\.convert_to\(function_row\.prosrc, 'UTF8'\)/
    )
  })

  it('attests the exact 65-row constraint manifest as a bidirectional closed set', () => {
    const postflight = taggedBlock('postflight')
    const manifestMatch = postflight.match(
      /WITH manifest\([\s\S]*?\) AS \(\s*VALUES([\s\S]*?)\n\s*\),\s*expected AS \(/
    )
    if (!manifestMatch) throw new Error('constraint manifest not found')

    const manifestRows = [
      ...manifestMatch[1].matchAll(
        /\('arena\.([^']+)'::pg_catalog\.regclass,\s*'([^']+)',\s*'([cfput])',\s*'([a-f0-9]{64})'\)/g
      ),
    ]
    const identities = manifestRows.map((row) => `${row[1]}.${row[2]}`)
    const counts = manifestRows.reduce<Record<string, number>>((result, row) => {
      result[row[1]] = (result[row[1]] ?? 0) + 1
      return result
    }, {})

    expect(manifestRows).toHaveLength(65)
    expect(new Set(identities).size).toBe(65)
    expect(counts).toEqual({
      leaderboard_acquisition_attempts: 3,
      tier_a_execution_claims: 28,
      tier_a_execution_heads: 7,
      tier_a_execution_window_receipts: 14,
      tier_a_execution_write_guards: 13,
    })
    expect(manifestMatch[1]).toContain(
      "'tier_a_execution_write_guards_verification_check', 'c', '0570dc05191d03c2f30b8056003ae76ab72ea0008eda77abd02654bedaaa9cec'"
    )
    expect(manifestMatch[1]).toContain(
      "'tier_a_execution_fence_commit_assertion', 't', '698fc09045e7267eeb19c5b09473ec8c40f237145be8c1cbd97b9dde2451ddc1'"
    )
    expect(postflight).toMatch(
      /manifest\.constraint_name <>\s*'leaderboard_acquisition_attempts_execution_required'\s*AS is_validated[\s\S]*?manifest\.constraint_type <> 'c' AS is_no_inherit[\s\S]*?manifest\.constraint_type = 't' AS is_deferrable[\s\S]*?manifest\.constraint_type = 't' AS is_initially_deferred/
    )
    expect(postflight).toMatch(
      /constraint_row\.convalidated AS is_validated,[\s\S]*?constraint_row\.connoinherit AS is_no_inherit,[\s\S]*?constraint_row\.conislocal AS is_local,[\s\S]*?constraint_row\.coninhcount AS inherit_count,[\s\S]*?constraint_row\.conparentid AS parent_oid,[\s\S]*?constraint_row\.condeferrable AS is_deferrable,[\s\S]*?constraint_row\.condeferred AS is_initially_deferred/
    )
    expect(postflight).toMatch(/pg_catalog\.pg_get_constraintdef\(constraint_row\.oid, true\)/)
    expect(postflight).toMatch(
      /pg_catalog\.starts_with\([\s\S]*?'leaderboard_acquisition_attempts_execution_'[\s\S]*?constraint_row\.conkey[\s\S]*?attempt_execution_columns\.attnums[\s\S]*?constraint_row\.confrelid =\s*'arena\.tier_a_execution_claims'::pg_catalog\.regclass/
    )
    expect(postflight).toMatch(
      /drift AS \(\s*\(\s*SELECT \* FROM expected\s*EXCEPT\s*SELECT \* FROM actual\s*\)\s*UNION ALL\s*\(\s*SELECT \* FROM actual\s*EXCEPT\s*SELECT \* FROM expected\s*\)\s*\)/
    )
    expect(postflight).toContain('Tier-A execution constraint allowlist is not exact')
  })

  it('exposes the exact readiness marker body, metadata, hash, and service-only ACL', () => {
    const body = functionBody('arena.tier_a_execution_claim_enforcement_state')
    expect(createHash('sha256').update(body).digest('hex')).toBe(
      '2fdc85842b2bc68331217a820de324ae274395778ab87fb072c787df251db8a4'
    )
    expect(body).toBe(
      '\n  SELECT pg_catalog.jsonb_build_object(\n' +
        "    'contract', 'arena.ingest.tier-a-execution-claim-enforcement@1',\n" +
        "    'state', 'enforced'\n" +
        '  )\n'
    )
    expect(migration).toMatch(
      /FUNCTION arena\.tier_a_execution_claim_enforcement_state\(\)[\s\S]*?RETURNS jsonb[\s\S]*?LANGUAGE sql[\s\S]*?STABLE[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = pg_catalog, pg_temp[\s\S]*?SET statement_timeout = '10s'/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION arena\.tier_a_execution_claim_enforcement_state\(\)\s+TO service_role;/
    )
  })

  it('preserves shared series/profile tables and closes only write-shaped direct ACLs', () => {
    expect(migration).not.toMatch(/arena\.trader_series(?:_weekly)?/)
    expect(migration).not.toMatch(/arena\.leaderboard_entries/)
    expect(migration).not.toMatch(/arena\.trader_stats/)
    expect(migration).toContain(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE'
    )
    expect(migration).toContain('REVOKE INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE')
    expect(migration).toContain('pg_catalog.aclexplode(attribute.attacl)')
    expect(migration).not.toMatch(/REVOKE SELECT ON TABLE/)
    expect(migration).toContain('Tier-A write table ACL is not closed')
    expect(migration).toContain('Tier-A execution substrate authority is not closed')
    expect(migration).toContain('Tier-A source control-plane ACL is not closed')
    expect(migration).toContain('LEFT JOIN LATERAL pg_catalog.aclexplode(')
    expect(migration).toContain('Tier-A enforcement function ACL is not a closed set')

    const sourceError = "RAISE EXCEPTION 'Tier-A source control-plane ACL is not closed'"
    const sourceErrorIndex = taggedBlock('postflight').indexOf(sourceError)
    const sourceContractStart = taggedBlock('postflight').lastIndexOf(
      '\n  IF EXISTS (',
      sourceErrorIndex
    )
    const sourceContract = taggedBlock('postflight').slice(sourceContractStart, sourceErrorIndex)
    expect(sourceContractStart).toBeGreaterThan(0)
    expect(sourceContract).toMatch(
      /table_row\.oid = 'arena\.sources'::pg_catalog\.regclass[\s\S]*?table_row\.relowner <> 'postgres'::pg_catalog\.regrole[\s\S]*?table_row\.relkind <> 'r'/
    )
    expect(sourceContract).toMatch(
      /expanded\.grantee <> table_row\.relowner[\s\S]*?expanded\.privilege_type IN \('TRIGGER', 'REFERENCES', 'MAINTAIN'\)/
    )
    expect(sourceContract).toMatch(
      /attribute\.attrelid = 'arena\.sources'::pg_catalog\.regclass[\s\S]*?expanded\.privilege_type = 'REFERENCES'/
    )
  })
})
