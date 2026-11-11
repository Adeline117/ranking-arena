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

// Each replacement = header + original body with exactly one reviewed hunk
// changed. Swapping the hunk back must reproduce the original byte-for-byte.
const CASES = [
  {
    original: '20260728122000_bitget_bots_canonical_timeframe.sql',
    originalSha256: '96e41ae75e5568371500a57018fa68c3c931449ef49e44bd7d4b7e82f98bc08f',
    replacement: '20261111134210_bitget_bots_canonical_timeframe_partial_seed.sql',
    firstOriginalLine: '-- Migration: 20260728122000_bitget_bots_canonical_timeframe.sql',
    originalHunk: `            AND source.pagination_kind IS NOT DISTINCT FROM 'numeric'
          )
        )`,
    replacementHunk: `            AND source.pagination_kind IS NOT DISTINCT FROM 'numeric'
          )
          -- Partially converged production seed (2026-10-30 backup evidence).
          OR (
            source.timeframes_native IS NOT DISTINCT FROM ARRAY[30]::integer[]
            AND source.page_size IS NOT DISTINCT FROM 20
            AND source.pagination_kind IS NOT DISTINCT FROM 'infinite_scroll'
          )
        )`,
  },
  {
    original: '20260728124000_quarantine_bitget_bot_cumulative_rank_authority.sql',
    originalSha256: '5ec0aa2b69a5e04bc94bf7b958ddf595cc4fb6650b4256b9cc04432929d32cc8',
    replacement: '20261111134416_quarantine_bitget_bot_cumulative_rank_authority_prod_reader.sql',
    firstOriginalLine:
      '-- Migration: 20260728124000_quarantine_bitget_bot_cumulative_rank_authority.sql',
    originalHunk: `         (
           v_source_sha256 = v_target.legacy_source_sha256
           AND v_function_row.proconfig =`,
    replacementHunk: `         (
           (
             v_source_sha256 = v_target.legacy_source_sha256
             -- Production's comment-stripped but SQL-identical legacy body.
             OR (
               v_target.signature = 'public.arena_weekly_leaders(integer)'
               AND v_source_sha256 =
                 '2aa0c4fe43ea4fe48210c07245569f3b5dc005a3b0e542da89eb85a719266eaf'
             )
           )
           AND v_function_row.proconfig =`,
  },
] as const

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe('Bitget bot production-state forward replacements', () => {
  it.each(CASES)('$replacement changes only one reviewed hunk of $original', (entry) => {
    const original = read(entry.original)
    const replacement = read(entry.replacement)

    const headerEnd = replacement.indexOf(entry.firstOriginalLine)
    expect(headerEnd).toBeGreaterThan(0)
    expect(replacement.slice(0, headerEnd)).toContain('Forward replacement for')

    const body = replacement.slice(headerEnd)
    expect(count(original, entry.originalHunk)).toBe(1)
    expect(count(body, entry.replacementHunk)).toBe(1)
    expect(body.replace(entry.replacementHunk, entry.originalHunk)).toBe(original)
  })

  it.each(CASES)('$original stays byte-for-byte unchanged', (entry) => {
    expect(sha256(read(entry.original))).toBe(entry.originalSha256)
  })

  it('accepts the partial seed only with the reviewed 30D/20-row identity', () => {
    const replacement = read(CASES[0].replacement)
    // The convergence UPDATE still targets numeric pagination.
    expect(replacement).toContain("pagination_kind = 'numeric'")
    expect(count(replacement, "'infinite_scroll'")).toBe(3)
  })

  it('admits the extra weekly-leaders digest for that one signature only', () => {
    const replacement = read(CASES[1].replacement)
    expect(
      count(replacement, '2aa0c4fe43ea4fe48210c07245569f3b5dc005a3b0e542da89eb85a719266eaf')
    ).toBe(1)
  })
})
