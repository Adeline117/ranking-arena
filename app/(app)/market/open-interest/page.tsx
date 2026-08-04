import { Metadata } from 'next'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import OpenInterestClient from './OpenInterestClient'
import { BASE_URL } from '@/lib/constants/urls'
import { createLogger } from '@/lib/utils/logger'
import { createBudget, withTimeout } from '@/lib/utils/timeout'
import {
  dedupeLatestOpenInterest,
  hasUniqueOpenInterestIdentities,
  readOpenInterestRows,
  type OpenInterestRow,
} from './open-interest-data'

const logger = createLogger('open-interest')

export const metadata: Metadata = {
  title: 'Open Interest',
  description:
    'Real-time open interest data across Binance, Bybit, OKX, and Bitget. Track total outstanding futures positions and market depth.',
  alternates: {
    canonical: `${BASE_URL}/market/open-interest`,
  },
  openGraph: {
    title: 'Open Interest',
    description: 'Real-time open interest data across major crypto exchanges.',
    url: `${BASE_URL}/market/open-interest`,
    siteName: 'Arena',
    type: 'website',
    images: [
      { url: `${BASE_URL}/og-image.png`, width: 1200, height: 630, alt: 'Arena Open Interest' },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Open Interest',
    description: 'Real-time open interest data across major crypto exchanges.',
    images: [`${BASE_URL}/og-image.png`],
  },
}

// ISR: open-interest data is request-independent (single RPC, no cookies/headers/
// searchParams) and refreshes on a ~15-min cron, so it's an ideal cache candidate.
// force-dynamic previously opted the route out of the Full Route Cache entirely,
// making revalidate dead and forcing a Supabase RPC on EVERY visit. Removed so
// revalidate actually takes effect and the DB hit leaves the hot path.
export const revalidate = 900 // 15 minutes

interface OpenInterestLoadResult {
  rows: OpenInterestRow[]
  loadError: boolean
  degraded: boolean
}

export const OPEN_INTEREST_TOTAL_TIMEOUT_MS = 4_000
const OPEN_INTEREST_RPC_TIMEOUT_MS = 1_750

type AbortableQuery<T> = PromiseLike<T> & {
  abortSignal?: (signal: AbortSignal) => PromiseLike<T>
}

async function settleOpenInterestQuery<T>(
  query: AbortableQuery<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  const controller = new AbortController()
  const pending =
    typeof query.abortSignal === 'function'
      ? Promise.resolve(query.abortSignal(controller.signal))
      : Promise.resolve(query)
  try {
    return await withTimeout(pending, timeoutMs, label)
  } finally {
    controller.abort()
  }
}

async function getOpenInterest(): Promise<OpenInterestLoadResult> {
  const supabase = getSupabaseAdmin()
  const budget = createBudget(OPEN_INTEREST_TOTAL_TIMEOUT_MS)

  // Use DB-side deduplication via RPC (DISTINCT ON is far more efficient)
  try {
    const { data, error } = await settleOpenInterestQuery(
      supabase.rpc('get_latest_open_interest'),
      Math.min(OPEN_INTEREST_RPC_TIMEOUT_MS, budget.remaining()),
      'latest open interest RPC'
    )
    const rows = !error ? readOpenInterestRows(data) : null
    if (rows && hasUniqueOpenInterestIdentities(rows)) {
      return { rows, loadError: false, degraded: false }
    }
  } catch {
    // RPC not available, fall back to client-side dedup
  }

  try {
    // Fallback: fetch and deduplicate in memory
    const fallbackQuery = supabase
      .from('open_interest')
      .select('platform, symbol, open_interest_usd, open_interest_contracts, timestamp')
      .order('timestamp', { ascending: false })
      .limit(500)
    const { data, error } = await settleOpenInterestQuery(
      fallbackQuery,
      budget.remaining(),
      'open interest fallback'
    )

    if (error) {
      logger.error('[open-interest] fetch error:', error.message)
      return { rows: [], loadError: true, degraded: false }
    }

    const rows = readOpenInterestRows(data)
    if (!rows) {
      logger.error('[open-interest] fetch error:', 'invalid open interest response')
      return { rows: [], loadError: true, degraded: false }
    }
    return {
      rows: dedupeLatestOpenInterest(rows),
      loadError: false,
      degraded: true,
    }
  } catch (error) {
    logger.error('[open-interest] unexpected fetch error:', error)
    return { rows: [], loadError: true, degraded: false }
  }
}

export default async function OpenInterestPage() {
  const { rows, loadError, degraded } = await getOpenInterest()

  return (
    <OpenInterestClient
      rows={rows}
      loadError={loadError}
      degraded={degraded}
      observedAt={new Date().toISOString()}
    />
  )
}
