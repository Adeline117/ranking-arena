/**
 * First-party sync processor (认领交易员 P1, spec: docs/plans typed-sleeping-meadow).
 *
 * Legacy-compatible public first-party processor. An ACTIVE authorization is
 * not sufficient: before decrypting anything, the processor requires an exact
 * reviewed V2 API-key claim plus matching verified/link/Arena ownership
 * projections. Arena V1 creates wallet-signature claims only, so ordinary CEX
 * account connections cannot enter this publication path. This guard remains
 * here so queued jobs from an immutable older deployment fail closed.
 *
 * Failure policy: consecutive_failures increments per failed run; at 3 the
 * authorization flips to status='error' (app-side notifies the user). The
 * view's freshness window then degrades a previously reviewed trader to board
 * data — the row never vanishes.
 */

import type { Job } from 'bullmq'
import { getIngestPool, ingestClientConnect } from '@/lib/ingest/db'
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
} from '@/lib/exchange/ccxt-read-transport'
import { decryptAuthorizationCredential } from '@/lib/exchange/authorization-credentials'
import { accountConnectionExchangeForSource } from '@/lib/constants/trader-claim-platforms'

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
  updated_at: string | null
}

async function markSync(
  auth: AuthRow,
  ok: boolean,
  detail: string,
  ctx?: { userId: string; platform: string; traderId: string }
): Promise<boolean> {
  const canonicalExchange = accountConnectionExchangeForSource(auth.platform)
  if (!canonicalExchange) return false

  // Every account mutation uses the same global order as bind/revoke:
  // advisory lifecycle key -> connection row -> authorization row. Updating
  // the authorization first would let a trigger or concurrent revoke form an
  // auth->connection / connection->auth deadlock cycle.
  const client = await ingestClientConnect()
  let transactionOpen = false
  let updated:
    | {
        consecutive_failures: number
        status: string
      }
    | undefined
  try {
    await client.query('BEGIN')
    transactionOpen = true
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `trader-account:${auth.user_id}:${canonicalExchange}`,
    ])
    const { rows: connections } = await client.query<{ id: string }>(
      `SELECT id
         FROM public.user_exchange_connections
        WHERE user_id = $1
          AND exchange = $2
          AND verified_uid = $3
          AND is_active IS TRUE
        FOR KEY SHARE`,
      [auth.user_id, canonicalExchange, auth.trader_id]
    )
    if (!connections[0]) {
      await client.query('ROLLBACK')
      transactionOpen = false
      return false
    }

    const { rows } = await client.query<{
      consecutive_failures: number
      status: string
    }>(
      `UPDATE public.trader_authorizations
        SET last_sync_at = now(), last_sync_status = $2,
            consecutive_failures = CASE
              WHEN $2 = 'success' THEN 0
              ELSE consecutive_failures + 1
            END,
            status = CASE
              WHEN $2 = 'error' AND consecutive_failures + 1 >= 3
                THEN 'suspended'
              ELSE status
            END,
            verification_error = CASE WHEN $2 = 'success' THEN NULL ELSE $3 END
      WHERE id = $1
        AND status = 'active'
        AND user_id = $4
        AND platform = $5
        AND trader_id = $6
        AND encrypted_api_key = $7
        AND encrypted_api_secret = $8
        AND encrypted_passphrase IS NOT DISTINCT FROM $9
        AND updated_at IS NOT DISTINCT FROM $10::timestamptz
      RETURNING consecutive_failures, status`,
      [
        auth.id,
        ok ? 'success' : 'error',
        detail.slice(0, 200),
        auth.user_id,
        auth.platform,
        auth.trader_id,
        auth.encrypted_api_key,
        auth.encrypted_api_secret,
        auth.encrypted_passphrase,
        auth.updated_at,
      ]
    )
    updated = rows[0]
    await client.query('COMMIT')
    transactionOpen = false
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // Preserve the lifecycle update error.
      }
    }
    throw error
  } finally {
    client.release()
  }

  if (!updated) return false

  // 连挂 3 次转 error 的瞬间通知用户换 key(E2E 干跑 2026-07-10 发现的缺口)。
  // worker=批处理语境,按 CLAUDE.md 通知铁律允许直插;ON CONFLICT 无约束可依,
  // 用 reference_id 幂等判重(同一授权只发一次,直到恢复 active 再挂才重发)。
  if (!ok && updated.consecutive_failures === 3 && updated.status === 'suspended' && ctx) {
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
          `fp-error-${auth.id}`,
        ]
      )
    } catch (err) {
      console.warn(
        '[first-party] error-notification insert failed (non-fatal):',
        err instanceof Error ? err.message : err
      )
    }
  }
  return true
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
            encrypted_passphrase, status, last_sync_at, consecutive_failures,
            updated_at::text AS updated_at
       FROM public.trader_authorizations WHERE id = $1`,
    [job.data.authorizationId]
  )
  const auth = auths[0]
  if (!auth) return { ok: false, statsWritten: 0, seriesPoints: 0, detail: 'authorization missing' }
  if (auth.status !== 'active') {
    return { ok: false, statsWritten: 0, seriesPoints: 0, detail: `status=${auth.status}` }
  }

  // V1 CEX credentials are account connections, not public-profile proof. A
  // queued job may publish only when every reviewed owner projection agrees on
  // the exact source/trader identity. Typed V2 currently supports wallet
  // claims only, so ordinary CEX connections deliberately return no row here.
  const { rows: approvedMappings } = await pool.query<{
    slug: string
    trader_id: number
  }>(
    `SELECT source_row.slug, arena_trader.id AS trader_id
       FROM public.verified_traders AS verified
       JOIN public.user_linked_traders AS linked
         ON linked.user_id = verified.user_id
        AND linked.source = verified.source
        AND linked.trader_id = verified.trader_id
       JOIN public.trader_claims AS claim
         ON claim.user_id = verified.user_id
        AND claim.source = verified.source
        AND claim.trader_id = verified.trader_id
        AND claim.status = 'verified'
        AND claim.submission_version = 2
        AND claim.verification_method = 'api_key'
       JOIN arena.sources AS source_row
         ON source_row.slug = verified.source
         OR source_row.meta->>'legacy_platform' = verified.source
       JOIN arena.traders AS arena_trader
         ON arena_trader.source_id = source_row.id
        AND arena_trader.exchange_trader_id = verified.trader_id
      WHERE verified.user_id = $1
        AND verified.source = $2
        AND verified.trader_id = $3
        AND verified.verification_method = 'api_key'
        AND linked.verification_method = 'api_key'
        AND arena_trader.meta->>'claimed' = 'true'
        AND arena_trader.meta->>'claimed_by_user_id' = $1::text
      ORDER BY arena_trader.id
      LIMIT 1`,
    [auth.user_id, auth.platform, auth.trader_id]
  )
  if (!approvedMappings[0]) {
    return {
      ok: false,
      statsWritten: 0,
      seriesPoints: 0,
      detail: 'public first-party publishing is not approved for this account',
    }
  }

  const src = await getSourceBySlug(approvedMappings[0].slug)
  const traderId = approvedMappings[0].trader_id
  const canonicalExchange = accountConnectionExchangeForSource(auth.platform)
  if (!canonicalExchange) {
    await markSync(auth, false, `unsupported exchange ${auth.platform}`)
    return { ok: false, statsWritten: 0, seriesPoints: 0, detail: 'unsupported exchange' }
  }

  try {
    // ── CCXT client (guarded read transport; no legacy portfolio entry point) ──
    const ex = canonicalExchange
    const ccxtId = CCXT_ID[ex]
    if (!ccxtId) throw new Error(`unsupported exchange ${ex}`)
    const proxyFetch = GEO_BLOCKED.has(ex) ? makeProxyFetch() : null
    if (GEO_BLOCKED.has(ex) && !proxyFetch) throw new Error('geo proxy unavailable')
    if (PASSPHRASE_REQUIRED.has(ex) && !auth.encrypted_passphrase) {
      throw new Error('passphrase required')
    }
    const apiKey = decryptAuthorizationCredential(auth.encrypted_api_key)
    const apiSecret = decryptAuthorizationCredential(auth.encrypted_api_secret)
    const passphrase = auth.encrypted_passphrase
      ? decryptAuthorizationCredential(auth.encrypted_passphrase)
      : undefined

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
    // Fetching from an exchange is intentionally outside the database lock.
    // Immediately before publishing, fence against revoke and same-row key
    // rotation with the account lifecycle advisory key and a full generation
    // recheck. Hold the lock until profile + snapshot publication finishes.
    const { valid, rejects } = validateStats(result.stats, [])
    const guard = await ingestClientConnect()
    let transactionOpen = false
    try {
      await guard.query('BEGIN')
      transactionOpen = true
      await guard.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `trader-account:${auth.user_id}:${canonicalExchange}`,
      ])
      const { rows: currentGeneration } = await guard.query<{ id: string }>(
        `SELECT id
           FROM public.trader_authorizations
          WHERE id = $1
            AND status = 'active'
            AND user_id = $2
            AND platform = $3
            AND trader_id = $4
            AND encrypted_api_key = $5
            AND encrypted_api_secret = $6
            AND encrypted_passphrase IS NOT DISTINCT FROM $7
            AND updated_at IS NOT DISTINCT FROM $8::timestamptz
          FOR UPDATE`,
        [
          auth.id,
          auth.user_id,
          auth.platform,
          auth.trader_id,
          auth.encrypted_api_key,
          auth.encrypted_api_secret,
          auth.encrypted_passphrase,
          auth.updated_at,
        ]
      )
      if (!currentGeneration[0]) {
        await guard.query('ROLLBACK')
        transactionOpen = false
        return {
          ok: false,
          statsWritten: 0,
          seriesPoints: 0,
          detail: 'authorization revoked or rotated during sync',
        }
      }

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
      await guard.query(
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
      await guard.query('COMMIT')
      transactionOpen = false
    } catch (error) {
      if (transactionOpen) {
        try {
          await guard.query('ROLLBACK')
        } catch {
          // Preserve the publication error; the connection helper will release
          // the broken client after this best-effort rollback.
        }
      }
      throw error
    } finally {
      guard.release()
    }

    const seriesPoints = result.series.reduce((n, s) => n + s.points.length, 0)
    await markSync(auth, true, `ok stats=${valid.length} rejects=${rejects.length}`)
    console.log(
      `[first-party] ${auth.platform}/${auth.trader_id}: stats=${valid.length} series_pts=${seriesPoints} equity=${result.snapshot.equity}`
    )
    return { ok: true, statsWritten: valid.length, seriesPoints, detail: 'ok' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await markSync(auth, false, msg, {
      userId: auth.user_id,
      platform: auth.platform,
      traderId: auth.trader_id,
    })
    console.warn(`[first-party] ${auth.platform}/${auth.trader_id} failed: ${msg}`)
    return { ok: false, statsWritten: 0, seriesPoints: 0, detail: msg }
  }
}
