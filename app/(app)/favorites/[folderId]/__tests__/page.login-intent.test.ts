import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const pageSource = readFileSync(
  join(process.cwd(), 'app/(app)/favorites/[folderId]/page.tsx'),
  'utf8'
)

describe('favorite folder page login intent', () => {
  it('uses the exact folder login helper for subscription auth', () => {
    expect(pageSource).toContain('router.push(buildFavoriteFolderLoginHref(folderId))')
    expect(pageSource).not.toContain("router.push('/login?redirect=/favorites')")
  })
})
