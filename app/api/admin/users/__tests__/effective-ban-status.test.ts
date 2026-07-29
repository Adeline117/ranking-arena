import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const route = readFileSync(resolve(process.cwd(), 'app/api/admin/users/route.ts'), 'utf8')
const hook = readFileSync(resolve(process.cwd(), 'app/(app)/admin/hooks/useUsers.ts'), 'utf8')
const component = readFileSync(
  resolve(process.cwd(), 'app/(app)/admin/components/UserManagementTab.tsx'),
  'utf8'
)

describe('administrator effective ban status', () => {
  it('selects and returns both current and legacy status representations', () => {
    expect(route).toContain('banned_at, banned_reason, banned_by, is_banned, ban_expires_at')
    expect(route).toContain('is_effectively_banned: isProfileBanned(')
  })

  it('filters banned and active pages with the same expiry semantics as admission', () => {
    expect(route).toContain('banned_at.not.is.null')
    expect(route).toContain('and(is_banned.eq.true,ban_expires_at.is.null)')
    expect(route).toContain('and(is_banned.eq.true,ban_expires_at.gt.${statusBoundary})')
    expect(route).toContain(".is('banned_at', null)")
    expect(route).toContain('is_banned.eq.false')
    expect(route).toContain('and(is_banned.eq.true,ban_expires_at.lte.${statusBoundary})')
  })

  it('renders and optimistically updates actions from effective status', () => {
    expect(component.match(/user\.is_effectively_banned/g)).toHaveLength(2)
    expect(component).not.toMatch(/user\.banned_at\s*\?/)
    expect(hook).toContain('is_effectively_banned: true')
    expect(hook).toContain('is_effectively_banned: false')
    expect(hook).toContain('is_banned: true')
    expect(hook).toContain('is_banned: false')
  })
})
