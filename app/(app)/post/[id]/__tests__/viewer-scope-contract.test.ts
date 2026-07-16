import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('post detail viewer scope contract', () => {
  it('keeps metadata anonymous but resolves the page body for the current viewer', () => {
    const source = readFileSync(join(process.cwd(), 'app/(app)/post/[id]/page.tsx'), 'utf8')

    expect(source).toContain("export const dynamic = 'force-dynamic'")
    expect(source).toContain('const getPublicPost = cache')
    expect(source).toContain('getPostById(getSupabaseAdmin(), id, null)')
    expect(source).toContain('await authClient.auth.getUser()')
    expect(source).toContain('getPostById(getSupabaseAdmin(), id, user.id)')
    expect(source).not.toContain('const getPost = cache')
  })
})
