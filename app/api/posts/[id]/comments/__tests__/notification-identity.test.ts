import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(join(process.cwd(), 'app/api/posts/[id]/comments/route.ts'), 'utf8')

describe('comment notification identity', () => {
  it('binds comment and reply notifications to the committed comment event', () => {
    expect(route.match(/reference_id: comment\.id/g)).toHaveLength(2)
    expect(route).not.toMatch(/reference_id:\s*id[,\n]/)
    expect(route.indexOf('comment = await createComment')).toBeLessThan(
      route.indexOf('reference_id: comment.id')
    )
  })
})
