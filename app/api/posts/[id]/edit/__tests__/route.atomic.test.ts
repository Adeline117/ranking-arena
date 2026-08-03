import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const editRoute = readFileSync(resolve(process.cwd(), 'app/api/posts/[id]/edit/route.ts'), 'utf8')
const canonicalRoute = readFileSync(resolve(process.cwd(), 'app/api/posts/[id]/route.ts'), 'utf8')

describe('post edit route convergence', () => {
  it('routes both public PUT surfaces through one atomic authority', () => {
    for (const source of [editRoute, canonicalRoute]) {
      expect(source).toContain("from '@/lib/posts/post-edit-server'")
      expect(source).toContain('handleAtomicPostEditHttp({')
      expect(source).not.toMatch(/\.from\(['"]posts['"]\)[\s\S]*?\.update\(/)
      expect(source).not.toContain('updatePost(')
    }
  })

  it('keeps each legacy success envelope explicit while sharing semantics', () => {
    expect(editRoute).toContain("envelope: 'direct'")
    expect(canonicalRoute).toContain("envelope: 'standard'")
  })
})
