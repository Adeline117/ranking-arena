import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260729015000_leaderboard_rank_generation_attested_batch_writer.sql'
  ),
  'utf8'
)

const withoutComments = migration
  .replace(/^\s*--[^\n]*(?:\n|$)/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')

const writerMatch = withoutComments.match(
  /CREATE OR REPLACE FUNCTION arena\.write_leaderboard_rank_generation_batch_v1\([\s\S]*?\)\s*RETURNS jsonb[\s\S]*?AS \$body\$([\s\S]*?)\$body\$;/
)
const writer = writerMatch?.[1] ?? ''

const occurrenceCount = (value: string, pattern: RegExp): number =>
  value.match(new RegExp(pattern.source, pattern.flags.replace('g', '') + 'g'))?.length ?? 0

describe('leaderboard rank generation attested batch writer', () => {
  it('keeps the owner-only eight-argument RPC and accepts no caller attestation payload', () => {
    expect(writerMatch).not.toBeNull()
    expect(withoutComments).toMatch(
      /write_leaderboard_rank_generation_batch_v1\(\s*p_season_id text,\s*p_generation_seq bigint,\s*p_score_cohort_id uuid,\s*p_batch_index integer,\s*p_score_input_manifest_id uuid,\s*p_score_input_manifest_digest text,\s*p_batch_sha256_plan text\[\],\s*p_rows arena\.leaderboard_rank_batch_row_v1\[\]\s*\)/
    )
    expect(writer).not.toMatch(/p_(?:attestation|chunk|identit|commitment)/i)
    expect(withoutComments).toMatch(
      /ALTER FUNCTION arena\.write_leaderboard_rank_generation_batch_v1\([\s\S]*?\) OWNER TO postgres;/
    )
    expect(withoutComments).toMatch(
      /REVOKE ALL ON FUNCTION arena\.write_leaderboard_rank_generation_batch_v1\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
    )
  })

  it('narrows every generation to canonical fixed chunks', () => {
    expect(writer).toMatch(/p_batch_index\s*>?=\s*64/)
    expect(writer).toMatch(
      /expected_batch_count[\s\S]{0,300}\(\s*v_claim\.expected_rank_count\s*\+\s*999\s*\)\s*\/\s*1000/
    )
    expect(writer).toMatch(/v_current_row_count[\s\S]{0,800}LEAST\(\s*1000/i)
    expect(writer).toMatch(/v_prior_row_count[\s\S]{0,500}p_batch_index\s*\*\s*1000/)
    expect(writer).toContain('first_position')
    expect(writer).toContain('chunk_index')
  })

  it('derives batch-zero chunks from the verified raw manifest inside the writer', () => {
    expect(writer).toContain('arena.verify_leaderboard_score_input_manifest_v1')
    expect(writer).toContain("v_manifest.manifest->'inputs'")
    expect(writer).toContain("v_manifest.manifest->'outputs'")
    expect(writer).toContain('arena.build_leaderboard_rank_manifest_field_commitment_v1')
    expect(writer).toContain('arena.build_leaderboard_rank_manifest_chunk_sha256_v1')
    expect(writer).toContain('arena.build_leaderboard_rank_manifest_chunks_sha256_v1')
    expect(writer).toMatch(
      /IF p_batch_index = 0 THEN[\s\S]*?verify_leaderboard_score_input_manifest_v1/
    )
    expect(occurrenceCount(writer, /FROM ONLY arena\.leaderboard_score_input_manifests/)).toBe(1)
  })

  it('attests scorer-backed fields and defers terminal rank to publication finalization', () => {
    expect(writer).toContain('arena.build_leaderboard_rank_manifest_field_commitment_v1')
    expect(writer).toContain('arena.build_leaderboard_rank_typed_field_commitment_v1')
    expect(writer).not.toContain('build_leaderboard_rank_manifest_ranked_commitment')
    expect(writer).not.toContain('(supplied.rank_row).rank')
    expect(withoutComments).not.toMatch(/CREATE FUNCTION[^;]*ranked_commitment/i)
    expect(migration).toContain(
      'terminal publication rank requires a separate all-generation finalizer attestation'
    )
  })

  it('binds later batches to the exact immutable chunk and typed field commitments', () => {
    expect(writer).toContain('arena.leaderboard_rank_manifest_attestations')
    expect(writer).toContain('arena.leaderboard_rank_manifest_attestation_chunks')
    expect(writer).toMatch(/chunk\.chunk_index\s*=\s*p_batch_index/)
    expect(writer).toMatch(/chunk\.row_count[\s\S]{0,800}v_current_row_count/)
    expect(writer).toContain('v_expected_identities := v_attestation_chunk.identities')
    expect(writer).toContain('v_expected_commitments := v_attestation_chunk.field_commitments')
    expect(writer).toMatch(
      /v_supplied_identities IS DISTINCT FROM v_expected_identities[\s\S]{0,300}v_supplied_commitments IS DISTINCT FROM v_expected_commitments/
    )
  })

  it('retains exact durable-prefix identity proof and checks every prior source fence', () => {
    expect(writer).toMatch(
      /leaderboard_rank_manifest_attestation_chunks[\s\S]{0,2200}jsonb_array_elements\([\s\S]{0,400}identities/
    )
    expect(writer).toMatch(/(?:FULL JOIN|EXCEPT)[\s\S]{0,1800}(?:public\.)?leaderboard_ranks/i)
    expect(writer).toContain('arena.leaderboard_rank_generation_source_fence_receipts')
    expect(writer).toContain('arena.leaderboard_rank_mutation_fences')
    expect(writer).toMatch(
      /(?:max|row_number|distinct on)[\s\S]{0,1800}mutation_seq_after[\s\S]{0,1800}mutation_seq/i
    )
  })

  it('writes the batch-zero authority graph in one ordered transaction', () => {
    const binding = writer.indexOf(
      'INSERT INTO arena.leaderboard_rank_generation_manifest_bindings'
    )
    const receipt = writer.indexOf('INSERT INTO arena.leaderboard_rank_generation_batch_receipts')
    const header = writer.indexOf('INSERT INTO arena.leaderboard_rank_manifest_attestations')
    const chunks = writer.indexOf('INSERT INTO arena.leaderboard_rank_manifest_attestation_chunks')
    const sourceReceipts = writer.indexOf(
      'arena.leaderboard_rank_generation_source_fence_receipts',
      chunks
    )
    const headCas = writer.indexOf(
      'UPDATE ONLY arena.leaderboard_rank_generation_heads',
      sourceReceipts
    )

    expect(binding).toBeGreaterThan(-1)
    expect(receipt).toBeGreaterThan(binding)
    expect(header).toBeGreaterThan(receipt)
    expect(chunks).toBeGreaterThan(header)
    expect(sourceReceipts).toBeGreaterThan(chunks)
    expect(headCas).toBeGreaterThan(sourceReceipts)
    expect(writer).toMatch(
      /SET CONSTRAINTS\s*arena\.rank_manifest_attestation_batch_zero_fkey,\s*arena\.leaderboard_rank_manifest_attestations_complete\s*DEFERRED/
    )
  })

  it('fails closed on every unattested legacy receipt and never backfills it', () => {
    expect(withoutComments).toMatch(
      /leaderboard_rank_generation_manifest_bindings[\s\S]{0,1800}UNION[\s\S]{0,1800}leaderboard_rank_generation_batch_receipts/i
    )
    expect(withoutComments).toMatch(/refuses any legacy generation receipt without attestation/i)
    expect(withoutComments).not.toMatch(
      /INSERT INTO arena\.leaderboard_rank_manifest_attestations[\s\S]{0,500}SELECT[\s\S]{0,500}leaderboard_rank_generation_batch_receipts/i
    )
  })

  it('pins the old writer and the complete attestation dependency surface', () => {
    expect(withoutComments).toContain(
      '2f31f274ddac524b3de3eac8962fa079414b790807f57e509acc5eb3686d005a'
    )
    for (const digest of [
      '0dddcffebb56d9a51e0869e29cc16ac18f78251d58907764fb02101fa8dad322',
      'a663274e1a45e06c90f17fecdb646854be6112cb6e22d2af343afd9737d365dd',
      '72c4e558313daec92785722c35788e6490a4d9a2144261d0afe9d96666ea04f6',
      '504e8b8fc47f023bb9e821b7b6212f4df773cb94e63cfd5613fb2fff01964b16',
      '21cbd784ed8016f1a3acbe96ff82885d5679dce10697ddb658cb660ef449caa9',
      'eaead90785261fd8400748497005d34013d468b5a836a0dbce0be38eaf843d07',
      'a67d03810591c130b7b6e7dbd63becc9b4d08eb4580fd314a223032e1f187e6b',
    ]) {
      expect(withoutComments).toContain(digest)
    }
    expect(withoutComments).toContain('leaderboard_rank_manifest_attestations')
    expect(withoutComments).toContain('leaderboard_rank_manifest_attestation_chunks')
    expect(withoutComments).toMatch(/constraint[\s\S]{0,1800}23/i)
    expect(withoutComments).toMatch(/trigger[\s\S]{0,1800}6/i)
    expect(withoutComments).toContain('relrowsecurity')
    expect(withoutComments).toContain('has_table_privilege')
    expect(withoutComments).toContain('leaderboard-rank-manifest-attestation-constraints@1')
    expect(withoutComments).toContain('leaderboard-rank-manifest-attestation-indexes@1')
    expect(withoutComments).toContain(
      'c35d602c1cd83660e2efa8e1e03506bfa747d5fa0e18a29cc1d6e268f71aa9ee'
    )
    expect(withoutComments).toContain(
      'b22b7e1bbb9f78e0c59f05ca36f0de7368d91d54c55f8e5917031a73dfb3884a'
    )
    expect(withoutComments).toContain('pg_catalog.pg_inherits')
  })

  it('postflights the replacement body hash and exact function catalog shape', () => {
    expect(withoutComments).toMatch(
      /v_writer_body_digest[\s\S]*?[0-9a-f]{64}[\s\S]*?atomic attested batch writer body drifted/i
    )
    expect(withoutComments).toContain("function_row.provolatile = 'v'")
    expect(withoutComments).toContain("function_row.proparallel = 'u'")
    expect(withoutComments).toContain('function_row.pronargs = 8')
    expect(withoutComments).toContain("'lock_timeout=10s'")
    expect(withoutComments).toContain('pg_catalog.has_function_privilege')
    expect(withoutComments).toContain(
      'ddb7c25c0c61c1ea70377bc6879e913a07e4529b1e4c8fa35a4b5d9f2c50f548'
    )
    expect(withoutComments).toContain(
      'aafce6e95ed4662239a1f84295cc3158dc0011f8bc8948d0161f73767e73dd9a'
    )
    expect(withoutComments).not.toContain('build_leaderboard_rank_manifest_ranked_commitment')
  })
})
