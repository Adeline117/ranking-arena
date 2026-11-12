import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const MIGRATIONS_DIR = path.resolve(__dirname, '..')

function read(name: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8')
}

function sha256(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

const SPOT_STATUS = `(
      source.status = 'active'
      OR (source.slug = 'bingx_spot' AND source.status = 'blocked_pending_vps')
    )`

// Each replacement = explanatory header + original body with only the listed
// hunks changed. Reverting every hunk must reproduce the original byte-for-byte.
const CASES: ReadonlyArray<{
  original: string
  originalSha256: string
  replacement: string
  hunks: ReadonlyArray<readonly [original: string, replacement: string]>
}> = [
  {
    original: '20260715231500_fix_gmx_source_contract.sql',
    originalSha256: '949dbafc0a6d26f78b1488fa0ea8d9315b0e6de3f9e3b6f3d986fd40021fa5ba',
    replacement: '20261111194845_fix_gmx_source_contract_current_population.sql',
    hunks: [
      [
        `    IF NOT ((v_live_counts->>'leaderboard_snapshots')::bigint BETWEEN 400 AND 650)
       OR NOT ((v_live_counts->>'trader_stats')::bigint BETWEEN 500 AND 600)
       OR NOT ((v_live_counts->>'trader_series')::bigint BETWEEN 25000 AND 31000)
       OR NOT ((v_live_counts->>'trader_series_weekly')::bigint BETWEEN 700 AND 900)
       OR NOT ((v_live_counts->>'leaderboard_ranks')::bigint BETWEEN 75 AND 250)
       OR (v_live_counts->>'leaderboard_count_cache')::bigint NOT IN (9, 12)`,
        `    -- The July audit bands no longer describe production (the 2026-10-30
    -- backup has 1,095 GMX trader_stats rows). What matters is that every row
    -- predates the v2 contract: archive only while the registry is still the
    -- pre-v2 configuration (no pnl_contract_version, old subgraph endpoint),
    -- so no row could have been produced under v2. The archive is complete
    -- (counts and digests below) and 20260715232500 verifies it before CUTOVER.
    IF NOT EXISTS (
         SELECT 1
         FROM arena.sources AS source_row
         WHERE source_row.slug = 'gmx'
           AND NOT source_row.meta ? 'pnl_contract_version'
           AND source_row.meta->'endpoints'->>'subgraph' =
               'https://gmx.squids.live/gmx-synthetics-arbitrum/graphql'
       )
       OR (v_live_counts->>'leaderboard_count_cache')::bigint NOT IN (9, 12)`,
      ],
    ],
  },
  {
    original: '20260729061000_tier_a_execution_claim_enforcement.sql',
    originalSha256: '9dbcea2c3b5b951c19c0ba32d616e7d7b7da617f54b93d2d4b72fc3006cbe887',
    replacement: '20261111192134_tier_a_execution_claim_enforcement_later_raw_guards.sql',
    hunks: [
      [
        `    'arena.protect_leaderboard_acquisition_raw_evidence()'::pg_catalog.regprocedure,
    27,
    false,
    false
  ),`,
        `    'arena.protect_leaderboard_acquisition_raw_evidence()'::pg_catalog.regprocedure,
    27,
    false,
    false
  ),
  -- Reviewed raw-object guards installed by later launch migrations.
  (
    'arena.raw_objects'::pg_catalog.regclass,
    'protect_record_surface_publication_raw_before_write',
    'arena.protect_record_surface_publication_raw_object()'::pg_catalog.regprocedure,
    27,
    false,
    false
  ),
  (
    'arena.raw_objects'::pg_catalog.regclass,
    'protect_copier_snapshot_raw_before_write',
    'arena.protect_copier_snapshot_raw_object()'::pg_catalog.regprocedure,
    27,
    false,
    false
  ),
  (
    'arena.raw_objects'::pg_catalog.regclass,
    'protect_copier_snapshot_trust_raw_before_write',
    'arena.protect_copier_snapshot_trust_raw_object()'::pg_catalog.regprocedure,
    27,
    false,
    false
  ),`,
      ],
    ],
  },
  {
    original: '20260725017250_normalize_leaderboard_rank_max_drawdown.sql',
    originalSha256: '951ab2b3c24da62169022ac65b451b5139db52d6a03acc3ae616d2d79bcb7920',
    replacement: '20261111185914_normalize_leaderboard_rank_max_drawdown_prod_constraint.sql',
    hunks: [
      [
        `        constraint_row.conname NOT IN (
          'leaderboard_ranks_max_drawdown_check',`,
        `        constraint_row.conname NOT IN (
          -- Production's name for the reviewed legacy expression.
          'chk_lr_part_mdd',
          'leaderboard_ranks_max_drawdown_check',`,
      ],
    ],
  },
  {
    original: '20260803090000_record_provenance_clocks.sql',
    originalSha256: '3fcc835f33e369feac52a2c260869167c65c75536e7e0ff0cbf4683cb51dee1b',
    replacement: '20261111134937_record_provenance_clocks_prod_reader.sql',
    hunks: [
      [
        `         v_records_hash =
           '07b2356e65a8280af27bc7d524130293115b1b4a4d56a8f140a721472521ee31'
         AND`,
        `         v_records_hash IN (
           '07b2356e65a8280af27bc7d524130293115b1b4a4d56a8f140a721472521ee31',
           -- Production's comment-stripped but SQL-identical legacy body.
           'ab84c298c4ff32fa0431a0debabcdc7bb882cddec1cd9e4db775822119c569f7'
         )
         AND`,
      ],
    ],
  },
  {
    original: '20260804044000_freeze_legacy_position_history_relations.sql',
    originalSha256: 'ffb1fc66898cab59c76bccc01ab51532847df9d6c50d3e56241ff62b35f94e13',
    replacement: '20261111135144_freeze_legacy_position_history_relations_prod_creator.sql',
    hunks: [
      [
        `         '2beaa5eae7722d0325de97c0bcbe4fa37fb124a26074325dd81c39fafebcb5e1',
         '59aa806f`,
        `         '2beaa5eae7722d0325de97c0bcbe4fa37fb124a26074325dd81c39fafebcb5e1',
         -- Production's whitespace/comment-only variant of the legacy body.
         'f93b07eee3660ec36a20c590ad25d0257327338408807eedbfdabf4e346d65a9',
         '59aa806f`,
      ],
      [
        `  IF v_creator_hash =
       '2beaa5eae7722d0325de97c0bcbe4fa37fb124a26074325dd81c39fafebcb5e1' THEN`,
        `  IF v_creator_hash IN (
       '2beaa5eae7722d0325de97c0bcbe4fa37fb124a26074325dd81c39fafebcb5e1',
       -- Production's whitespace/comment-only variant of the legacy body.
       'f93b07eee3660ec36a20c590ad25d0257327338408807eedbfdabf4e346d65a9'
     ) THEN`,
      ],
    ],
  },
  {
    original: '20260804045000_quarantine_bingx_rank_authority.sql',
    originalSha256: '91b32ff3fc8d9a854ce20acba27e04580afed0ceae0d5ba2069eef67b4070655',
    replacement: '20261111135302_quarantine_bingx_rank_authority_blocked_spot.sql',
    hunks: [
      [
        `    AND source.pagination_kind = 'numeric'
    AND source.status = 'active'`,
        `    AND source.pagination_kind = 'numeric'
    AND ${SPOT_STATUS}`,
      ],
      [
        `           AND preimage.value->>'status' = 'active'`,
        `           AND (
             preimage.value->>'status' = 'active'
             OR (
               preimage.value->>'slug' = 'bingx_spot'
               AND preimage.value->>'status' = 'blocked_pending_vps'
             )
           )`,
      ],
      [
        `          source.status <> 'active'
          OR source.serving_mode <> 'shadow'`,
        `          NOT (
            source.status = 'active'
            OR (source.slug = 'bingx_spot' AND source.status = 'blocked_pending_vps')
          )
          OR source.serving_mode <> 'shadow'`,
      ],
      [
        `    )
      AND source.status = 'active'
      AND source.serving_mode IN ('serving', 'shadow');`,
        `    )
      AND (
        source.status = 'active'
        OR (source.slug = 'bingx_spot' AND source.status = 'blocked_pending_vps')
      )
      AND source.serving_mode IN ('serving', 'shadow');`,
      ],
      [
        `      AND source.status = 'active'
      AND source.serving_mode = 'shadow'
      AND source.meta->>'rank_visibility' = 'shadow'`,
        `      AND (
        source.status = 'active'
        OR (source.slug = 'bingx_spot' AND source.status = 'blocked_pending_vps')
      )
      AND source.serving_mode = 'shadow'
      AND source.meta->>'rank_visibility' = 'shadow'`,
      ],
    ],
  },
]

describe('production-state forward replacements', () => {
  it.each(CASES)('$replacement reverts to $original exactly', (entry) => {
    const original = read(entry.original)
    const replacement = read(entry.replacement)
    const firstOriginalLine = original.slice(0, original.indexOf('\n'))

    const headerEnd = replacement.indexOf(firstOriginalLine)
    expect(headerEnd).toBeGreaterThan(0)
    expect(replacement.slice(0, headerEnd)).toContain(`Forward replacement for ${entry.original}`)

    let body = replacement.slice(headerEnd)
    for (const [originalHunk, replacementHunk] of entry.hunks) {
      expect(count(body, replacementHunk)).toBe(1)
      body = body.replace(replacementHunk, originalHunk)
    }
    expect(body).toBe(original)
  })

  it.each(CASES)('$original stays byte-for-byte unchanged', (entry) => {
    expect(sha256(read(entry.original))).toBe(entry.originalSha256)
  })

  it('never relaxes the bingx_futures status or changes any source status', () => {
    const replacement = read('20261111135302_quarantine_bingx_rank_authority_blocked_spot.sql')
    expect(replacement).not.toMatch(/SET\s+status\s*=/u)
    expect(
      count(replacement, "source.slug = 'bingx_spot' AND source.status = 'blocked_pending_vps'")
    ).toBe(4)
    expect(replacement).not.toContain("'bingx_futures' AND source.status = 'blocked_pending_vps'")
  })
})
