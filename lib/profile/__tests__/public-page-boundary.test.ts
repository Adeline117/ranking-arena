import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const page = readFileSync(join(process.cwd(), 'app/(app)/u/[handle]/page.tsx'), 'utf8')

describe('public profile page audience boundary', () => {
  it('re-evaluates account state instead of serving an ISR profile snapshot', () => {
    expect(page).toContain("export const dynamic = 'force-dynamic'")
    expect(page).toContain('export const revalidate = 0')
    expect(page).not.toContain('export const revalidate = 60')
  })

  it('guards metadata enrichment before using service-role profile fields', () => {
    expect(page).toContain(
      "'id, handle, avatar_url, bio, verified_trader_source, verified_trader_id, deleted_at, banned_at, is_banned, ban_expires_at'"
    )
    const audienceCheck = page.indexOf(
      'const publicData = data && isPublicProfileActive(data) ? data : null'
    )
    const avatarRead = page.indexOf('avatarUrl = publicData?.avatar_url || null')
    const traderRead = page.indexOf(
      'if (publicData?.verified_trader_source && publicData?.verified_trader_id)'
    )
    expect(audienceCheck).toBeGreaterThan(-1)
    expect(avatarRead).toBeGreaterThan(audienceCheck)
    expect(traderRead).toBeGreaterThan(audienceCheck)
  })

  it('excludes inactive accounts from static candidates and server profile hydration', () => {
    expect(page).toContain(
      ".select('id, handle, deleted_at, banned_at, is_banned, ban_expires_at')"
    )
    expect(page).toContain("typeof u.handle === 'string' && isPublicProfileActive(u)")
    expect(page).toContain(
      "'id, handle, bio, avatar_url, cover_url, show_followers, show_following, subscription_tier, show_pro_badge, role, follower_count, following_count, created_at, deleted_at, banned_at, is_banned, ban_expires_at'"
    )

    const profileChoice = page.indexOf(
      'const userProfile = handleResult.data || handleIlikeResult.data || uuidResult.data'
    )
    const audienceCheck = page.indexOf(
      'if (!userProfile || !isPublicProfileActive(userProfile)) return null'
    )
    const enrichment = page.indexOf('// Parallel: fetch counts + pro badge')
    expect(profileChoice).toBeGreaterThan(-1)
    expect(audienceCheck).toBeGreaterThan(profileChoice)
    expect(enrichment).toBeGreaterThan(audienceCheck)
  })

  it('keeps both established rendering clients in place', () => {
    expect(page).toContain('<TraderProfileClient')
    expect(page).toContain(
      '<UserProfileClient handle={handle} serverProfile={profile} serverTraderData={traderData} />'
    )
  })
})
