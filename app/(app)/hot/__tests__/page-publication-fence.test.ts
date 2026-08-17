import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const page = readFileSync(join(process.cwd(), 'app/(app)/hot/page.tsx'), 'utf8')

describe('hot page legacy bot publication fence', () => {
  it('uses a fresh ISR cache key and canonical service audience filter', () => {
    expect(page).toContain(
      "import { ARENA_BOT_PUBLICATION_CACHE_EPOCH } from '@/lib/data/arena-bot-publication-policy'"
    )
    expect(page).toContain("['hot-posts', ARENA_BOT_PUBLICATION_CACHE_EPOCH]")
    expect(page).toContain('filterServiceReadablePostRows(supabase, data, null)')
    expect(page).toContain("tags: ['posts']")
  })
})
