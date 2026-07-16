import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isSitemapProfileActive } from '../route'

const route = readFileSync(join(process.cwd(), 'app/api/sitemap-xml/route.ts'), 'utf8')

describe('sitemap public audience boundary', () => {
  it('only selects standalone active original public post candidates', () => {
    expect(route).toContain(".eq('status', 'active')")
    expect(route).toContain(".eq('visibility', 'public')")
    expect(route).toContain(".is('deleted_at', null)")
    expect(route).toContain(".is('group_id', null)")
    expect(route).toContain(".is('original_post_id', null)")
    expect(route).toContain('activeAuthorIds.has(post.author_id)')
  })

  it('excludes dissolved groups from the dynamic sitemap shard', () => {
    expect(route).toContain(".is('dissolved_at', null)")
  })

  it.each([
    [{ deleted_at: '2026-07-16T00:00:00.000Z' }, false],
    [{ banned_at: '2026-07-16T00:00:00.000Z' }, false],
    [{ is_banned: true, ban_expires_at: null }, false],
    [{ is_banned: true, ban_expires_at: '2026-07-17T00:00:00.000Z' }, false],
    [{ is_banned: true, ban_expires_at: '2026-07-15T00:00:00.000Z' }, true],
    [{ is_banned: false }, true],
  ])('maps profile account state %j to active=%s', (profile, expected) => {
    expect(isSitemapProfileActive(profile, Date.parse('2026-07-16T00:00:00.000Z'))).toBe(expected)
  })
})
