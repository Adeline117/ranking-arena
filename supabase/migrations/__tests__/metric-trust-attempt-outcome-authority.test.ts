import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260722050000_metric_trust_attempt_outcome_authority.sql'
  ),
  'utf8'
)
const shadowGateMigration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260721120000_metric_trust_shadow_gate.sql'),
  'utf8'
)
const terminalFenceMigration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260722042000_leaderboard_terminal_publication_fence.sql'
  ),
  'utf8'
)

const lockHelper = migration.slice(
  migration.indexOf('CREATE FUNCTION arena.lock_leaderboard_acquisition_source_window'),
  migration.indexOf('ALTER FUNCTION arena.lock_leaderboard_acquisition_source_window')
)
const trustTriggerFunction = migration.slice(
  migration.indexOf('CREATE FUNCTION arena.validate_metric_trust_attempt_outcome_authority'),
  migration.indexOf('ALTER FUNCTION arena.validate_metric_trust_attempt_outcome_authority')
)
const rankableView = migration.slice(
  migration.indexOf('CREATE OR REPLACE VIEW arena.metric_rankable_observations'),
  migration.indexOf('\n\nREVOKE ALL ON FUNCTION arena.lock_leaderboard_acquisition_source_window')
)
const originalRankableView = shadowGateMigration.slice(
  shadowGateMigration.indexOf('CREATE VIEW arena.metric_rankable_observations'),
  shadowGateMigration.indexOf('\n\n-- Direct provider values win over normalized')
)

describe('metric-trust attempt/outcome database authority migration', () => {
  it('is atomic, additive, and only grandfathers reviewed pre-gate v2 trust rows', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain("manifest.meta->>'data_contract'")
    expect(migration).toContain(
      "manifest.meta->>'data_contract' IS DISTINCT FROM\n           'arena.ingest.leaderboard-acquisition-manifest@2'"
    )
    expect(migration).toContain('existing non-v2 metric-trust rows require manual authority review')
    expect(migration).not.toMatch(
      /CREATE OR REPLACE FUNCTION arena\.(?:start|finish)_leaderboard_acquisition_attempt/
    )
  })

  it('locks both write targets before preflight so no insertion can cross installation', () => {
    const outcomeLock = migration.indexOf('LOCK TABLE arena.leaderboard_acquisition_outcomes,')
    const trustLock = migration.indexOf('arena.metric_trust_runs\n  IN SHARE ROW EXCLUSIVE MODE')
    const preflight = migration.indexOf('DO $preflight$')

    expect(outcomeLock).toBeGreaterThan(migration.indexOf('BEGIN;'))
    expect(trustLock).toBeGreaterThan(outcomeLock)
    expect(trustLock).toBeLessThan(preflight)
  })

  it('pins the current 040000 v2/v3 registry state without treating v3 as v2 retirement', () => {
    expect(migration).toContain('040000 is deliberately a compatibility phase')
    expect(migration).toMatch(
      /capture\.capture_contract IN \([\s\S]*leaderboard-acquisition-manifest@2[\s\S]*leaderboard-acquisition-manifest@3/
    )
    expect(migration).toContain(') <> 2')
    expect(migration).toContain('Presence of v3 is not a retirement signal')

    const v2Return = trustTriggerFunction.indexOf(
      "v_manifest_contract =\n     'arena.ingest.leaderboard-acquisition-manifest@2'"
    )
    const isolationGate = trustTriggerFunction.indexOf("current_setting('transaction_isolation')")
    const sourceWindowLock = trustTriggerFunction.indexOf(
      'PERFORM arena.lock_leaderboard_acquisition_source_window'
    )
    const terminalAuthority = trustTriggerFunction.indexOf(
      'arena.latest_terminal_leaderboard_acquisitions AS terminal'
    )
    expect(v2Return).toBeGreaterThan(-1)
    expect(v2Return).toBeLessThan(sourceWindowLock)
    expect(v2Return).toBeLessThan(isolationGate)
    expect(v2Return).toBeLessThan(terminalAuthority)
    expect(trustTriggerFunction.slice(v2Return, isolationGate)).toContain('RETURN NEW')
  })

  it('uses the exact start-RPC source/timeframe advisory namespace in one private helper', () => {
    expect(lockHelper).toMatch(
      /LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = pg_catalog, pg_temp\s+SET lock_timeout = '5s'/
    )
    expect(lockHelper).toContain('pg_catalog.pg_advisory_xact_lock')
    expect(lockHelper).toContain('pg_catalog.hashtextextended')
    expect(lockHelper).toContain("'arena.leaderboard-acquisition-source:'")
    expect(lockHelper).toContain("p_source_id::text || ':' || p_timeframe::text")
    expect(lockHelper).toContain("USING ERRCODE = '22023'")

    expect(trustTriggerFunction).toContain(
      'PERFORM arena.lock_leaderboard_acquisition_source_window'
    )
    expect(trustTriggerFunction).toContain("SET lock_timeout = '5s'")
    expect(migration).toContain(
      'CREATE TRIGGER metric_trust_runs_attempt_outcome_authority_before_insert'
    )
    expect(migration).toContain('BEFORE INSERT ON arena.metric_trust_runs')
  })

  it('requires the sole 042 outcome serializer instead of adding an unsafe duplicate', () => {
    expect(terminalFenceMigration).toMatch(
      /CREATE FUNCTION arena\.serialize_leaderboard_terminal_publication\(\)[\s\S]*SELECT attempt\.source_id, attempt\.timeframe[\s\S]*attempt\.attempt_seq = NEW\.attempt_seq[\s\S]*arena\.leaderboard-acquisition-source:/
    )
    expect(migration).toContain("'arena.serialize_leaderboard_terminal_publication()'")
    expect(migration).toContain("'leaderboard_acquisition_outcomes_serialize_terminal_publication'")
    expect(migration).toContain('reject_trigger.tgname < serialize_trigger.tgname')
    expect(migration).not.toContain(
      'CREATE FUNCTION arena.lock_leaderboard_acquisition_outcome_source_window'
    )
    expect(migration).not.toContain(
      'CREATE TRIGGER leaderboard_acquisition_outcomes_lock_source_window_before_insert'
    )
  })

  it('requires READ COMMITTED and the exact latest terminal authority for v3', () => {
    expect(trustTriggerFunction).toContain("current_setting('transaction_isolation')")
    expect(trustTriggerFunction).toContain("'read committed'")
    expect(trustTriggerFunction).toContain(
      'attempt-bound metric-trust publication requires READ COMMITTED isolation'
    )
    expect(trustTriggerFunction).toContain(
      'FROM arena.latest_terminal_leaderboard_acquisitions AS terminal'
    )

    for (const predicate of [
      'terminal.source_id = NEW.source_id',
      'terminal.timeframe = NEW.timeframe',
      'terminal.capture_contract = v_manifest_contract',
      'terminal.source_status = v_source_status',
      'terminal.source_serving_mode = v_source_serving_mode',
      'terminal.source_currency = v_source_currency',
      'terminal.source_fetch_region = v_source_fetch_region',
      'terminal.worker_region IS NOT NULL',
      'terminal.worker_region = terminal.source_fetch_region',
      'terminal.worker_region = v_source_fetch_region',
      "terminal.attempt_id::text =\n         v_manifest_meta->'acquisition_attempt'->>'attempt_id'",
      "terminal.attempt_seq::text =\n         v_manifest_meta->'acquisition_attempt'->>'attempt_seq'",
      "terminal.terminal_state = 'complete'",
      "terminal.acquisition_state = 'complete'",
      "terminal.population_state = 'verified'",
      "terminal.capture_evidence_state = 'verified'",
      'terminal.capture_started_at = NEW.started_at',
      'terminal.capture_completed_at = NEW.completed_at',
      'terminal.source_run_id = NEW.source_run_id',
      'terminal.source_payload_raw_object_id = NEW.population_raw_object_id',
      'terminal.source_payload_content_hash = v_population_content_hash',
      'terminal.source_payload_storage_path = v_population_storage_path',
      'terminal.manifest_raw_object_id = NEW.manifest_raw_object_id',
      'terminal.manifest_content_hash = v_manifest_content_hash',
      'terminal.manifest_storage_path = v_manifest_storage_path',
      'terminal.reported_population IS NOT DISTINCT FROM NEW.reported_population',
      'terminal.observed_population = NEW.fetched_population',
      'terminal.accepted_population = NEW.fetched_population',
      'terminal.rejected_row_count = 0',
      'terminal.deduplicated_row_count = 0',
      'terminal.diagnostic_raw_object_id IS NULL',
      'terminal.failure_stage IS NULL',
      'terminal.reason_code IS NULL',
    ]) {
      expect(trustTriggerFunction).toContain(predicate)
    }

    expect(trustTriggerFunction).toContain(
      'v3 metric-trust run is not authorized by the exact latest terminal outcome'
    )
    expect(trustTriggerFunction).toContain('FOR SHARE OF source')
  })

  it('keeps the entire v2 rankable view path unchanged and fences only v3', () => {
    const withoutV3Fence = rankableView
      .replace('CREATE OR REPLACE VIEW', 'CREATE VIEW')
      .replace(
        /  -- BEGIN v3 latest-terminal serving fence\.[\s\S]*?  -- END v3 latest-terminal serving fence\.\n/,
        ''
      )

    expect(withoutV3Fence).toBe(originalRankableView)
    expect(rankableView).toContain('WITH (security_invoker = true)')
    expect(rankableView).toContain('SELECT observation.*, contract.metric_set_id')
    expect(rankableView).toMatch(
      /CASE manifest_raw\.meta->>'data_contract'\s+WHEN 'arena\.ingest\.leaderboard-acquisition-manifest@2' THEN true\s+WHEN 'arena\.ingest\.leaderboard-acquisition-manifest@3' THEN EXISTS \(/
    )
    expect(rankableView).toContain('    ELSE false\n  END')
  })

  it('dynamically removes an old v3 success after any newer terminal verdict', () => {
    expect(rankableView).toContain(
      'FROM arena.latest_terminal_leaderboard_acquisitions AS terminal'
    )

    for (const predicate of [
      'terminal.source_id = acquisition.source_id',
      'terminal.timeframe = acquisition.timeframe',
      'terminal.source_status = source.status',
      'terminal.source_serving_mode = source.serving_mode',
      'terminal.source_currency = source.currency',
      'terminal.source_fetch_region = source.fetch_region',
      'terminal.worker_region IS NOT NULL',
      'terminal.worker_region = terminal.source_fetch_region',
      'terminal.worker_region = source.fetch_region',
      "terminal.attempt_id::text =\n               manifest_raw.meta->'acquisition_attempt'->>'attempt_id'",
      "terminal.attempt_seq::text =\n               manifest_raw.meta->'acquisition_attempt'->>'attempt_seq'",
      "terminal.terminal_state = 'complete'",
      "terminal.acquisition_state = 'complete'",
      "terminal.population_state = 'verified'",
      "terminal.capture_evidence_state = 'verified'",
      'terminal.capture_started_at = acquisition.started_at',
      'terminal.capture_completed_at = acquisition.completed_at',
      'terminal.source_run_id = acquisition.source_run_id',
      'terminal.source_payload_raw_object_id =\n               acquisition.population_raw_object_id',
      'terminal.source_payload_content_hash =\n               population_raw.content_hash',
      'terminal.manifest_raw_object_id =\n               acquisition.manifest_raw_object_id',
      'terminal.manifest_content_hash = manifest_raw.content_hash',
      'terminal.reported_population IS NOT DISTINCT FROM\n               acquisition.reported_population',
      'terminal.accepted_population = acquisition.fetched_population',
      'terminal.diagnostic_raw_object_id IS NULL',
      'terminal.failure_stage IS NULL',
      'terminal.reason_code IS NULL',
    ]) {
      expect(rankableView).toContain(predicate)
    }

    expect(migration).toContain('metric rankable latest-terminal fence drifted')
    expect(migration).toContain("'security_invoker=true' = ANY (relation.reloptions)")
  })

  it('keeps all helpers security-definer, postgres-owned, and non-callable by API roles', () => {
    expect(migration.match(/LANGUAGE plpgsql\s+SECURITY DEFINER/g)).toHaveLength(2)
    expect(migration.match(/OWNER TO postgres;/g)).toHaveLength(2)
    expect(migration.match(/FROM PUBLIC, anon, authenticated, service_role;/g)).toHaveLength(2)
    expect(migration).not.toMatch(/GRANT EXECUTE ON FUNCTION/)
    expect(migration).toContain('DO $owner_only_acl$')
    expect(migration).toContain('pg_catalog.aclexplode')
    expect(migration).toContain('privilege_row.grantee NOT IN (0, function_row.proowner)')
    expect(migration).toContain('privilege_row.grantee <> function_row.proowner')
    expect(migration).toContain('private publication-fence functions leaked EXECUTE')
  })

  it('postflights shared namespace, owner-only functions, and exact enabled triggers', () => {
    expect(migration).toContain('pg_catalog.pg_get_functiondef')
    expect(migration).toContain(
      '%arena.leaderboard-acquisition-source:%p_source_id::text%p_timeframe::text%'
    )
    expect(migration).toContain('procedure_row.prosecdef')
    expect(migration).toContain('procedure_row.proowner')
    expect(migration).toContain("'lock_timeout=5s'")
    expect(migration).toContain("trigger_row.tgenabled = 'O'")
    expect(migration).toContain('metric-trust acquisition authority trigger is missing')
    expect(migration).toContain('leaderboard outcome triggers are not ordered fail-closed')
  })
})
