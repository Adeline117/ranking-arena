import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(join(process.cwd(), 'app/api/cron/flash-news-fetch/route.ts'), 'utf8')

describe('flash-news ingest safety contract', () => {
  it('propagates one bounded work signal to network and database operations', () => {
    expect(route).toContain('const WORK_TIMEOUT_MS = 45_000')
    expect(route).toContain('AbortSignal.any([signal, AbortSignal.timeout(FEED_TIMEOUT_MS)])')
    expect(route).toContain("translateText(item.title, tl, 'en', TRANSLATE_TIMEOUT_MS, signal)")
    expect(route.match(/\.abortSignal\(workSignal\)/g)).toHaveLength(2)
    expect(route).toContain('{ safetyTimeoutMs: 55_000 }')
  })

  it('fails closed when feeds, deduplication, or insert acknowledgement fail', () => {
    expect(route).toContain("throw new Error('All flash-news RSS feeds failed')")
    expect(route).toContain('existingError || !Array.isArray(existing)')
    expect(route).toContain('insertError || !Array.isArray(inserted)')
    expect(route).toContain('RSS gateway returned HTTP')
    expect(route).toContain('RSS gateway returned an invalid payload')
    expect(route).toContain('RSS gateway returned invalid items')
  })

  it('deduplicates the batch and caps translation work before persistence', () => {
    expect(route).toContain('const MAX_ITEMS_PER_RUN = 24')
    expect(route).toContain('seenTitles.add(title)')
    expect(route).toContain('newItems.slice(0, MAX_ITEMS_PER_RUN)')
    expect(route).toContain('signal.throwIfAborted()')
  })
})
