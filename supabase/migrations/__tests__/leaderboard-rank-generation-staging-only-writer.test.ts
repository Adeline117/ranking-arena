import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260729061533_leaderboard_rank_generation_staging_only_writer.sql'
  ),
  'utf8'
)

const sql = migration.replace(/^\s*--[^\n]*(?:\n|$)/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

const writerMatch = migration.match(
  /CREATE OR REPLACE FUNCTION arena\.write_leaderboard_rank_generation_batch_v1\([\s\S]*?AS \$writer_body\$([\s\S]*?)\$writer_body\$;/
)
const writer = writerMatch?.[1] ?? ''
const writerSha256 = createHash('sha256').update(writer, 'utf8').digest('hex')

describe('leaderboard rank generation staging-only writer', () => {
  it('is one PG17 fail-closed transaction that replaces exactly one signature', () => {
    expect(sql).toMatch(/^\s*BEGIN;/)
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(sql).toContain("pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17")
    expect(
      sql.match(/CREATE OR REPLACE FUNCTION arena\.write_leaderboard_rank_generation_batch_v1\(/g)
    ).toHaveLength(1)
    expect(sql).toContain(
      'arena.write_leaderboard_rank_generation_batch_v1(text,bigint,uuid,integer,uuid,text,text[],arena.leaderboard_rank_batch_row_v1[])'
    )
    expect(sql).not.toMatch(/CREATE(?: OR REPLACE)? FUNCTION public\./i)
    expect(sql).not.toMatch(/^\s*GRANT\s+/im)
  })

  it('drains old calls at the head before freezing every relation it uses', () => {
    const head = sql.indexOf(
      'LOCK TABLE ONLY arena.leaderboard_rank_generation_heads IN EXCLUSIVE MODE'
    )
    const dependencies = [
      'arena.leaderboard_rank_generation_claims',
      'arena.leaderboard_score_input_manifests',
      'arena.leaderboard_rank_generation_manifest_bindings',
      'arena.leaderboard_rank_generation_batch_receipts',
      'arena.leaderboard_rank_generation_source_fence_receipts',
      'arena.leaderboard_rank_manifest_attestations',
      'arena.leaderboard_rank_manifest_attestation_chunks',
      'arena.leaderboard_rank_generation_stage_batches',
      'arena.leaderboard_rank_generation_stage_rows',
    ]

    expect(head).toBeGreaterThan(-1)
    for (const dependency of dependencies) {
      expect(sql.indexOf(`LOCK TABLE ONLY ${dependency}`)).toBeGreaterThan(head)
    }
    expect(sql.slice(0, head)).not.toMatch(/LOCK TABLE/i)
    expect(sql).not.toMatch(/LOCK TABLE (?:ONLY )?public\./i)
  })

  it('pins helper catalogs, authority indexes, private ACLs, and side-effect topology', () => {
    expect(sql).toContain('ddb7c25c0c61c1ea70377bc6879e913a07e4529b1e4c8fa35a4b5d9f2c50f548')
    for (const digest of [
      '7fa1e9f60a7b6cb4072dce842ddd10c367046fcb431a2ae655a9a806172df67e',
      'f82b8b26dee4b1b5a92d4750ad42ed65d91bd7972bac0ef0f14f0b94e24f197d',
      'aafce6e95ed4662239a1f84295cc3158dc0011f8bc8948d0161f73767e73dd9a',
      '0dddcffebb56d9a51e0869e29cc16ac18f78251d58907764fb02101fa8dad322',
      'a663274e1a45e06c90f17fecdb646854be6112cb6e22d2af343afd9737d365dd',
      'ba9030dfdd0431721903561fdfa02c106fcedc66cbb32ab20acf5ebd33958dc9',
      '14063ba832d2bd0a5de0d5975eaf4ea8a68093e63b27f78107770cd8766184b0',
    ]) {
      expect(sql).toContain(digest)
    }

    expect(sql).toContain('expanded.grantee <> function_row.proowner')
    expect(sql).toContain('expanded.grantee <> table_row.relowner')
    expect(sql).toContain("expanded.grantee <> 'postgres'::regrole")
    expect(sql).toContain("table_row.relpersistence <> 'p'")
    expect(sql.match(/pg_catalog\.oidvectortypes\(function_row\.proargtypes\)/g)).toHaveLength(2)
    expect(
      sql.match(/function_row\.provolatile IS DISTINCT FROM expected\.volatility/g)
    ).toHaveLength(2)
    expect(
      sql.match(/function_row\.proparallel IS DISTINCT FROM expected\.parallel_safety/g)
    ).toHaveLength(2)
    expect(
      sql.match(/function_row\.prosecdef IS DISTINCT FROM expected\.security_definer/g)
    ).toHaveLength(2)
    expect(sql.match(/function_row\.proleakproof/g)).toHaveLength(4)
    expect(sql.match(/function_row\.provariadic <> 0/g)).toHaveLength(2)
    expect(
      sql.match(/function_row\.proargnames IS DISTINCT FROM expected\.arg_names/g)
    ).toHaveLength(2)
    expect(sql.match(/function_row\.proargmodes IS NOT NULL/g)).toHaveLength(2)
    expect(sql.match(/function_row\.proallargtypes IS NOT NULL/g)).toHaveLength(2)
    expect(sql.match(/function_row\.proargdefaults IS NOT NULL/g)).toHaveLength(2)
    expect(sql.match(/function_row\.protrftypes IS NOT NULL/g)).toHaveLength(2)
    expect(sql.match(/function_row\.prosupport <> 0/g)).toHaveLength(2)
    expect(sql.match(/function_row\.procost <> 100/g)).toHaveLength(2)
    expect(sql.match(/function_row\.prorows <> 0/g)).toHaveLength(2)
    expect(
      sql.match(/function_row\.proconfig IS DISTINCT FROM expected\.configuration/g)
    ).toHaveLength(2)
    expect(sql).toContain('staging-only rank writer helper catalog changed during install')
    expect(sql).toContain('staging-only rank writer helper overload changed during install')
    expect(sql).toContain('staging-only rank writer helper ACL changed during install')

    expect(sql.match(/leaderboard-rank-staging-writer-authority-constraints@1/g)).toHaveLength(2)
    expect(sql.match(/leaderboard-rank-staging-writer-authority-indexes@1/g)).toHaveLength(2)
    expect(sql.match(/v_constraint_count IS DISTINCT FROM 120/g)).toHaveLength(2)
    expect(sql.match(/v_index_count IS DISTINCT FROM 23/g)).toHaveLength(2)
    expect(
      sql.match(/7e07fd96291161b2eca8541b128112dbde33db78fae03e45ee0995908e0f45de/g)
    ).toHaveLength(2)
    expect(
      sql.match(/0d4aef092635571aa1f4004b9e5dc64536b510628d710bb0e3c27af64769fb83/g)
    ).toHaveLength(2)
    expect(sql.match(/pg_catalog\.pg_get_constraintdef\(/g)).toHaveLength(2)
    expect(sql.match(/pg_catalog\.pg_get_indexdef\(/g)).toHaveLength(2)
    for (const catalogField of [
      "'validated', constraint_row.convalidated",
      "'deferrable', constraint_row.condeferrable",
      "'deferred', constraint_row.condeferred",
      "'key', pg_catalog.to_jsonb(constraint_row.conkey)",
      "'foreignRelation', CASE constraint_row.confrelid",
      "'foreignKey', pg_catalog.to_jsonb(constraint_row.confkey)",
      "'foreignUpdate', constraint_row.confupdtype",
      "'foreignDelete', constraint_row.confdeltype",
      "'valid', index_row.indisvalid",
      "'ready', index_row.indisready",
      "'unique', index_row.indisunique",
      "'primary', index_row.indisprimary",
      "'immediate', index_row.indimmediate",
    ]) {
      expect(
        sql.match(new RegExp(catalogField.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))
      ).toHaveLength(2)
    }

    expect(sql).toMatch(/\) <> 33 OR/)
    expect(sql.match(/\) <> 5 THEN/g)).toHaveLength(2)
    expect(sql.match(/\) <> 20 OR EXISTS \(/g)).toHaveLength(2)
    for (const triggerName of [
      'leaderboard_rank_generation_claim_immutable',
      'leaderboard_rank_generation_manifest_bindings_validate',
      'leaderboard_rank_generation_manifest_bindings_immutable',
      'leaderboard_rank_generation_manifest_bindings_no_truncate',
      'leaderboard_rank_generation_batch_receipts_immutable',
      'leaderboard_rank_generation_batch_receipts_no_truncate',
      'leaderboard_rank_generation_source_fence_receipts_immutable',
      'leaderboard_rank_generation_source_fence_receipts_no_truncate',
      'leaderboard_rank_manifest_attestations_immutable',
      'leaderboard_rank_manifest_attestations_no_truncate',
      'leaderboard_rank_manifest_attestations_complete',
      'leaderboard_rank_manifest_attestation_chunks_insert_guard',
      'leaderboard_rank_manifest_attestation_chunks_immutable',
      'leaderboard_rank_manifest_attestation_chunks_no_truncate',
      'leaderboard_rank_generation_stage_batches_complete',
      'leaderboard_rank_generation_stage_batches_immutable',
      'leaderboard_rank_generation_stage_batches_no_truncate',
      'leaderboard_rank_generation_stage_rows_insert_guard',
      'leaderboard_rank_generation_stage_rows_immutable',
      'leaderboard_rank_generation_stage_rows_no_truncate',
    ]) {
      expect(sql).toContain(`'${triggerName}'::name`)
    }
    expect(sql).toContain('trigger_row.tgfoid <> expected.function_oid')
    expect(sql).toContain('trigger_row.tgtype <> expected.trigger_type')
    expect(sql).toContain('(trigger_row.tgconstraint <> 0) IS DISTINCT FROM')
    expect(sql).toContain('trigger_row.tgdeferrable IS DISTINCT FROM expected.is_deferrable')
    expect(sql).toContain('trigger_row.tginitdeferred IS DISTINCT FROM')
    expect(sql).toContain('trigger_row.tgoldtable::text IS DISTINCT FROM')
    expect(sql).toContain('trigger_row.tgnewtable::text IS DISTINCT FROM')
    expect(sql).toContain("NULL::text, 'new_stage_rows'::text")
    expect(sql).toContain("trigger_row.tgenabled <> 'O'")
    expect(sql).toContain('OR trigger_row.tgisinternal')
    expect(sql).toContain('OR trigger_row.tgparentid <> 0')
    expect(sql).toContain('OR trigger_row.tgnargs <> 0')
    expect(sql).toContain("OR trigger_row.tgargs <> '\\x'::bytea")
    expect(sql).toContain("OR trigger_row.tgattr <> ''::pg_catalog.int2vector")
    expect(sql).toContain('OR trigger_row.tgqual IS NOT NULL')
    expect(sql).toContain('trigger topology changed during install')
    expect(
      sql.match(
        /FROM pg_catalog\.pg_trigger AS trigger_row[\s\S]*?WHERE trigger_row\.tgrelid IN \(\s*'arena\.leaderboard_rank_generation_heads'::regclass/g
      )
    ).toHaveLength(2)
    expect(sql.match(/FROM pg_catalog\.pg_inherits AS inheritance/g)).toHaveLength(2)
    expect(sql.match(/FROM pg_catalog\.pg_rewrite AS rule_row/g)).toHaveLength(2)
    expect(sql).toContain(
      'staging-only rank writer inheritance or rewrite topology changed during install'
    )
  })

  it('pins the exact ordered 33-field typed row composite and its private ACL', () => {
    expect(sql.match(/v_type_column_count IS DISTINCT FROM 33/g)).toHaveLength(2)
    expect(
      sql.match(/83ce5a148aedce9eb29690cbc7181f46c28bbe8ee08e8f64c4caadaad5f23d82/g)
    ).toHaveLength(2)
    expect(
      sql.match(
        /WHERE type_row\.oid = v_type_oid[\s\S]*?type_row\.typtype = 'c'[\s\S]*?type_row\.typowner = 'postgres'::pg_catalog\.regrole[\s\S]*?namespace_row\.nspname = 'arena'[\s\S]*?relation_row\.relkind = 'c'[\s\S]*?relation_row\.relpersistence = 'p'[\s\S]*?relation_row\.relowner = 'postgres'::pg_catalog\.regrole[\s\S]*?NOT relation_row\.relispartition[\s\S]*?relation_row\.reloptions IS NULL;/g
      )
    ).toHaveLength(2)
    expect(
      sql.match(
        /pg_catalog\.string_agg\([\s\S]*?attribute\.attnum,[\s\S]*?attribute\.attname,[\s\S]*?pg_catalog\.format_type\([\s\S]*?attribute\.attnotnull,[\s\S]*?attribute\.attidentity,[\s\S]*?attribute\.attgenerated,[\s\S]*?attribute\.attcollation::pg_catalog\.regcollation::text,[\s\S]*?attribute\.atttypmod,[\s\S]*?attribute\.attndims[\s\S]*?ORDER BY attribute\.attnum/g
      )
    ).toHaveLength(2)
    expect(sql.match(/expanded\.grantee <> type_row\.typowner/g)).toHaveLength(2)
    expect(sql.match(/pg_catalog\.has_type_privilege\(/g)).toHaveLength(2)
    expect(sql).toContain('staging-only rank writer typed batch catalog changed during install')
  })

  it('refuses every old nonterminal head and any pre-activation stage evidence', () => {
    expect(sql).toContain("head.phase IN ('claimed', 'writing', 'cleaned', 'reranked')")
    expect(sql).toContain('staging-only rank writer requires no active claimed generation')
    expect(sql).toMatch(
      /IF EXISTS \([\s\S]*?FROM ONLY arena\.leaderboard_rank_generation_stage_batches[\s\S]*?\) OR EXISTS \([\s\S]*?FROM ONLY arena\.leaderboard_rank_generation_stage_rows[\s\S]*?pre-activation staged evidence/
    )
  })

  it('keeps the eight-argument writer owner-only and execution-invoker', () => {
    expect(writer).not.toBe('')
    expect(sql).toMatch(
      /RETURNS jsonb[\s\S]*?LANGUAGE plpgsql[\s\S]*?VOLATILE[\s\S]*?CALLED ON NULL INPUT[\s\S]*?PARALLEL UNSAFE[\s\S]*?SECURITY INVOKER[\s\S]*?SET search_path = pg_catalog, pg_temp[\s\S]*?SET "TimeZone" = 'UTC'[\s\S]*?SET lock_timeout = '10s'[\s\S]*?AS \$writer_body\$/
    )
    expect(sql).toMatch(
      /ALTER FUNCTION arena\.write_leaderboard_rank_generation_batch_v1\([\s\S]*?\) OWNER TO postgres;/
    )
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION arena\.write_leaderboard_rank_generation_batch_v1\([\s\S]*?\) FROM PUBLIC, anon, authenticated, service_role;/
    )
    expect(sql).toContain('staging-only rank writer postflight ACL drifted')
    expect(sql).not.toMatch(/SECURITY DEFINER[\s\S]*?AS \$writer_body\$/)
  })

  it('validates the bounded complete digest plan before taking the head row', () => {
    const headLock = writer.indexOf('FOR UPDATE;')

    expect(writer).toContain('pg_catalog.array_ndims(p_batch_sha256_plan) IS DISTINCT FROM 1')
    expect(writer).toContain('pg_catalog.array_lower(p_batch_sha256_plan, 1) IS DISTINCT FROM 1')
    expect(writer).toContain('pg_catalog.cardinality(p_batch_sha256_plan) > 64')
    expect(writer).toContain("digest.value !~ '^[0-9a-f]{64}$'")
    expect(writer).toContain('v_claim.expected_rank_count > 64000')
    expect(writer).toContain('(v_claim.expected_rank_count + 999) / 1000')
    expect(writer).toContain('arena.build_leaderboard_rank_generation_write_set_sha256_v1')
    expect(writer).toContain(
      "p_batch_sha256_plan[p_batch_index + 1] IS DISTINCT FROM\n          v_typed_evidence->>'batch_sha256'"
    )
    expect(writer.indexOf('staged rank batch digest plan is invalid')).toBeLessThan(headLock)
  })

  it('uses stage-first replay and preserves exact legacy frozen replay only', () => {
    const receipt = writer.indexOf(
      'FROM ONLY arena.leaderboard_rank_generation_batch_receipts AS receipt'
    )
    const stage = writer.indexOf(
      'FROM ONLY arena.leaderboard_rank_generation_stage_batches AS batch'
    )
    const head = writer.indexOf('FOR UPDATE;')
    const legacyRead = writer.indexOf('arena.leaderboard_rank_generation_source_fence_receipts')

    expect(receipt).toBeGreaterThan(-1)
    expect(stage).toBeGreaterThan(receipt)
    expect(head).toBeGreaterThan(stage)
    expect(writer).toContain('v_has_stage := FOUND')
    expect(writer).toContain('IF v_has_stage THEN')
    expect(writer).toContain('v_staged_rows IS DISTINCT FROM p_rows')
    expect(writer).toContain('v_staged_evidence IS DISTINCT FROM v_typed_evidence')
    expect(writer).toContain('v_stage_batch.batch_sha256_plan IS DISTINCT FROM')
    expect(writer).toContain('NOT v_has_stage AND (')
    expect(legacyRead).toBeGreaterThan(writer.indexOf('ELSE'))
    expect(writer).toMatch(
      /v_actual_source_proofs IS DISTINCT FROM\s+v_typed_evidence->'source_proofs'/
    )
    expect(writer).toContain('v_actual_source_row_count IS DISTINCT FROM')
    expect(writer).toContain('OR NOT v_source_windows_valid')
    expect(writer).toContain('generation batch receipt conflicts with immutable replay')
    expect(writer.indexOf("'completed_at', pg_catalog.to_char(")).toBeLessThan(head)
  })

  it('confines the legacy relation to one read and never mutates it', () => {
    expect(writer.match(/leaderboard_rank_generation_source_fence_receipts/g)).toHaveLength(1)
    expect(writer).not.toMatch(
      /(?:INSERT INTO|UPDATE|DELETE FROM|TRUNCATE)\s+(?:ONLY\s+)?arena\.leaderboard_rank_generation_source_fence_receipts/i
    )
    expect(writer).toContain(
      'source_receipt.mutation_seq_after -\n                source_receipt.mutation_seq_before IN (1, 2)'
    )
  })

  it('allows legacy replay before enforcing null terminal fields on new appends', () => {
    const frozenReturn = writer.indexOf("'contract', 'leaderboard-rank-generation-batch-write@1'")
    const terminalGate = writer.indexOf('staged rank rows cannot carry terminal rank authority')

    expect(frozenReturn).toBeGreaterThan(-1)
    expect(terminalGate).toBeGreaterThan(frozenReturn)
    expect(writer).toContain('(p_rows[position.i]).rank IS NOT NULL')
    expect(writer).toContain('(p_rows[position.i]).rank_change IS NOT NULL')
    expect(writer).toContain('(p_rows[position.i]).is_new IS NOT NULL')
    expect(writer.indexOf('FOR UPDATE;')).toBeLessThan(terminalGate)
  })

  it('retains exact claim, lease, canonical prefix, and head CAS authority', () => {
    expect(writer).toContain('staged rank batch has no exact generation claim')
    expect(writer).toContain('pg_catalog.to_jsonb(v_locked_claim) IS DISTINCT FROM')
    expect(writer).toContain("WHEN p_batch_index = 0 THEN 'claimed'\n    ELSE 'writing'")
    expect(writer).toContain('v_head.lease_expires_at IS DISTINCT FROM')
    expect(writer).toContain('v_head.lease_expires_at <= v_now')
    expect(writer).toContain('v_prior_batch_count IS DISTINCT FROM p_batch_index')
    expect(writer).toContain('v_prior_stage_batch_count IS DISTINCT FROM p_batch_index')
    expect(writer).toContain('staged.batch_sha256_plan IS DISTINCT FROM p_batch_sha256_plan')
    expect(writer).toContain('previous staged identity range overlaps this batch')
    expect(writer).toMatch(
      /UPDATE ONLY arena\.leaderboard_rank_generation_heads AS head[\s\S]*?SET phase = 'writing'[\s\S]*?AND head\.phase = v_expected_phase[\s\S]*?AND head\.lease_expires_at = v_claim\.lease_expires_at/
    )
    expect(writer).toContain('staged batch head compare-and-set failed')
    expect(writer).toContain('generation lease expired before staged batch commit')
  })

  it('derives batch-zero chunks and verifies later batches without raw-manifest reuse', () => {
    expect(writer).toContain('IF p_batch_index = 0 THEN')
    expect(writer).toContain('arena.verify_leaderboard_score_input_manifest_v1')
    expect(writer).toContain('WITH manifest_pairs AS MATERIALIZED')
    expect(writer).toContain("WHERE (pair.output_value->>'totalScore')::numeric > 0")
    expect(writer).toContain('arena.build_leaderboard_rank_manifest_field_commitment_v1')
    expect(writer).toContain('arena.build_leaderboard_rank_manifest_chunk_sha256_v1')
    expect(writer).toContain('arena.build_leaderboard_rank_manifest_chunks_sha256_v1')
    expect(writer).toContain('later staged batch has no exact manifest attestation')
    expect(writer).toContain('arena.leaderboard_rank_manifest_attestation_chunk_is_valid_v1')
    expect(writer).toContain('v_supplied_identities IS DISTINCT FROM v_expected_identities')
    expect(writer).toContain('v_supplied_commitments IS DISTINCT FROM v_expected_commitments')
  })

  it('writes only immutable evidence and private stage before the head CAS', () => {
    const receipt = writer.indexOf('INSERT INTO arena.leaderboard_rank_generation_batch_receipts')
    const header = writer.indexOf('INSERT INTO arena.leaderboard_rank_manifest_attestations')
    const chunks = writer.indexOf('INSERT INTO arena.leaderboard_rank_manifest_attestation_chunks')
    const stageBatch = writer.indexOf('INSERT INTO arena.leaderboard_rank_generation_stage_batches')
    const stageRows = writer.indexOf('INSERT INTO arena.leaderboard_rank_generation_stage_rows')
    const head = writer.indexOf('UPDATE ONLY arena.leaderboard_rank_generation_heads AS head')

    expect(receipt).toBeGreaterThan(-1)
    expect(header).toBeGreaterThan(receipt)
    expect(chunks).toBeGreaterThan(header)
    expect(stageBatch).toBeGreaterThan(chunks)
    expect(stageRows).toBeGreaterThan(stageBatch)
    expect(head).toBeGreaterThan(stageRows)
    expect(writer).toContain('arena.leaderboard_rank_generation_stage_batches_complete DEFERRED')
    expect(writer).toContain("'leaderboard-rank-generation-stage-batch@1'")
    expect(writer).toContain("'leaderboard-rank-generation-stage-row@1'")
    expect(writer).toContain('p_rows[position.ordinality]')
    expect(writer).toContain('GET DIAGNOSTICS v_staged_row_count = ROW_COUNT')
  })

  it('contains no serving-table, mutation-fence, freshness, or sequence side effect', () => {
    expect(writer).not.toContain('public.leaderboard_ranks')
    expect(writer).not.toContain('leaderboard_rank_mutation_fences')
    expect(writer).not.toMatch(/\bnextval\s*\(/i)
    expect(writer).not.toMatch(/\bsetval\s*\(/i)
    expect(writer).not.toMatch(/\bTRUNCATE\b/i)
    expect(writer).not.toMatch(/\bDELETE\s+FROM\b/i)
    expect(writer).not.toMatch(/(?:freshness|watermark)/i)

    const inserts = [...writer.matchAll(/INSERT INTO\s+([a-z0-9_.]+)/gi)].map((match) => match[1])
    expect(new Set(inserts)).toEqual(
      new Set([
        'arena.leaderboard_rank_generation_manifest_bindings',
        'arena.leaderboard_rank_generation_batch_receipts',
        'arena.leaderboard_rank_manifest_attestations',
        'arena.leaderboard_rank_manifest_attestation_chunks',
        'arena.leaderboard_rank_generation_stage_batches',
        'arena.leaderboard_rank_generation_stage_rows',
      ])
    )
  })

  it('pins the independently extracted final body hash in postflight', () => {
    expect(writerSha256).toBe('7247740feba0f910aa010f7d9d0f79230a8438944742027a7e699240cfe7a89f')
    expect(sql).toMatch(new RegExp(`v_writer_body_digest =\\s+'${writerSha256}'`))
    expect(sql).toContain("'search_path=pg_catalog, pg_temp'")
    expect(sql).toContain("'TimeZone=UTC'")
    expect(sql).toContain("'lock_timeout=10s'")
    expect(sql).toContain('staging-only rank writer helper catalog changed during install')
  })
})
