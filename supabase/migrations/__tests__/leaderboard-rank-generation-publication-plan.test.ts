import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260729064500_leaderboard_rank_generation_publication_plan.sql'
  ),
  'utf8'
)
const packageJson = readFileSync(join(process.cwd(), 'package.json'), 'utf8')
const ci = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8')

const withoutComments = (value: string): string =>
  value.replace(/^\s*--[^\n]*(?:\n|$)/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

const sql = withoutComments(migration)

const functionDefinition = (name: string): string => {
  const escapedName = name.replace(/\./g, '\\.')
  const start = new RegExp(`CREATE(?: OR REPLACE)? FUNCTION\\s+${escapedName}\\s*\\(`, 'i').exec(
    migration
  )?.index
  if (start === undefined) return ''

  const remainder = migration.slice(start)
  const opening = /\bAS\s+\$([a-zA-Z0-9_]*)\$/i.exec(remainder)
  if (!opening) return ''

  const delimiter = `$${opening[1]}$`
  const bodyStart = (opening.index ?? 0) + opening[0].length
  const bodyEnd = remainder.indexOf(delimiter, bodyStart)
  if (bodyEnd < 0) return ''

  return remainder.slice(0, bodyEnd + delimiter.length + 1)
}

const functionBody = (name: string): string => {
  const definition = functionDefinition(name)
  const opening = /\bAS\s+\$([a-zA-Z0-9_]*)\$/i.exec(definition)
  if (!opening) return ''

  const delimiter = `$${opening[1]}$`
  const bodyStart = (opening.index ?? 0) + opening[0].length
  return definition.slice(bodyStart, definition.lastIndexOf(delimiter))
}

const tableBody = (name: string): string =>
  migration.match(
    new RegExp(`CREATE TABLE\\s+${name.replace(/\./g, '\\.')}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i')
  )?.[1] ?? ''

const binderName = 'arena.seal_leaderboard_rank_generation_publication_plan_v1'
const metricProjectionName = 'arena.build_leaderboard_metric_trust_projection_v1'
const guardName = 'arena.guard_rank_generation_publication_plan_source_insert_v1'
const validatorName = 'arena.validate_rank_generation_publication_plan_complete_v1'

const binderDefinition = functionDefinition(binderName)
const binder = functionBody(binderName)
const metricProjectionDefinition = functionDefinition(metricProjectionName)
const metricProjection = functionBody(metricProjectionName)
const guard = functionBody(guardName)
const validator = functionBody(validatorName)
const header = tableBody('arena.leaderboard_rank_generation_publication_plans')
const sources = tableBody('arena.leaderboard_rank_generation_publication_plan_sources')

describe('leaderboard rank generation publication plan', () => {
  it('installs one inert owner-only planning boundary in a PG17 transaction', () => {
    expect(sql).toMatch(/^\s*BEGIN;/)
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(sql).toContain("pg_catalog.current_setting('server_version_num')")
    expect(sql).toContain('170000')
    expect(
      sql.match(/CREATE TABLE\s+arena\.leaderboard_rank_generation_publication_plan/gi)
    ).toHaveLength(2)
    expect(functionDefinition(binderName)).not.toBe('')
    expect(metricProjectionDefinition).not.toBe('')
    expect(functionDefinition(guardName)).not.toBe('')
    expect(functionDefinition(validatorName)).not.toBe('')
    expect(sql).not.toMatch(/CREATE(?: OR REPLACE)? FUNCTION\s+public\./i)
    expect(sql).not.toMatch(/^\s*GRANT\s+/im)
  })

  it('wires the real PG17 proof into the existing required pre-check job', () => {
    expect(packageJson).toContain('"qa:rank-publication-plan-pg17"')
    expect(packageJson).toContain(
      'bash supabase/migrations/__tests__/leaderboard-rank-generation-publication-plan.pg17.sh'
    )
    expect(ci).toContain('name: Prove immutable generation publication plans')
    expect(ci).toContain('run: npm run qa:rank-publication-plan-pg17')
    expect(ci).toContain('PG17_BIN: /usr/lib/postgresql/17/bin')
  })

  it('drains writers and rejects every pre-hook private stage graph at rollout', () => {
    const headLock = sql.indexOf(
      'LOCK TABLE ONLY arena.leaderboard_rank_generation_heads IN EXCLUSIVE MODE'
    )
    const batchLock = sql.indexOf(
      'LOCK TABLE ONLY arena.leaderboard_rank_generation_stage_batches\n  IN ACCESS EXCLUSIVE MODE'
    )
    const rowLock = sql.indexOf(
      'LOCK TABLE ONLY arena.leaderboard_rank_generation_stage_rows IN SHARE MODE'
    )
    const emptyCheck = sql.indexOf('publication-plan installation requires an empty private stage')

    expect(headLock).toBeGreaterThan(-1)
    expect(batchLock).toBeGreaterThan(headLock)
    expect(rowLock).toBeGreaterThan(batchLock)
    expect(emptyCheck).toBeGreaterThan(rowLock)
    expect(sql.slice(rowLock, emptyCheck)).toContain(
      'FROM ONLY arena.leaderboard_rank_generation_stage_batches'
    )
    expect(sql.slice(rowLock, emptyCheck)).toContain(
      'FROM ONLY arena.leaderboard_rank_generation_stage_rows'
    )
  })

  it('keeps both plan relations LOGGED, owner-only, RLS protected, and immutable', () => {
    for (const relation of [
      'arena.leaderboard_rank_generation_publication_plans',
      'arena.leaderboard_rank_generation_publication_plan_sources',
    ]) {
      const escaped = relation.replace(/\./g, '\\.')
      expect(sql).toMatch(new RegExp(`ALTER TABLE ${escaped}\\s+OWNER TO postgres;`, 'i'))
      expect(sql).toMatch(new RegExp(`ALTER TABLE ${escaped}\\s+ENABLE ROW LEVEL SECURITY;`, 'i'))
      expect(sql).toMatch(new RegExp(`BEFORE UPDATE OR DELETE[\\s\\S]{0,180}ON ${escaped}`, 'i'))
      expect(sql).toMatch(new RegExp(`BEFORE TRUNCATE[\\s\\S]{0,180}ON ${escaped}`, 'i'))
      expect(sql).toMatch(
        new RegExp(
          `REVOKE ALL ON TABLE(?:(?!;)[\\s\\S])*?${escaped}(?:(?!;)[\\s\\S])*?FROM PUBLIC, anon, authenticated, service_role;`,
          'i'
        )
      )
    }

    expect(sql).not.toMatch(
      /CREATE\s+(?:UNLOGGED|TEMP(?:ORARY)?)\s+TABLE\s+arena\.leaderboard_rank_generation_publication_plan/i
    )
    expect(sql).not.toMatch(/CREATE\s+POLICY/i)
    expect(
      sql.match(/reject_leaderboard_rank_publication_mutation\(\)/g)?.length
    ).toBeGreaterThanOrEqual(4)
    expect(sql).toMatch(/relation_row\.relpersistence\s*(?:=|<>)\s*'p'/)
    expect(sql).toContain('privilege_row.grantee <> relation_row.relowner')
    expect(sql).toContain('pg_catalog.has_any_column_privilege')
  })

  it('binds one immutable header and an exact C-ordered source decision set', () => {
    expect(header).not.toBe('')
    expect(sources).not.toBe('')
    expect(header).toContain("contract = 'leaderboard-rank-generation-publication-plan@1'")
    expect(sources).toContain("contract = 'leaderboard-rank-generation-publication-plan-source@1'")
    expect(header).toContain('PRIMARY KEY (season_id, generation_seq)')
    expect(header).toContain('UNIQUE (score_cohort_id)')
    expect(header).toContain('UNIQUE (season_id, generation_seq, score_cohort_id)')
    expect(header).toMatch(
      /FOREIGN KEY \(season_id, generation_seq, score_cohort_id\)[\s\S]*?REFERENCES arena\.leaderboard_rank_generation_claims/
    )
    expect(header).toMatch(
      /FOREIGN KEY \([\s\S]*?score_input_manifest_digest[\s\S]*?\)[\s\S]*?REFERENCES arena\.leaderboard_rank_generation_manifest_bindings[\s\S]*?DEFERRABLE INITIALLY DEFERRED/
    )
    expect(sources).toContain('source text COLLATE pg_catalog."C" NOT NULL')
    expect(sources).toContain('PRIMARY KEY (season_id, generation_seq, source)')
    expect(sources).toContain('UNIQUE (score_cohort_id, source)')
    expect(sources).toMatch(
      /FOREIGN KEY \(season_id, generation_seq, score_cohort_id\)[\s\S]*?REFERENCES arena\.leaderboard_rank_generation_publication_plans[\s\S]*?DEFERRABLE INITIALLY DEFERRED/
    )
    expect(`${header}\n${sources}`).not.toMatch(/ON DELETE\s+(?:CASCADE|SET NULL|SET DEFAULT)/i)
  })

  it('makes fresh replacement, last-good retention, and unavailable explicit disjoint states', () => {
    expect(sources).toContain('disposition text NOT NULL')
    for (const disposition of ['replace', 'retain', 'unavailable']) {
      expect(sources).toContain(`disposition = '${disposition}'`)
      expect(binder).toContain(`'${disposition}'`)
    }
    expect(sources).toMatch(/disposition = 'replace'[\s\S]*?source_as_of IS NOT NULL/)
    expect(sources).toMatch(
      /disposition = 'retain'[\s\S]*?target_payload_sha256 IS NOT NULL[\s\S]*?prior_score_cohort_id IS NOT NULL[\s\S]*?prior_rank_mutation_seq IS NOT NULL/
    )
    expect(sources).toContain('metric_input_count integer NOT NULL')
    expect(sources).toContain('metric_evidence_valid_until timestamptz')
    expect(sources).toContain('metric_evidence_sha256 text')
    expect(sources).toContain('metric_input_count >= target_rank_count')
    expect(sources).toMatch(
      /metric_input_count > 0[\s\S]*?metric_evidence_valid_until IS NOT NULL[\s\S]*?metric_evidence_sha256 IS NOT NULL/
    )
    expect(sources).toMatch(
      /disposition = 'unavailable'[\s\S]*?source_as_of IS NULL[\s\S]*?target_rank_count = 0[\s\S]*?prior_score_cohort_id IS NULL/
    )
    expect(header).toContain(
      'replace_source_count + retain_source_count\n          + unavailable_source_count = source_count'
    )
    expect(header).toContain('target_rank_count = staged_rank_count + retained_rank_count')
  })

  it('keeps the five-argument binder owner-only and execution-invoker', () => {
    expect(binderDefinition).toMatch(
      /seal_leaderboard_rank_generation_publication_plan_v1\(\s*p_season_id text,\s*p_generation_seq bigint,\s*p_score_cohort_id uuid,\s*p_score_input_manifest_id uuid,\s*p_score_input_manifest_digest text\s*\)/
    )
    expect(binderDefinition).toMatch(/RETURNS jsonb[\s\S]*?LANGUAGE plpgsql/)
    expect(binderDefinition).toMatch(/VOLATILE[\s\S]*?CALLED ON NULL INPUT/)
    expect(binderDefinition).toMatch(/PARALLEL UNSAFE[\s\S]*?SECURITY INVOKER/)
    expect(binderDefinition).toContain('SET search_path = pg_catalog, pg_temp')
    expect(sql).toMatch(
      /ALTER FUNCTION\s+arena\.seal_leaderboard_rank_generation_publication_plan_v1\(\s*text, bigint, uuid, uuid, text\s*\) OWNER TO postgres;/
    )
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION\s+arena\.seal_leaderboard_rank_generation_publication_plan_v1\(\s*text, bigint, uuid, uuid, text\s*\)\s+FROM PUBLIC, anon, authenticated, service_role;/
    )
    expect(binderDefinition).not.toMatch(/SECURITY DEFINER/)
  })

  it('re-reads and validates the publish bundle inside the database boundary', () => {
    expect(binder).toContain('arena.verify_leaderboard_score_input_manifest_v1(')
    expect(binder).toContain("v_source_evidence := v_manifest.manifest->'source'->'evidence'")
    expect(binder).toContain("v_physical_boards := v_source_evidence->'physicalBoards'")
    expect(binder).toContain("'rank_limit'")
    expect(binder).toMatch(
      /public\.arena_score_inputs_publish_bundle_json\(\s*p_season_id,\s*v_[a-z0-9_]*rank_limit,\s*48\s*\)/i
    )
    expect(binder.match(/public\.arena_score_inputs_publish_bundle_json\(/g)).toHaveLength(1)
    expect(binder).toMatch(/v_[a-z0-9_]*bundle->'physicalBoards'/i)
    expect(binder).toMatch(/v_[a-z0-9_]*bundle->'scoreRows'/i)
    expect(binder).toContain("score_row.value->>'platform'")
    expect(binder).toContain("score_row.value->>'trader_key'")
    expect(binder).toContain('arena.build_leaderboard_metric_trust_projection_v1(')
    expect(metricProjection).toContain("'source_trader_id', eligible.source_trader_id")
    expect(binder).not.toMatch(/p_(?:publish_bundle|physical_boards|score_rows)\b/)

    const physicalLockStart = binder.indexOf('LOCK TABLE\n    arena.sources')
    const physicalLockEnd = binder.indexOf('IN SHARE MODE;', physicalLockStart)
    const physicalLock = binder.slice(physicalLockStart, physicalLockEnd)
    expect(physicalLockStart).toBeGreaterThan(-1)
    expect(physicalLockEnd).toBeGreaterThan(physicalLockStart)
    for (const relation of [
      'arena.sources',
      'arena.exchanges',
      'arena.traders',
      'arena.leaderboard_snapshots',
      'arena.leaderboard_entries',
    ]) {
      expect(physicalLock).toContain(relation)
    }
    expect(physicalLock).not.toContain('arena.metric_rankable_observations')
    expect(physicalLock).not.toContain('arena.metric_rankable_score_inputs_shadow')
  })

  it('rebuilds the scorer population from exact DB-owned metric trust evidence', () => {
    expect(binder).toContain('v_rank_limit IS DISTINCT FROM 1000')
    expect(binder).toContain('rank_limited_entry_count')
    expect(binder).toContain("score_row.value->'board_rank'")
    expect(binder).toContain("(score_row.value->>'board_rank')::numeric > v_rank_limit")
    expect(binder).toContain(
      'current database score rows are not one complete fresh-board population'
    )
    expect(binder).toContain("v_manifest.manifest->'inputs' IS DISTINCT FROM v_canonical_inputs")
    expect(metricProjectionDefinition).toMatch(/SECURITY INVOKER/)
    expect(metricProjection).toContain('arena.metric_rankable_score_inputs_shadow')
    expect(metricProjection).toContain('arena.metric_rankable_observations')
    expect(metricProjection).toContain("win.metric = 'win_rate'")
    expect(metricProjection).toContain("mdd.metric = 'mdd'")
    expect(metricProjection).toContain('mapped.raw_roi = trusted.roi_pct')
    expect(metricProjection).toContain('mapped.raw_pnl = trusted.pnl_usd')
    expect(metricProjection).toContain('mapped.raw_win_rate = win.value')
    expect(metricProjection).toContain('mapped.raw_max_drawdown = mdd.value')
    expect(metricProjection).toContain('fresh_decoded_rows AS MATERIALIZED')
    expect(metricProjection).toContain('expected_entries AS MATERIALIZED')
    expect(metricProjection).toContain('physical_matches AS MATERIALIZED')
    expect(metricProjection).toContain('snapshot.source_id = registry.id')
    expect(metricProjection).toContain('trader.source_id = board.physical_source_id')
    expect(metricProjection).toContain('current_count.current_row_count IS DISTINCT FROM')
    expect(metricProjection).toContain(
      'fresh score identities do not map one-to-one to physical board entries'
    )
    expect(metricProjection).toContain("'sharpe_ratio', NULL::double precision")
    expect(metricProjection).toContain("'profit_factor', NULL::double precision")
    expect(metricProjection).toContain("'trades_count', NULL::bigint")
    expect(metricProjection).toContain("'leaderboard-score-metric-trust-core-projection@1'")
    expect(metricProjection).toContain("'leaderboard-score-trusted-roi-pnl-win-mdd-usdt@1'")
    expect(metricProjection).toContain("'sourceMetricAsOf', v_source_metric_as_of")
    expect(metricProjection).toContain("'sourceTrustEvidence', v_source_trust_evidence")
    expect(metricProjection).toContain("'leaderboard-score-metric-trust-source-pairs@1'")
    expect(metricProjection).toContain("'excludedOffBoardRows'")
    expect(metricProjection).toContain("'leaderboard-score-excluded-off-board-identities@1'")
    expect(metricProjection).toMatch(
      /pg_catalog\.min\(LEAST\(\s*ordered\.roi_pnl_as_of,\s*ordered\.win_rate_as_of,\s*ordered\.mdd_as_of/
    )
    expect(metricProjection).not.toContain("'leaderboard-score-db-raw-projection@1'")
    expect(metricProjection).not.toContain("'leaderboard-score-public-full-known-history@1'")
    expect(binder).toContain("'leaderboard-score-publish-bundle@1'")
    expect(binder).toContain("v_manifest.manifest->'source'->>'scoreRowsDigest'")
    expect(binder).toContain("v_manifest.manifest->'source'->>'physicalBoardsDigest'")
    expect(binder).toContain("v_manifest.manifest->'source'->>'sourceBundleDigest'")
    expect(binder).toContain(
      'publication manifest is not the exact current canonical scorer population'
    )
    expect(binder).not.toMatch(
      /FROM pg_catalog\.jsonb_array_elements\(v_manifest\.manifest->'inputs'\)[\s\S]{0,1600}?WHERE NOT EXISTS/
    )
  })

  it('requires exact serving authority and binds every positive manifest target', () => {
    expect(binder).toContain('public.arena_freshness_expected_sources()')
    expect(binder).toMatch(/authority[^']*exact|exact[^']*authority/i)
    expect(binder).toContain('arena.leaderboard_rank_generation_stage_batches')
    expect(binder).toContain('arena.leaderboard_rank_manifest_attestations')
    expect(binder).toContain('arena.leaderboard_rank_manifest_attestation_chunks')
    expect(binder).toContain('expected_rank_count')
    expect(binder).toContain('expected_batch_count')
    expect(binder).toContain("v_manifest.manifest->'inputs'")
    expect(binder).toContain("v_manifest.manifest->'outputs'")
    expect(binder).toContain("output_row.value->>'totalScore'")
    expect(binder).toContain('v_positive_count IS DISTINCT FROM v_claim.expected_rank_count')
    expect(binder).toContain('identities')
    expect(binder).toContain('field_commitments')
    expect(binder).toContain('arena.leaderboard_rank_manifest_attestation_chunk_is_valid_v1(')
    expect(binder).toContain('arena.build_leaderboard_rank_manifest_chunks_sha256_v1(')
    expect(binder).toContain('batch_index')
    expect(binder).toContain('row_count')
    expect(binder).toContain('source_trader_id')
    expect(binder).toContain('scoreRows')
    expect(binder).toContain('rank_limited_entry_count')
  })

  it('accepts retention only from a still-current sealed public preimage', () => {
    for (const relation of [
      'arena.leaderboard_rank_publications',
      'arena.leaderboard_rank_mutation_fences',
      'public.leaderboard_source_freshness',
      'public.leaderboard_ranks',
    ]) {
      expect(binder).toContain(relation)
    }
    for (const field of [
      'rank_publication_id',
      'score_cohort_id',
      'rank_mutation_seq',
      'published_rank_count',
      'published_identity_sha256',
      'prior_score_cohort_id',
      'prior_rank_mutation_seq',
      'target_payload_sha256',
    ]) {
      expect(binder).toContain(field)
    }
    expect(binder).toContain('arena.build_leaderboard_rank_manifest_field_commitment_v1(')
    expect(binder).toContain("'leaderboard-rank-generation-source-score-payload@1'")
    expect(binder).toContain('arena.leaderboard_rank_generation_publication_plans')
    expect(binder).toContain('arena.leaderboard_score_input_manifests')
    expect(binder).toContain("'leaderboard-score-metric-trust-core-projection@1'")
    expect(binder).toContain("'leaderboard-score-trusted-roi-pnl-win-mdd-usdt@1'")
    expect(binder).toContain("'sharpe_ratio', 'profit_factor', 'trades_count'")
    expect(binder).toContain('v_prior_source_plan.metric_evidence_valid_until')
    expect(binder).toContain('v_prior_source_plan.metric_evidence_sha256')
    expect(binder).toContain(
      'v_prior_source_plan.metric_evidence_valid_until <\n                v_claim.lease_expires_at'
    )
    expect(binder).toContain('v_prior_plan.generation_seq >= p_generation_seq')
    expect(binder).toContain('/ 1000')
    expect(binder).toContain('pg_catalog.num_nonnulls(')
    expect(binder).toContain("v_freshness.source_as_of <= v_now - interval '48 hours'")
    expect(binder).toContain('retained source expired before publication plan seal')
    expect(binder).toContain('DROP TABLE IF EXISTS pg_temp.leaderboard_rank_publication_plan_work')
    expect(binder).toMatch(
      /(?:current|sealed)[^']*(?:preimage|publication)|(?:preimage|publication)[^']*(?:current|sealed)/i
    )
  })

  it('derives fresh source payloads from the complete attestation, never a batch-zero prefix', () => {
    const payloadStart = binder.indexOf('-- Bind the exact attested scoring fields per source.')
    const payloadEnd = binder.indexOf(
      'INSERT INTO pg_temp.leaderboard_rank_publication_plan_work',
      payloadStart
    )
    const payload = binder.slice(payloadStart, payloadEnd)

    expect(payloadStart).toBeGreaterThan(-1)
    expect(payloadEnd).toBeGreaterThan(payloadStart)
    expect(payload).toContain('arena.leaderboard_rank_manifest_attestation_chunks')
    expect(payload).toContain('chunk.field_commitments')
    expect(payload).toContain('WITH ORDINALITY')
    expect(payload).toContain('commitment.ordinality = identity.ordinality')
    expect(payload).not.toContain('arena.leaderboard_rank_generation_stage_rows')
    expect(binder).toContain('v_source_as_of := LEAST(v_source_as_of, v_metric_source_as_of)')
  })

  it('uses one full top-level XID for batch zero, its plan, and every source row', () => {
    expect(guard).not.toBe('')
    expect(validator).not.toBe('')
    expect(header).toMatch(
      /[a-z0-9_]*write_top_xid\s+(?:pg_catalog\.)?xid8\s+NOT NULL\s+DEFAULT pg_catalog\.pg_current_xact_id\(\)/i
    )
    expect(guard).toContain('pg_catalog.pg_current_xact_id()')
    expect(guard).toContain('pg_catalog.pg_current_xact_id()::xid')
    expect(guard).toContain('header.xmin')
    expect(guard).toMatch(/header\.[a-z0-9_]*write_top_xid/i)
    expect(guard).not.toMatch(/xmin::text::(?:pg_catalog\.)?xid8/)
    expect(binder).toContain('batch.batch_index = 0')
    expect(binder).toContain('batch.xmin')
    expect(binder).toContain('v_current_xid')
    expect(binder).toContain('v_batch_zero.stage_write_top_xid')
    expect(binder).toContain('v_current_top_xid')
    expect(binder).not.toMatch(/batch\.xmin::text::(?:pg_catalog\.)?xid8/)
    expect(sql).toMatch(
      /CREATE TRIGGER rank_generation_publication_plan_sources_insert_guard[\s\S]*?EXECUTE FUNCTION\s+arena\.guard_rank_generation_publication_plan_source_insert_v1\(\)/
    )
    expect(sql).toMatch(
      /CREATE CONSTRAINT TRIGGER\s+leaderboard_rank_generation_publication_plans_complete[\s\S]*?DEFERRABLE INITIALLY DEFERRED[\s\S]*?EXECUTE FUNCTION\s+arena\.validate_rank_generation_publication_plan_complete_v1\(\)/
    )
    expect(validator).toContain(
      'FROM ONLY arena.leaderboard_rank_generation_publication_plan_sources'
    )
    expect(validator).toContain('v_source_count IS DISTINCT FROM NEW.source_count')
    expect(validator).toContain('v_plan_sha256 IS DISTINCT FROM NEW.plan_sha256')
    expect(validator).toContain('generation publication plan is incomplete or has drifted')
  })

  it('automatically seals the plan from batch zero after deferred batch validation', () => {
    const stageHook = sql.match(
      /CREATE CONSTRAINT TRIGGER\s+(leaderboard_rank_generation_stage_batches_publication_plan)\s+AFTER INSERT\s+ON arena\.leaderboard_rank_generation_stage_batches\s+DEFERRABLE INITIALLY DEFERRED[\s\S]*?EXECUTE FUNCTION\s+(arena\.[a-z0-9_]+)\(\)/i
    )

    expect(stageHook).not.toBeNull()
    const hookBody = stageHook ? functionBody(stageHook[2]) : ''
    expect(hookBody).toMatch(/NEW\.batch_index\s*(?:=|<>|IS DISTINCT FROM)\s*0/)
    expect(hookBody).toContain('arena.seal_leaderboard_rank_generation_publication_plan_v1(')
    expect(hookBody).toContain('NEW.season_id')
    expect(hookBody).toContain('NEW.generation_seq')
    expect(hookBody).toContain('NEW.score_cohort_id')
    expect(hookBody).toContain('NEW.score_input_manifest_id')
    expect(hookBody).toContain('NEW.score_input_manifest_digest')
    expect(stageHook?.[1]).toMatch(/stage_batches_[a-z0-9_]*publication_plan/)
    expect(sql).toMatch(
      /CREATE TRIGGER rank_generation_stage_batches_defer_publication_plan[\s\S]*?BEFORE INSERT[\s\S]*?EXECUTE FUNCTION\s+arena\.defer_rank_generation_publication_plan_checks_v1\(\)/
    )
    const constraintSetter = functionBody('arena.defer_rank_generation_publication_plan_checks_v1')
    expect(constraintSetter).toContain('SET CONSTRAINTS')
    expect(constraintSetter).toContain(
      'arena.leaderboard_rank_generation_stage_batches_publication_plan'
    )
    expect(constraintSetter).toContain(
      'arena.leaderboard_rank_generation_publication_plans_complete'
    )
  })

  it('freezes exact response-loss replay before taking a new bundle snapshot', () => {
    const lookup =
      /FROM ONLY arena\.leaderboard_rank_generation_publication_plans AS [a-z0-9_]+/i.exec(binder)
        ?.index ?? -1
    const replay = binder.indexOf('IF FOUND THEN', lookup)
    const newPath = binder.indexOf('SELECT head.*', replay)
    const bundleRead = binder.indexOf('public.arena_score_inputs_publish_bundle_json(', replay)
    const insert = binder.indexOf(
      'INSERT INTO arena.leaderboard_rank_generation_publication_plans',
      bundleRead
    )

    expect(lookup).toBeGreaterThan(-1)
    expect(replay).toBeGreaterThan(lookup)
    expect(newPath).toBeGreaterThan(replay)
    expect(bundleRead).toBeGreaterThan(replay)
    expect(bundleRead).toBeGreaterThan(newPath)
    expect(insert).toBeGreaterThan(bundleRead)
    expect(binder.slice(replay, newPath)).toContain(
      "'leaderboard-rank-generation-publication-plan-seal@1'"
    )
    expect(binder.slice(replay, newPath)).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|MERGE)\b/)

    const advisory = binder.indexOf('pg_catalog.pg_advisory_xact_lock(', newPath)
    const replayLoop = binder.lastIndexOf('\n  LOOP\n', lookup)
    const loopEnd = binder.indexOf('\n  END LOOP;', advisory)
    expect(replayLoop).toBeGreaterThan(-1)
    expect(advisory).toBeGreaterThan(newPath)
    expect(loopEnd).toBeGreaterThan(advisory)
  })

  it('cannot mutate ranks, freshness, fences, receipts, publications, or the generation head', () => {
    for (const relation of [
      'public.leaderboard_ranks',
      'public.leaderboard_source_freshness',
      'arena.leaderboard_rank_mutation_fences',
      'arena.leaderboard_rank_publications',
      'arena.leaderboard_rank_generation_source_fence_receipts',
      'arena.leaderboard_rank_generation_heads',
    ]) {
      const escaped = relation.replace(/\./g, '\\.')
      expect(sql).not.toMatch(
        new RegExp(
          `(?:INSERT\\s+INTO|UPDATE(?:\\s+ONLY)?|DELETE\\s+FROM|TRUNCATE(?:\\s+TABLE)?)\\s+(?:ONLY\\s+)?${escaped}\\b`,
          'i'
        )
      )
    }
    expect(binder).not.toContain('cleanup_leaderboard_rank_publication(')
    expect(binder).not.toContain('rerank_leaderboard_publication(')
    expect(binder).not.toContain('seal_leaderboard_rank_publication(')
  })
})
