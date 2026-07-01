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
 *   # profile-page + tab-click capture (find access-gated per-uid endpoints):
 *   npx tsx scripts/ingest-capture-xhr.mts bitget_futures 'balance|transfer|asset' \
 *     --url 'https://www.bitget.com/copy-trading/futures/detail?traderId=XXX' \
 *     --click 'text=余额历史' --click 'text=Balance History' --wait 5000
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

/** Parse a repeatable `--flag value` into a string[]. */
function multiFlag(args: string[], flag: string): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) if (args[i] === flag && args[i + 1]) out.push(args[i + 1])
  return out
}
function oneFlag(args: string[], flag: string): string | null {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : null
}

async function main() {
  const args = process.argv.slice(2)
  const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))
  const slug = positional[0] ?? 'coinex_futures'
  const matcherSrc = positional[1] ?? 'copy-trading|copytrading|traders|leaderboard|public|profile|history|order|position|transfer|balance|follow'
  const matcher = new RegExp(matcherSrc, 'i')
  // --url <url>: navigate this URL (e.g. a trader profile) instead of the board.
  // --click <selector>: after load, click each (repeatable) to trigger lazy XHRs.
  // --wait <ms>: settle time after each nav/click (default 4000).
  const overrideUrl = oneFlag(args, '--url')
  const clicks = multiFlag(args, '--click')
  const settleMs = Number(oneFlag(args, '--wait') ?? '4000')

  await import('@/lib/ingest/adapters/register')
  const { getSourceBySlug } = await import('@/lib/ingest/sources')
  const { openSession } = await import('@/lib/ingest/fetch/fetcher')
  const { closeIngestPool } = await import('@/lib/ingest/db')

  const src = await getSourceBySlug(slug)
  if (!src) throw new Error(`source not found: ${slug}`)
  const targetUrl = overrideUrl ?? src.leaderboard_url
  if (!targetUrl) throw new Error(`source ${slug} has no leaderboard_url (and no --url given)`)
  console.log(`[capture] ${slug} region=${src.fetch_region} url=${targetUrl}`)
  console.log(`[capture] matcher=/${matcherSrc}/i${clicks.length ? ` clicks=${clicks.length}` : ''}`)

  const session = await openSession(src)
  try {
    const capture = await session.capture(matcher)
    const page = await session.page()
    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => {})
      await page.waitForTimeout(settleMs)
      // Click through tabs (each may lazy-load a distinct endpoint) — best-effort.
      for (const sel of clicks) {
        try {
          await page.click(sel, { timeout: 8000 })
          await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
          await page.waitForTimeout(settleMs)
          console.log(`[capture] clicked: ${sel}`)
        } catch (e) {
          console.log(`[capture] click failed (${sel}):`, (e as Error).message)
        }
      }
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
