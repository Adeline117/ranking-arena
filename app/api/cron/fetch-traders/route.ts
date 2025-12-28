import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY! // 只放服务端，绝对不要放到前端
)

type NormalizedRow = {
  source: string
  source_trader_id: string
  handle: string
  roi: number | null
  win_rate: number | null
  followers: number | null
  pnl: number | null
  rank: number | null
  profile_url?: string | null
}

function mustEnv(name: string) {
  const v = process.env[name]
  if (!v) throw new Error(`Missing env: ${name}`)
  return v
}

/**
 * ⚠️ 这里先写“假抓取”，你确认流程通了以后，
 * 再把 fetchBybit/fetchBitget 换成真实抓取逻辑（见第 4 步）
 */
async function fetchBybitMock(): Promise<NormalizedRow[]> {
  return [
    { source: 'bybit', source_trader_id: 'zero_chill', handle: 'zero_chill', roi: 120.0, win_rate: 49, followers: 15000, pnl: null, rank: 1, profile_url: null },
    { source: 'bybit', source_trader_id: 'night_whale', handle: 'night_whale', roi: 85.2, win_rate: 54, followers: 8800, pnl: null, rank: 2, profile_url: null },
  ]
}

async function fetchBitgetMock(): Promise<NormalizedRow[]> {
  return [
    { source: 'bitget', source_trader_id: 'alpha_fox', handle: 'alpha_fox', roi: 42.5, win_rate: 61, followers: 1200, pnl: null, rank: 3, profile_url: null },
  ]
}

export async function POST(req: Request) {
  // 1) 简单鉴权：防止别人随便调用你的 cron
  const secret = mustEnv('CRON_SECRET')
  const got = req.headers.get('x-cron-secret')
  if (got !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    // 2) 抓取（先 mock，流程通了再接真实）
    const rows = [...(await fetchBybitMock()), ...(await fetchBitgetMock())]

    const now = new Date().toISOString()

    // 3) 写入 snapshots（历史）
    if (rows.length) {
      await supabaseAdmin.from('trader_snapshots').insert(
        rows.map((r) => ({
          source: r.source,
          source_trader_id: r.source_trader_id,
          roi: r.roi,
          pnl: r.pnl,
          win_rate: r.win_rate,
          followers: r.followers,
          rank: r.rank,
          captured_at: now,
        }))
      )
    }

    // 4) upsert 到 traders（最新汇总，用于首页）
    // 你现在 traders 表字段：id/handle/roi/win_rate/followers...
    // 这里假设 handle 唯一；如果你要跨源同名不冲突，建议 key 用 (source, source_trader_id)
    for (const r of rows) {
      await supabaseAdmin
        .from('traders')
        .upsert(
          {
            id: `${r.source}:${r.source_trader_id}`, // ✅ 用组合 id，避免重复
            handle: r.handle,
            roi: r.roi ?? 0,
            win_rate: r.win_rate ?? 0,
            followers: r.followers ?? 0,
            source: r.source,
            source_trader_id: r.source_trader_id,
            updated_at: now,
          },
          { onConflict: 'id' }
        )
    }

    return NextResponse.json({ ok: true, count: rows.length })
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? 'unknown' }, { status: 500 })
  }
}