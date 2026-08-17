import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(process.cwd(), 'lib/data/posts-weighted.ts'), 'utf8')

describe('weighted post search publication fence', () => {
  it('does not call the legacy raw content RPC and filters every direct candidate', () => {
    expect(source).not.toContain("rpc('search_posts_with_weight'")
    expect(source).toContain(
      "import { ARENA_BOT_AUTHOR_ID } from '@/lib/data/arena-bot-publication-policy'"
    )
    expect(source).toContain(".neq('author_id', ARENA_BOT_AUTHOR_ID)")
    expect(source).toContain(".neq('status', 'deleted')")
    expect(source).toContain(".is('deleted_at', null)")
    expect(source).toContain(
      'return filterServiceReadablePostRows(supabase, (data ?? []) as PostWithAuthor[])'
    )
  })
})
