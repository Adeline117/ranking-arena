import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const page = readFileSync(join(process.cwd(), 'app/(app)/groups/page.tsx'), 'utf8')

describe('groups page legacy bot publication fence', () => {
  it('uses a fresh ISR cache key for recommended post payloads', () => {
    expect(page).toContain(
      "import { ARENA_BOT_PUBLICATION_CACHE_EPOCH } from '@/lib/data/arena-bot-publication-policy'"
    )
    expect(page).toContain("['groups-recommended-posts', ARENA_BOT_PUBLICATION_CACHE_EPOCH]")
    expect(page).toContain('return await getPosts(supabase, {')
    expect(page).toContain("tags: ['posts']")
  })
})
