#!/usr/bin/env node
/**
 * 渲染覆盖契约检查(数据全面度第 2 层:库里有 vs 页面拿得到)
 *
 * 对每个 active serving 源取一个「黄金交易员」(tf90 typed 指标填充最多的),
 * 打真实生产 API `/api/traders/<id>/core?source&tf=90`(交易员详情页
 * useTraderCore 实际消费的端点),断言:**DB 里非空的能力指标,API 响应的
 * stats 里也必须非空** — 抓「数据在库、serving/映射层丢了」的断链
 * (2026-07-03 bybit sortino 断链的自动化形态,该类占显示断链的大头)。
 *
 * DOM 级渲染断言(前端 grid 读错 key)不在本层 — 属 UI 工作配套的
 * Playwright 检查。DB/合同失明硬红；单来源 API 网络/5xx/超时保留告警,
 * 防瞬时抖动误报。
 *
 * Run: node scripts/qa/render-coverage-check.mjs   (needs DATABASE_URL; unset = skip)
 * Exit: 0 = green/skipped, 1 = contract violations.
 */

import { pathToFileURL } from 'node:url'
import { TYPED_METRICS } from './metric-columns.mjs'

const BASE = process.env.ARENA_BASE_URL || 'https://www.arenafi.org'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 ArenaQA-render-coverage'

/** typed 指标列 — 单一来源 metric-columns.mjs(P4)。 */
const METRICS = TYPED_METRICS

/** `slug:metric` → 理由。只豁免核实过的。 */
const EXEMPT = new Map([])

/** 黄金交易员:该源 tf90 typed 指标非空数最多、最新的一个。 */
const GOLDEN_SQL = `
with candidates as (
  select s.slug, t.exchange_trader_id,
    ${METRICS.map((m) => `ts.${m} is not null as has_${m}`).join(',\n    ')},
    (${METRICS.map((m) => `(ts.${m} is not null)::int`).join(' + ')}) as filled_n,
    row_number() over (
      partition by s.id
      order by (${METRICS.map((m) => `(ts.${m} is not null)::int`).join(' + ')}) desc, ts.as_of desc
    ) as rn
  from arena.trader_stats ts
  join arena.traders t on t.id = ts.trader_id
  join arena.sources s on s.id = t.source_id and s.status = 'active'
  join arena.mv_source_capabilities c on c.slug = s.slug
  where ts.timeframe = 90 and coalesce(c.cap->>'servingMode','serving') = 'serving'
)
select * from candidates where rn = 1
`

async function fetchCore(slug, traderId) {
  const url = `${BASE}/api/traders/${encodeURIComponent(traderId)}/core?source=${encodeURIComponent(slug)}&tf=90`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20_000)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal })
    if (res.status !== 200) return { infra: `HTTP ${res.status}` }
    const body = await res.json()
    if (!body?.success || !body?.data) return { infra: `success=false` }
    return { stats: body.data.stats ?? {} }
  } catch (e) {
    return { infra: e.name === 'AbortError' ? 'timeout' : e.message }
  } finally {
    clearTimeout(timer)
  }
}

export async function main(env = process.env) {
  const dbUrl = env.DATABASE_URL
  if (!dbUrl) {
    if (env.REQUIRE_DATABASE_URL === '1') {
      console.error('render-coverage-check requires DATABASE_URL in this environment')
      return 1
    }
    console.log(
      '⏭️  render-coverage-check SKIPPED — DATABASE_URL not set (set it to enable the gate)'
    )
    return 0
  }
  const { default: pg } = await import('pg')
  const pool = new pg.Pool({ connectionString: dbUrl, max: 2 })
  const violations = []
  const infra = []
  let checked = 0
  try {
    const { rows } = await pool.query(GOLDEN_SQL)
    for (const g of rows) {
      const res = await fetchCore(g.slug, g.exchange_trader_id)
      if (res.infra) {
        infra.push(`${g.slug}: ${res.infra}`)
        continue
      }
      for (const m of METRICS) {
        if (!g[`has_${m}`]) continue // DB 本就没有 — 不属本契约
        checked++
        const v = res.stats[m]
        if (v !== null && v !== undefined) continue
        const key = `${g.slug}:${m}`
        if (EXEMPT.has(key)) continue
        violations.push(
          `${g.slug}.${m} DB 有值但 /core API 丢失(黄金交易员 ${g.exchange_trader_id})`
        )
      }
      await new Promise((r) => setTimeout(r, 300)) // 温和节流
    }
  } finally {
    await pool.end()
  }

  console.log(`render-coverage-check: ${checked} 个 DB→API 指标契约已核`)
  if (infra.length > 0) {
    console.log(`⚠️  ${infra.length} 个源基建失败(不判红):${infra.slice(0, 5).join('; ')}`)
  }
  if (violations.length === 0) {
    console.log('✅ 无渲染层断链 — DB 有的指标 API 全部可达')
    return 0
  }
  console.error(`❌ ${violations.length} 处 DB→API 断链(serving/映射层丢数据):`)
  for (const v of violations) console.error(`   - ${v}`)
  return 1
}

const invokedDirectly =
  process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(
        'render-coverage-check infrastructure/contract error:',
        err instanceof Error ? err.message : String(err)
      )
      process.exit(1)
    }
  )
}
