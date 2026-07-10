/**
 * First-party sync processor (认领交易员 P1, spec: docs/plans typed-sleeping-meadow).
 *
 * For one ACTIVE trader_authorizations row: decrypt the trader's read-only
 * key, pull their own account via CCXT (lib/ingest/first-party/fetch),
 * compute 7/30/90 stats + series (engine), publish through the SAME
 * publishProfile path the scraper uses (validation included), append one
 * arena.first_party_snapshots row, and stamp sync status back on the
 * authorization. The score_inputs view's first-party branch picks the rows up
 * (provenance='first_party', <48h) with zero compute-leaderboard changes.
 *
 * Failure policy: consecutive_failures increments per failed run; at 3 the
 * authorization flips to status='error' (app-side notifies the user). The
 * view's freshness window then degrades the trader to board data — the row
 * never vanishes.
 */

import type { Job } from 'bullmq'
import { getIngestPool } from '@/lib/ingest/db'
import { getSourceBySlug } from '@/lib/ingest/sources'
import { publishProfile } from '@/lib/ingest/serving/publish'
import { validateStats } from '@/lib/ingest/staging/validate'
import { computeFirstParty, type EquitySnapshotRow } from '@/lib/ingest/first-party/engine'
import { fetchFirstPartyAccount, type CcxtLike } from '@/lib/ingest/first-party/fetch'
import {
  CCXT_ID,
  GEO_BLOCKED,
  PASSPHRASE_REQUIRED,
  makeProxyFetch,
} from '@/lib/portfolio/exchange-sync'
import { decrypt } from '@/lib/crypto/encryption'

export interface FirstPartyJobData {
  authorizationId: string
}

interface AuthRow {
  id: string
  user_id: string
  platform: string
  trader_id: string
  encrypted_api_key: string
  encrypted_api_secret: string
  encrypted_passphrase: string | null
  status: string
  last_sync_at: string | null
  consecutive_failures: number
}

async function markSync(
  authId: string,
  ok: boolean,
  detail: string,
  priorFailures: number,
  ctx?: { userId: string; platform: string; traderId: string }
): Promise<void> {
  const failures = ok ? 0 : priorFailures + 1
  const status = ok ? 'active' : failures >= 3 ? 'error' : 'active'
  await getIngestPool().query(
    `UPDATE public.trader_authorizations
        SET last_sync_at = now(), last_sync_status = $2,
            consecutive_failures = $3, status = $4
      WHERE id = $1`,
    [authId, detail.slice(0, 200), failures, status]
  )
  // 连挂 3 次转 error 的瞬间通知用户换 key(E2E 干跑 2026-07-10 发现的缺口)。
  // worker=批处理语境,按 CLAUDE.md 通知铁律允许直插;ON CONFLICT 无约束可依,
  // 用 reference_id 幂等判重(同一授权只发一次,直到恢复 active 再挂才重发)。
  if (!ok && failures === 3 && ctx) {
    try {
      await getIngestPool().query(
        `INSERT INTO public.notifications (user_id, type, title, message, reference_id)
         SELECT $1, 'system', 'Exchange connection needs attention',
                $2, $3
          WHERE NOT EXISTS (
            SELECT 1 FROM public.notifications
             WHERE user_id = $1 AND reference_id = $3
               AND created_at > now() - interval '7 days')`,
        [
          ctx.userId,
          `Syncing your ${ctx.platform} account (${ctx.traderId.slice(0, 12)}…) failed 3 times — your rankings fall back to exchange board data. Please re-verify or rotate your API key in Settings.`,
          `fp-error-${authId}`,
        ]
      )
    } catch (err) {
      console.warn(
        '[first-party] error-notification insert failed (non-fatal):',
        err instanceof Error ? err.message : err
      )
    }
  }
}

export interface FirstPartySyncResult {
  ok: boolean
  statsWritten: number
  seriesPoints: number
  detail: string
}

export async function processFirstPartySync(
  job: Job<FirstPartyJobData>
): Promise<FirstPartySyncResult> {
  const pool = getIngestPool()
  const { rows: auths } = await pool.query<AuthRow>(
    `SELECT id, user_id, platform, trader_id, encrypted_api_key, encrypted_api_secret,
            encrypted_passphrase, status, last_sync_at, consecutive_failures
       FROM public.trader_authorizations WHERE id = $1`,
    [job.data.authorizationId]
  )
  const auth = auths[0]
  if (!auth) return { ok: false, statsWritten: 0, seriesPoints: 0, detail: 'authorization missing' }
  if (auth.status !== 'active') {
    return { ok: false, statsWritten: 0, seriesPoints: 0, detail: `status=${auth.status}` }
  }

  // Resolve the arena source + trader (activateClaim's arena_set_trader_claimed
  // upserted the trader row; platform may be a serving name = legacy_platform).
  const { rows: srcRows } = await pool.query<{ slug: string }>(
    `SELECT slug FROM arena.sources
      WHERE slug = $1 OR meta->>'legacy_platform' = $1
      LIMIT 1`,
    [auth.platform]
  )
  if (!srcRows[0]) {
    await markSync(auth.id, false, `unknown platform ${auth.platform}`, auth.consecutive_failures)
    return { ok: false, statsWritten: 0, seriesPoints: 0, detail: `unknown platform` }
  }
  const src = await getSourceBySlug(srcRows[0].slug)
  const { rows: traderRows } = await pool.query<{ id: number }>(
    `SELECT id FROM arena.traders WHERE source_id = $1 AND exchange_trader_id = $2`,
    [src.id, auth.trader_id]
  )
  if (!traderRows[0]) {
    await markSync(
      auth.id,
      false,
      'arena trader missing (claim not activated?)',
      auth.consecutive_failures
    )
    return { ok: false, statsWritten: 0, seriesPoints: 0, detail: 'arena trader missing' }
  }
  const traderId = traderRows[0].id

  try {
    // ── CCXT client (mirrors lib/portfolio/exchange-sync construction) ──
    const ex = auth.platform.toLowerCase()
    const ccxtId = CCXT_ID[ex]
    if (!ccxtId) throw new Error(`unsupported exchange ${ex}`)
    const proxyFetch = GEO_BLOCKED.has(ex) ? makeProxyFetch() : null
    if (GEO_BLOCKED.has(ex) && !proxyFetch) throw new Error('geo proxy unavailable')
    if (PASSPHRASE_REQUIRED.has(ex) && !auth.encrypted_passphrase) {
      throw new Error('passphrase required')
    }
    const apiKey = decrypt(auth.encrypted_api_key)
    const apiSecret = decrypt(auth.encrypted_api_secret)
    const passphrase = auth.encrypted_passphrase ? decrypt(auth.encrypted_passphrase) : undefined

    const mod = await import('ccxt')
    const registry = ((mod as { default?: unknown }).default ?? mod) as Record<
      string,
      new (cfg: Record<string, unknown>) => CcxtLike
    >
    const ExClass = registry[ccxtId]
    if (!ExClass) throw new Error(`ccxt class missing for ${ccxtId}`)
    const client = new ExClass({
      apiKey,
      secret: apiSecret,
      ...(passphrase ? { password: passphrase } : {}),
      ...(proxyFetch ? { fetchImplementation: proxyFetch } : {}),
      enableRateLimit: true,
      timeout: 15_000,
      options: { defaultType: 'swap' },
    })

    // ── Prior snapshots (ROI denominator / MDD path) ──
    const { rows: snapRows } = await pool.query<EquitySnapshotRow>(
      `SELECT ts::text AS ts, equity::float8 AS equity, net_transfer_cum::float8 AS net_transfer_cum
         FROM arena.first_party_snapshots
        WHERE trader_id = $1 AND ts > now() - interval '91 days'
        ORDER BY ts ASC`,
      [traderId]
    )

    const nowMs = Date.now()
    const account = await fetchFirstPartyAccount(client, {
      nowMs,
      lookbackDays: 90,
      lastSyncMs: auth.last_sync_at ? Date.parse(auth.last_sync_at) : null,
    })
    const result = computeFirstParty({ ...account, snapshots: snapRows })

    // ── Persist via the scraping pipeline's own write path (validation incl.) ──
    const { valid, rejects } = validateStats(result.stats, [])
    await publishProfile(
      src,
      traderId,
      {
        stats: valid,
        series: result.series as never,
        nickname: null,
        avatarUrlOrigin: null,
      },
      { fullSeries: true }
    )
    await pool.query(
      `INSERT INTO arena.first_party_snapshots
         (trader_id, ts, equity, balance, unrealized_pnl, net_transfer_cum, currency)
       VALUES ($1, now(), $2, $3, $4, $5, $6)
       ON CONFLICT (trader_id, ts) DO NOTHING`,
      [
        traderId,
        result.snapshot.equity,
        result.snapshot.balance,
        result.snapshot.unrealizedPnl,
        result.snapshot.netTransferCum,
        result.snapshot.currency,
      ]
    )

    const seriesPoints = result.series.reduce((n, s) => n + s.points.length, 0)
    await markSync(auth.id, true, `ok stats=${valid.length} rejects=${rejects.length}`, 0)
    console.log(
      `[first-party] ${auth.platform}/${auth.trader_id}: stats=${valid.length} series_pts=${seriesPoints} equity=${result.snapshot.equity}`
    )
    return { ok: true, statsWritten: valid.length, seriesPoints, detail: 'ok' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await markSync(auth.id, false, msg, auth.consecutive_failures, {
      userId: auth.user_id,
      platform: auth.platform,
      traderId: auth.trader_id,
    })
    console.warn(`[first-party] ${auth.platform}/${auth.trader_id} failed: ${msg}`)
    return { ok: false, statsWritten: 0, seriesPoints: 0, detail: msg }
  }
}
