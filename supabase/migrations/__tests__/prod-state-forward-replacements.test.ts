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
