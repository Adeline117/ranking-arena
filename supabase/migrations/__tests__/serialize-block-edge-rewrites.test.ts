import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260715224200_serialize_block_edge_rewrites.sql'),
  'utf8'
)

describe('block edge rewrite serialization migration', () => {
  it('adds both OLD and NEW unordered pairs for endpoint-changing updates', () => {
    expect(migration).toMatch(/TG_OP IN \('UPDATE', 'DELETE'\)[\s\S]*OLD\.blocker_id/)
    expect(migration).toMatch(/TG_OP IN \('INSERT', 'UPDATE'\)[\s\S]*NEW\.blocker_id/)
    expect(migration).toMatch(/LEAST\(OLD\.blocker_id::text, OLD\.blocked_id::text\)/)
    expect(migration).toMatch(/GREATEST\(NEW\.blocker_id::text, NEW\.blocked_id::text\)/)
  })

  it('deduplicates and sorts every affected pair before taking advisory locks', () => {
    expect(migration).toMatch(/SELECT DISTINCT affected_pair[\s\S]*ORDER BY affected_pair/)
    expect(migration).toMatch(/pg_advisory_xact_lock\([\s\S]*'post-audience:block:' \|\| v_pair/)
  })

  it('replaces the exact endpoint trigger and keeps the helper private', () => {
    expect(migration).toMatch(
      /BEFORE INSERT OR DELETE OR UPDATE OF blocker_id, blocked_id[\s\S]*ON public\.blocked_users/
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.serialize_post_audience_block_edge\(\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
  })
})
