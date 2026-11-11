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

// The only comment lines the replacements add next to their cron block.
const REPLACEMENT_BLOCK_COMMENT =
  /-- Supabase grants the migration owner only SELECT on cron\.job, so the job is\n(?:--[^\n]*\n){1,2}/u

// Removes the named DO block (and the replacement's own explanatory comment),
// so the remaining bytes must equal the original's remaining bytes.
function stripBlock(sql: string, tag: string): string {
  const start = sql.indexOf(`DO $${tag}$`)
  const end = sql.indexOf(`$${tag}$;`, start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const before = sql.slice(0, start).replace(REPLACEMENT_BLOCK_COMMENT, '')
  return before + sql.slice(end + `$${tag}$;`.length)
}

const CASES = [
  {
    original: '20260729230000_token_ranking_generation_barrier.sql',
    replacement: '20261111133259_token_ranking_generation_barrier_cron_api.sql',
    firstOriginalLine:
      '-- Bind every token-ranking page and popular-token response to one atomically',
    tag: 'cron_update',
  },
  {
    original: '20260804043000_retire_legacy_token_rankings.sql',
    replacement: '20261111133300_retire_legacy_token_rankings_cron_api.sql',
    firstOriginalLine: '-- Retire the legacy token-ranking publication surface.',
    tag: 'disable_cron',
  },
] as const

describe('token-ranking cron API forward replacements', () => {
  it.each(CASES)('$replacement differs from $original only in the cron block', (entry) => {
    const original = read(entry.original)
    const replacement = read(entry.replacement)

    expect(original.startsWith(entry.firstOriginalLine)).toBe(true)
    const headerEnd = replacement.indexOf(entry.firstOriginalLine)
    expect(headerEnd).toBeGreaterThan(0)
    expect(replacement.slice(0, headerEnd)).toContain(`Forward replacement for ${entry.original}`)

    const replacementBody = replacement.slice(headerEnd)
    expect(stripBlock(replacementBody, entry.tag)).toBe(stripBlock(original, entry.tag))
  })

  it.each(CASES)('$replacement changes cron only through cron.alter_job', (entry) => {
    const original = read(entry.original)
    const replacement = read(entry.replacement)

    // The original is the failure being replaced: a direct catalog write that
    // Supabase's SELECT-only cron.job grant rejects for the migration owner.
    expect(original).toMatch(/UPDATE cron\.job/u)
    expect(replacement).not.toMatch(/(UPDATE|INSERT INTO|DELETE FROM) cron\.job/u)
    expect(replacement).toContain('PERFORM cron.alter_job(')
    expect(replacement).toContain('FROM cron.job AS job')
  })

  it('leaves the superseded originals byte-for-byte unchanged', () => {
    expect(sha256(read(CASES[0].original))).toBe(
      'c04644221e095a493ac3e57cd5af91f11cfb233343838dfab0d7e3a3cc1471dd'
    )
    expect(sha256(read(CASES[1].original))).toBe(
      'b7f9c3fdedba81c315e7a0441e878ac4bac536cad1fd7a514df5d5d1bb724433'
    )
  })
})
