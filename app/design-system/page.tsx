import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import LeaderboardRedesignPreview from './LeaderboardRedesignPreview'

export const metadata: Metadata = {
  title: 'Design System — Leaderboard Redesign Prototype',
  robots: { index: false, follow: false },
}

// Render per-request so the prod gate below runs at runtime, not at build-time
// static prerender (where it would be baked wrong / never re-evaluated).
export const dynamic = 'force-dynamic'

/** Production hostnames — the prototype is 404'd only on these. */
const PROD_HOSTS = new Set(['arenafi.org', 'www.arenafi.org'])

/**
 * Internal design-system sandbox. Hosts visual prototypes for review before
 * porting winning ideas into live components. Not linked from navigation.
 *
 * U12-10: noindex alone left this internal prototype publicly reachable in
 * production. Hard-404 it on the production DOMAIN only — gate on the Host
 * header, NOT process.env.VERCEL_ENV (this project has system-env injection
 * disabled, so VERCEL_ENV is undefined at runtime — verified live). Preview
 * (*.vercel.app) and localhost still open it for design review.
 */
export default async function DesignSystemPage() {
  const host = (await headers()).get('host')?.split(':')[0].toLowerCase() ?? ''
  if (PROD_HOSTS.has(host)) notFound()

  return (
    <main style={{ minHeight: '100vh', background: 'var(--color-bg-primary)' }}>
      <LeaderboardRedesignPreview />
    </main>
  )
}
