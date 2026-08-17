import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sitemap = readFileSync(join(process.cwd(), 'app/sitemap.ts'), 'utf8')

describe('metadata sitemap post publication fence', () => {
  it('does not let its service-role bulk query advertise the legacy bot UUID', () => {
    expect(sitemap).toContain(
      "import { ARENA_BOT_AUTHOR_ID } from '@/lib/data/arena-bot-publication-policy'"
    )
    expect(sitemap).toContain(".neq('author_id', ARENA_BOT_AUTHOR_ID)")
    expect(sitemap).toContain(".is('deleted_at', null)")
    expect(sitemap).toContain(".is('original_post_id', null)")
  })
})
