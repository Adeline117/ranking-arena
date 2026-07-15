import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260715091500_atomic_comment_integrity.sql'),
  'utf8'
)

const readBoundary = migration.slice(
  migration.indexOf('DROP POLICY IF EXISTS "Comments are viewable by everyone"'),
  migration.indexOf('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
)

describe('atomic comment integrity read boundary', () => {
  it('does not redefine the parent post audience during the expand phase', () => {
    expect(migration).not.toMatch(/(?:DROP|CREATE) POLICY[\s\S]*?ON public\.posts/)
  })

  it('composes comment reads with the currently RLS-visible parent post', () => {
    expect(readBoundary).toMatch(/FROM public\.posts AS visible_post/)
    expect(readBoundary).toMatch(/visible_post\.id = comments\.post_id/)
    expect(readBoundary).toMatch(/comments[\s\S]*deleted_at IS NULL/)
    expect(readBoundary).toMatch(/has_block_with_current_user\(user_id\)/)

    expect(readBoundary).not.toMatch(/visibility\s*=/)
    expect(readBoundary).not.toMatch(/public\.user_follows/)
    expect(readBoundary).not.toMatch(/public\.group_members/)
  })

  it('composes reaction reads with the currently RLS-visible comment', () => {
    expect(readBoundary).toMatch(/FROM public\.comments AS visible_comment/)
    expect(readBoundary).toMatch(/visible_comment\.id = comment_likes\.comment_id/)
    expect(readBoundary).toMatch(/visible_comment\.deleted_at IS NULL/)
    expect(readBoundary).toMatch(/has_block_with_current_user\(visible_comment\.user_id\)/)
    expect(readBoundary).not.toMatch(/JOIN public\.posts/)
  })
})
