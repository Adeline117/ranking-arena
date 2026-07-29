import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260729011000_leaderboard_rank_manifest_attestation_substrate.sql'
  ),
  'utf8'
)
const writerMigration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260725017500_leaderboard_rank_generation_atomic_batch_writer.sql'
  ),
  'utf8'
)

// Contract markers must occur in executable SQL, not merely in commentary.
const withoutComments = (value: string): string =>
  value.replace(/^\s*--[^\n]*(?:\n|$)/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

const sql = withoutComments(migration)
const writerSql = withoutComments(writerMigration)
const postflight = sql.match(/DO \$postflight\$([\s\S]*?)\$postflight\$;/)?.[1] ?? ''

const occurrenceCount = (value: string, pattern: RegExp): number =>
  value.match(new RegExp(pattern.source, pattern.flags.replace('g', '') + 'g'))?.length ?? 0

const functionDefinition = (name: string): string =>
  migration.match(
    new RegExp(`CREATE FUNCTION ${name.replace(/\./g, '\\.')}\\([\\s\\S]*?\\n\\$body\\$;`)
  )?.[0] ?? ''

const functionSource = (name: string): string =>
  functionDefinition(name).match(/AS \$body\$([\s\S]*?)\$body\$;/)?.[1] ?? ''

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

describe('leaderboard rank manifest attestation substrate', () => {
  it('keeps both attestation relations owner-only, RLS protected, and policy-free', () => {
    for (const relation of [
      'arena.leaderboard_rank_manifest_attestations',
      'arena.leaderboard_rank_manifest_attestation_chunks',
    ]) {
      expect(sql).toContain(`CREATE TABLE ${relation}`)
      expect(sql).toContain(`ALTER TABLE ${relation}`)
      expect(sql).toMatch(
        new RegExp(`ALTER TABLE ${relation.replace(/\./g, '\\.')}[\\s\\S]{0,180}OWNER TO postgres;`)
      )
      expect(sql).toMatch(
        new RegExp(
          `ALTER TABLE ${relation.replace(/\./g, '\\.')}[\\s\\S]{0,180}ENABLE ROW LEVEL SECURITY;`
        )
      )
      expect(sql).toMatch(
        new RegExp(
          `REVOKE ALL ON (?:TABLE )?${relation.replace(
            /\./g,
            '\\.'
          )}[\\s\\S]{0,220}FROM PUBLIC, anon, authenticated, service_role;`
        )
      )
    }

    expect(occurrenceCount(sql, /ENABLE ROW LEVEL SECURITY/i)).toBe(2)
    expect(sql).not.toMatch(/CREATE\s+POLICY/i)
    expect(sql).not.toMatch(/GRANT\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE|EXECUTE)/i)
    expect(sql).not.toMatch(/CREATE(?: OR REPLACE)? FUNCTION public\./i)
    expect(sql).toContain('expanded.grantee <> table_row.relowner')
    expect(sql).toContain('expanded.grantee <> function_row.proowner')
    expect(occurrenceCount(sql, /REVOKE ALL ON FUNCTION/i)).toBe(7)
  })

  it('binds the header and every chunk to the complete immutable generation identity', () => {
    const header = sql.match(
      /CREATE TABLE arena\.leaderboard_rank_manifest_attestations\s*\(([\s\S]*?)\n\);/
    )?.[1]
    const chunks = sql.match(
      /CREATE TABLE arena\.leaderboard_rank_manifest_attestation_chunks\s*\(([\s\S]*?)\n\);/
    )?.[1]

    expect(header).toBeDefined()
    expect(chunks).toBeDefined()
    for (const field of [
      'season_id',
      'generation_seq',
      'score_cohort_id',
      'score_input_manifest_id',
      'score_input_manifest_digest',
    ]) {
      expect(header).toContain(field)
      expect(chunks).toContain(field)
    }
    expect(header).toMatch(
      /FOREIGN KEY\s*\(\s*season_id\s*,\s*generation_seq\s*,\s*score_cohort_id\s*,\s*score_input_manifest_id\s*,\s*score_input_manifest_digest\s*\)[\s\S]*?REFERENCES arena\.leaderboard_rank_generation_manifest_bindings/i
    )
    expect(chunks).toMatch(
      /FOREIGN KEY\s*\(\s*season_id\s*,\s*generation_seq\s*,\s*score_cohort_id\s*,\s*score_input_manifest_id\s*,\s*score_input_manifest_digest\s*\)[\s\S]*?REFERENCES arena\.leaderboard_rank_manifest_attestations/i
    )
    const chunkHeaderForeignKey = chunks?.match(
      /CONSTRAINT rank_manifest_attestation_chunk_header_fkey([\s\S]*?)\n\s*\)/
    )?.[1]
    expect(chunkHeaderForeignKey).toBeDefined()
    expect(chunkHeaderForeignKey).not.toContain('chunk_index')
    expect(header).not.toContain('REFERENCES arena.leaderboard_score_input_manifests')
    expect(chunks).not.toContain('REFERENCES arena.leaderboard_score_input_manifests')
    expect(`${header}\n${chunks}`).not.toMatch(/ON DELETE\s+(?:CASCADE|SET NULL|SET DEFAULT)/i)
    expect(header).toMatch(
      /CONSTRAINT rank_manifest_attestation_batch_zero_fkey[\s\S]*?FOREIGN KEY \(season_id, generation_seq, batch_index\)[\s\S]*?DEFERRABLE INITIALLY DEFERRED/i
    )
    expect(sql).toContain('AND constraint_row.condeferrable')
    expect(sql).toContain('AND constraint_row.condeferred')
    expect(sql).toContain('AND NOT constraint_row.condeferrable')
  })

  it('makes attestation roots and chunks update, delete, and truncate immutable', () => {
    for (const relation of [
      'arena.leaderboard_rank_manifest_attestations',
      'arena.leaderboard_rank_manifest_attestation_chunks',
    ]) {
      const escaped = relation.replace(/\./g, '\\.')
      expect(sql).toMatch(new RegExp(`BEFORE UPDATE OR DELETE[\\s\\S]{0,180}ON ${escaped}`, 'i'))
      expect(sql).toMatch(new RegExp(`BEFORE TRUNCATE[\\s\\S]{0,180}ON ${escaped}`, 'i'))
    }

    expect(occurrenceCount(sql, /BEFORE UPDATE OR DELETE/i)).toBe(2)
    expect(occurrenceCount(sql, /BEFORE TRUNCATE/i)).toBe(2)
    expect(
      occurrenceCount(sql, /arena\.reject_leaderboard_rank_publication_mutation\(\)/)
    ).toBeGreaterThanOrEqual(4)
    expect(sql).not.toMatch(/ON\s+DELETE\s+CASCADE/i)
    expect(sql).not.toMatch(/\bTRUNCATE\s+(?:TABLE\s+)?arena\.leaderboard_rank_manifest_/i)
  })

  it('pins bounded C-ordered chunks and makes completeness a same-transaction fact', () => {
    expect(sql).toContain('leaderboard-rank-manifest-attestation@1')
    expect(sql).toContain('leaderboard-rank-manifest-attestation-chunk@1')
    expect(sql).toContain('COLLATE pg_catalog."C"')
    expect(sql).toContain('source_trader_id')
    expect(sql).toMatch(/chunk_(?:index|count)/i)
    expect(sql).toMatch(/chunk_index\s*>=\s*0/i)
    expect(sql).toMatch(/chunk_index\s*<\s*64/i)
    expect(sql).toContain('CHECK (row_count >= 1 AND row_count <= 1000)')
    expect(sql).toContain('pg_catalog.jsonb_array_length(p_identities) <> p_row_count')
    expect(sql).toContain('pg_catalog.jsonb_array_length(p_field_commitments) <> p_row_count')
    expect(sql).toContain('positive_count >= 1 AND positive_count <= 64000')
    expect(sql).toContain('chunk_count = (positive_count + 999) / 1000')
    expect(sql).toContain('p_chunk_count <> (p_positive_count + 999) / 1000')
    expect(sql).toMatch(/ROW\([\s\S]{0,200}COLLATE pg_catalog\."C"[\s\S]{0,200}\)\s*>=\s*ROW\(/)
    expect(sql).toMatch(/UNIQUE[\s\S]{0,180}chunk_index/i)
    expect(sql).toMatch(/\^\[0-9a-f\]\{64\}\$/)
    expect(sql).toContain(
      'CREATE CONSTRAINT TRIGGER leaderboard_rank_manifest_attestations_complete'
    )
    expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED')
    expect(sql).toContain('COALESCE(pg_catalog.sum(chunk.row_count), 0)')
    expect(sql).toMatch(
      /pg_catalog\.jsonb_agg\([\s\S]{0,260}chunk\.chunk_sha256[\s\S]{0,100}ORDER BY chunk\.chunk_index/
    )
    expect(sql).toContain('manifest attestation chunk population is incomplete')
    expect(sql).toContain('manifest attestation chunk plan digest is invalid')
    expect(sql).toContain('manifest attestation identity order is not globally strict')

    const insertGuard = functionDefinition(
      'arena.guard_leaderboard_rank_manifest_attestation_chunk_insert_v1'
    )
    expect(insertGuard).toContain('SELECT header.xmin')
    expect(insertGuard).toContain('FOR KEY SHARE')
    expect(insertGuard).toContain('pg_catalog.pg_current_xact_id()::xid')
    expect(insertGuard).toContain('manifest attestation chunks are immutable after header commit')
    expect(sql).toContain(
      'CREATE TRIGGER leaderboard_rank_manifest_attestation_chunks_insert_guard'
    )
  })

  it('content-addresses the complete rank-field domain with pinned encoders', () => {
    const encoderName = 'arena.encode_leaderboard_rank_manifest_fields_v1'
    const commitmentName = 'arena.build_leaderboard_rank_manifest_field_commitment_v1'
    const validatorName = 'arena.leaderboard_rank_manifest_attestation_chunk_is_valid_v1'
    const encoder = functionDefinition(encoderName)
    const commitment = functionDefinition(commitmentName)
    const validator = functionDefinition(validatorName)

    expect(encoder).not.toBe('')
    expect(commitment).not.toBe('')
    expect(validator).not.toBe('')
    expect(encoder).toContain('pg_catalog.jsonb_build_')
    expect(encoder).toContain('source')
    expect(encoder).toContain('source_trader_id')
    for (const field of [
      'roi',
      'pnl',
      'win_rate',
      'max_drawdown',
      'sharpe_ratio',
      'profit_factor',
      'trades_count',
      'total_score',
      'score_factors',
    ]) {
      expect(encoder).toContain(field)
    }
    const rawTotalScoreGuard = 'p_total_score <= 0 OR p_total_score > 100'
    const totalScoreTypmodAssignment = 'v_total_score := p_total_score'
    expect(encoder).toContain(rawTotalScoreGuard)
    expect(encoder).toContain(totalScoreTypmodAssignment)
    expect(encoder.indexOf(rawTotalScoreGuard)).toBeLessThan(
      encoder.indexOf(totalScoreTypmodAssignment)
    )
    for (const [input, persisted] of [
      ['p_roi', 'v_roi'],
      ['p_pnl', 'v_pnl'],
      ['p_win_rate', 'v_win_rate'],
      ['p_max_drawdown', 'v_max_drawdown'],
      ['p_sharpe_ratio', 'v_sharpe_ratio'],
      ['p_profit_factor', 'v_profit_factor'],
      ['p_total_score', 'v_total_score'],
      ['p_profitability_score', 'v_profitability_score'],
      ['p_risk_control_score', 'v_risk_control_score'],
      ['p_execution_score', 'v_execution_score'],
    ]) {
      expect(encoder).toContain(`${input} IS DISTINCT FROM ${persisted}`)
    }
    expect(encoder).toContain('manifest fields require their persisted numeric scale')
    expect(encoder).toContain("'^[a-z0-9]+(_[a-z0-9]+)*$'")
    expect(encoder).not.toContain('pg_catalog.convert_to(')
    expect(commitment).toContain(`${encoderName}(`)
    expect(commitment).toContain('pg_catalog.sha256(')
    expect(commitment).toContain('pg_catalog.convert_to(')
    expect(commitment).toContain("'UTF8'")
    expect(commitment).toContain("'hex'")
    expect(validator).toContain('arena.build_leaderboard_rank_manifest_chunk_sha256_v1(')
    expect(sql).toMatch(/[0-9a-f]{64}/)
    for (const body of [encoder, commitment, validator]) {
      expect(body).toContain('SECURITY INVOKER')
      expect(body).toContain('SET search_path = pg_catalog, pg_temp')
    }
    expect(sql).toContain('v_named_function_count <> 7')
  })

  it('recomputes every derived score and binds the exact live manifest horizon', () => {
    const encoder = functionDefinition('arena.encode_leaderboard_rank_manifest_fields_v1')
    const completeness = functionDefinition(
      'arena.validate_leaderboard_rank_manifest_attestation_complete_v1'
    )

    expect(encoder).toContain('v_expected_profitability := pg_catalog.floor(')
    expect(encoder).toContain('0.3::double precision * v_factor_pnl')
    expect(encoder).toContain('0.2::double precision * v_factor_roi')
    expect(encoder).toContain('v_expected_risk := CASE')
    expect(encoder).toContain('v_factor_drawdown IS NULL AND v_factor_sharpe IS NULL')
    expect(encoder).toContain('v_expected_execution := CASE')
    expect(encoder).toContain('v_factor_consistency IS NULL')
    expect(encoder).toContain('v_profitability_score IS DISTINCT FROM v_expected_profitability')
    expect(encoder).toContain('v_risk_control_score IS DISTINCT FROM v_expected_risk')
    expect(encoder).toContain('v_execution_score IS DISTINCT FROM v_expected_execution')
    expect(encoder).toContain('manifest-derived score commitment is invalid')

    expect(sql).toContain('manifest_valid_until timestamptz NOT NULL')
    expect(sql).toContain('CHECK (pg_catalog.isfinite(manifest_valid_until))')
    expect(sql).toContain('attested_at <= manifest_valid_until')
    expect(completeness).toContain('pg_catalog.pg_current_xact_id()::xid')
    expect(completeness).toContain('receipt.xmin = v_current_xid')
    expect(completeness).toContain('binding.xmin = v_current_xid')
    expect(completeness).toContain(
      'manifest attestation lacks current-transaction binding and batch-zero receipt'
    )
    expect(completeness).toContain('manifest.valid_until = NEW.manifest_valid_until')
    expect(completeness).toContain('manifest.valid_until > pg_catalog.clock_timestamp()')
    expect(completeness).toMatch(
      /FROM ONLY arena\.leaderboard_score_input_manifests AS manifest[\s\S]*?FOR SHARE;/
    )
    expect(completeness).toContain('manifest attestation lacks its exact live source manifest')
    expect(sql).not.toMatch(/REFERENCES arena\.leaderboard_score_input_manifests\s*\(/i)
  })

  it('pins every executable helper body and the immutable parent guard', () => {
    const expectedBodyHashes: Record<string, string> = {
      'arena.encode_leaderboard_rank_manifest_fields_v1':
        '504e8b8fc47f023bb9e821b7b6212f4df773cb94e63cfd5613fb2fff01964b16',
      'arena.build_leaderboard_rank_manifest_field_commitment_v1':
        '72c4e558313daec92785722c35788e6490a4d9a2144261d0afe9d96666ea04f6',
      'arena.build_leaderboard_rank_manifest_chunk_sha256_v1':
        '0dddcffebb56d9a51e0869e29cc16ac18f78251d58907764fb02101fa8dad322',
      'arena.leaderboard_rank_manifest_attestation_chunk_is_valid_v1':
        'eaead90785261fd8400748497005d34013d468b5a836a0dbce0be38eaf843d07',
      'arena.build_leaderboard_rank_manifest_chunks_sha256_v1':
        'a663274e1a45e06c90f17fecdb646854be6112cb6e22d2af343afd9737d365dd',
      'arena.guard_leaderboard_rank_manifest_attestation_chunk_insert_v1':
        '21cbd784ed8016f1a3acbe96ff82885d5679dce10697ddb658cb660ef449caa9',
      'arena.validate_leaderboard_rank_manifest_attestation_complete_v1':
        'a67d03810591c130b7b6e7dbd63becc9b4d08eb4580fd314a223032e1f187e6b',
    }

    for (const [name, expectedHash] of Object.entries(expectedBodyHashes)) {
      const source = functionSource(name)
      expect(source).not.toBe('')
      expect(source).toMatch(/^\n[\s\S]*\n$/)
      expect(sha256(source)).toBe(expectedHash)
      expect(postflight).toContain(`'${expectedHash}'`)
    }
    expect(postflight.match(/'[0-9a-f]{64}'/g)).toHaveLength(7)
    expect(sql).toContain("'3896caded6f9f7062305267ebf4d99f05f8e6299711d00b8a252d5d043b26e2e'")
  })

  it('pins the exact 12+12 column and six-trigger postflight catalogs', () => {
    expect(postflight).not.toBe('')
    expect(occurrenceCount(postflight, /\) <> 12/)).toBe(2)
    expect(
      occurrenceCount(
        postflight,
        /\(v_header::oid,\s*'[^']+'::name,\s*'[^']+'::pg_catalog\.regtype\)/
      )
    ).toBe(12)
    expect(
      occurrenceCount(
        postflight,
        /\(v_chunks::oid,\s*'[^']+'::name,\s*'[^']+'::pg_catalog\.regtype\)/
      )
    ).toBe(12)

    const normalizedPostflight = postflight.replace(/\s+/g, ' ')
    for (const [relation, trigger, functionSignature, triggerType] of [
      [
        'v_header',
        'leaderboard_rank_manifest_attestations_immutable',
        'arena.reject_leaderboard_rank_publication_mutation()',
        '27',
      ],
      [
        'v_header',
        'leaderboard_rank_manifest_attestations_no_truncate',
        'arena.reject_leaderboard_rank_publication_mutation()',
        '34',
      ],
      [
        'v_header',
        'leaderboard_rank_manifest_attestations_complete',
        'arena.validate_leaderboard_rank_manifest_attestation_complete_v1()',
        '5',
      ],
      [
        'v_chunks',
        'leaderboard_rank_manifest_attestation_chunks_insert_guard',
        'arena.guard_leaderboard_rank_manifest_attestation_chunk_insert_v1()',
        '7',
      ],
      [
        'v_chunks',
        'leaderboard_rank_manifest_attestation_chunks_immutable',
        'arena.reject_leaderboard_rank_publication_mutation()',
        '27',
      ],
      [
        'v_chunks',
        'leaderboard_rank_manifest_attestation_chunks_no_truncate',
        'arena.reject_leaderboard_rank_publication_mutation()',
        '34',
      ],
    ]) {
      expect(normalizedPostflight).toContain(
        `${relation}::oid, '${trigger}'::name, '${functionSignature}'::pg_catalog.regprocedure::oid, ${triggerType}::smallint`
      )
    }
    expect(occurrenceCount(postflight, /::smallint/)).toBe(6)
    expect(postflight).toContain('trigger_row.tgfoid <> expected.function_oid')
    expect(postflight).toContain('trigger_row.tgtype <> expected.trigger_type')
    expect(postflight).toContain("trigger_row.tgenabled <> 'O'")
    expect(postflight).toContain('manifest attestation exact trigger definition drifted')
  })

  it('fails closed on partial install and pins preflight and postflight catalogs', () => {
    expect(migration.trimStart().startsWith('--')).toBe(true)
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(sql).toMatch(/partially installed/i)
    expect(sql).toMatch(/preflight/i)
    expect(sql).toMatch(/postflight/i)
    expect(sql).toContain('pg_catalog.to_regclass(')
    expect(sql).toContain('pg_catalog.to_regprocedure(')
    expect(sql).toContain('function_row.prosrc')
    expect(sql).toContain('function_row.proconfig')
    expect(sql).toContain('constraint_row')
    expect(sql).toContain('trigger_row')
    expect(sql).toContain(') <> 23 OR EXISTS (')
    expect(sql).toContain(') <> 7 OR EXISTS (')
    expect(sql).toContain(') <> 3 OR (')
    expect(sql).toContain('manifest attestation exact column catalog drifted')
    expect(sql).toContain('manifest attestation exact function definition drifted')
    expect(sql).toContain('manifest attestation foreign-key topology drifted')
    expect(sql).toContain('manifest attestation trigger catalog drifted')
    expect(sql).toContain('manifest attestation function catalog or ACL drifted')
    expect(sql).not.toMatch(/__[A-Z0-9_]+__/)
    expect(sql).not.toMatch(/CREATE TABLE IF NOT EXISTS/i)
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/i)
    expect(sql).not.toMatch(/DROP (?:TABLE|FUNCTION|CONSTRAINT)/i)
  })

  it('remains dormant and is not yet consumed by the atomic writer', () => {
    expect(sql).not.toMatch(
      /(?:INSERT\s+INTO|UPDATE(?:\s+ONLY)?|DELETE\s+FROM)\s+public\.leaderboard_ranks/i
    )
    expect(sql).not.toMatch(/LOCK TABLE public\.leaderboard_ranks\s+IN\s+SHARE ROW EXCLUSIVE/i)
    expect(sql).not.toMatch(
      /CREATE(?: OR REPLACE)? FUNCTION arena\.write_leaderboard_rank_generation_batch_v1/i
    )
    expect(writerSql).not.toContain('arena.leaderboard_rank_manifest_attestations')
    expect(writerSql).not.toContain('arena.leaderboard_rank_manifest_attestation_chunks')
    expect(writerSql).not.toContain('arena.encode_leaderboard_rank_manifest_fields_v1')
    expect(writerSql).not.toContain('arena.build_leaderboard_rank_manifest_field_commitment_v1')
    expect(writerSql).not.toContain('arena.leaderboard_rank_manifest_attestation_chunk_is_valid_v1')
  })
})
