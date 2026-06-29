/**
 * Live XHR capture harness — observe what JSON endpoints a source's board page
 * actually fires, to re-discover an endpoint/params that drifted upstream.
 *
 * Why: when a tier-A board returns HTTP 200 but 0 rows (e.g. coinex 2026-06-29),
 * the hardcoded `buildRequest` params no longer match what the live SPA sends.
 * This opens the REAL session (same region/egress as the worker, via openSession)
 * with request interception on, navigates the board page, and prints every
 * captured XHR's URL + params + response row count + headers — so you can diff
 * the live request against the adapter's `buildRequest`.
 *
 * Usage (from project root):
 *   npx tsx scripts/ingest-capture-xhr.mts coinex_futures
 *   npx tsx scripts/ingest-capture-xhr.mts coinex_futures '/copy-trading|traders'
 *   # Run on the SG VPS too (INGEST_LOCAL_REGION=vps_sg ...) to isolate geo.
 *
 * Read-only: never writes to the DB or serving layer.
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config({ path: resolve(process.cwd(), 'worker', '.env') })
config({ path: resolve(process.cwd(), '.env.local') })

function rowCountOf(payload: unknown): number | null {
  const root = (payload ?? {}) as Record<string, unknown>
  const d = (root.data ?? root) as Record<string, unknown>
  const inner = (d?.data ?? d) as unknown
  if (Array.isArray(inner)) return inner.length
  if (Array.isArray(d?.records)) return (d.records as unknown[]).length
  return null
}

async function main() {
  const args = process.argv.slice(2)
  const slug = args.find((a) => !a.startsWith('--')) ?? 'coinex_futures'
  const matcherSrc = args[1] && !args[1].startsWith('--') ? args[1] : 'copy-trading|copytrading|traders|leaderboard|public'
  const matcher = new RegExp(matcherSrc, 'i')

  await import('@/lib/ingest/adapters/register')
  const { getSourceBySlug } = await import('@/lib/ingest/sources')
  const { openSession } = await import('@/lib/ingest/fetch/fetcher')
  const { closeIngestPool } = await import('@/lib/ingest/db')

  const src = await getSourceBySlug(slug)
  if (!src) throw new Error(`source not found: ${slug}`)
  const boardUrl = src.leaderboard_url
  if (!boardUrl) throw new Error(`source ${slug} has no leaderboard_url`)
  console.log(`[capture] ${slug} region=${src.fetch_region} board=${boardUrl}`)
  console.log(`[capture] matcher=/${matcherSrc}/i`)

  const session = await openSession(src)
  try {
    const capture = await session.capture(matcher)
    const page = await session.page()
    try {
      await page.goto(boardUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => {})
      await page.waitForTimeout(4000)
    } catch (e) {
      console.log('[capture] goto note:', (e as Error).message)
    }
    console.log(`[capture] final URL: ${page.url()}`)

    const seen = capture.all()
    console.log(`[capture] ${seen.length} matching XHR(s):`)
    for (const ex of seen) {
      const t = ex.template
      console.log(
        JSON.stringify({
          url: t.url,
          status: ex.status,
          rows: rowCountOf(ex.responseJson),
          headers: t.headers,
        })
      )
    }
    if (seen.length === 0) {
      console.log('[capture] NO matching XHR — the board may render via SSR, a websocket, a different host, or the page redirected (check final URL above).')
    }
    capture.dispose()
  } finally {
    await session.close()
    await closeIngestPool().catch(() => {})
  }
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
