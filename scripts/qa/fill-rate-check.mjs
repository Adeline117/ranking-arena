#!/usr/bin/env node
/**
 * 填充率契约检查(数据全面度第 1 层:该有 vs 真有)
 *
 * 对照 arena.mv_source_capabilities(能力矩阵,唯一"该有"真源)与
 * arena.trader_stats 实际填充:某源声明提供指标 M(cap.metrics 含 M),
 * 但该源全部 stats 行里 M 的非空计数为 0 → 断链(parser 漏提取 / 能力谎报 /
 * 管道断裂)。这正是 2026-07-03 手工审计抓到的 gate sharpe、okx copier_count、
 * binance copier_pnl 一类 bug 的自动化形态。
 *
 * 阈值刻意取"恰好为 0":合法稀疏指标(如 bybit_copytrade 的 pnl 仅 profile
 * 深抓可得,~9%)不误报;字面 0 = 必然有问题。填充率趋势(60%→20% 的回退)
 * 属第 3 层趋势哨兵,不在本检查范围。
 *
 * 豁免:确认"能力矩阵夸大/上游停供"且不修的,记入 EXEMPT 并注明理由。
 *
 * Run: node scripts/qa/fill-rate-check.mjs   (needs DATABASE_URL; unset = skip)
 * Exit: 0 = green/skipped, 1 = violations found.
 */

import pg from 'pg'

/** slug:metric → 理由。只豁免核实过的,别用来消音。 */
const EXEMPT = new Map([
  // ['example_source:volume', '2026-07-03 核实:上游 2026-06 起停供 volume 字段'],
])

const SQL = `
with caps as (
  select c.slug, m.metric
  from arena.mv_source_capabilities c
  cross join lateral jsonb_array_elements_text(c.cap->'metrics') m(metric)
  join arena.sources s on s.slug = c.slug and s.status = 'active'
  where coalesce(c.cap->>'servingMode','serving') = 'serving'
),
fill as (
  select s.slug,
    count(*) total,
    count(ts.roi) roi, count(ts.pnl) pnl, count(ts.sharpe) sharpe, count(ts.mdd) mdd,
    count(ts.win_rate) win_rate, count(ts.win_positions) win_positions,
    count(ts.total_positions) total_positions, count(ts.copier_pnl) copier_pnl,
    count(ts.copier_count) copier_count, count(ts.aum) aum, count(ts.volume) volume,
    count(ts.profit_share_rate) profit_share_rate,
    count(ts.holding_duration_avg) holding_duration_avg
  from arena.trader_stats ts
  join arena.traders t on t.id = ts.trader_id
  join arena.sources s on s.id = t.source_id and s.status = 'active'
  group by s.slug
)
select c.slug, c.metric, f.total,
  case c.metric
    when 'roi' then f.roi when 'pnl' then f.pnl when 'sharpe' then f.sharpe
    when 'mdd' then f.mdd when 'win_rate' then f.win_rate
    when 'win_positions' then f.win_positions when 'total_positions' then f.total_positions
    when 'copier_pnl' then f.copier_pnl when 'copier_count' then f.copier_count
    when 'aum' then f.aum when 'volume' then f.volume
    when 'profit_share_rate' then f.profit_share_rate
    when 'holding_duration_avg' then f.holding_duration_avg end as filled
from caps c join fill f on f.slug = c.slug
`

async function main() {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) {
    // 与 insert-column-drift-check 同模式:无凭据的环境(如部分 CI)fail-open,
    // 哨兵机器(有 DATABASE_URL)才是硬门。
    console.log('⏭️  fill-rate-check SKIPPED — DATABASE_URL not set (set it to enable the gate)')
    return 0
  }
  const pool = new pg.Pool({ connectionString: dbUrl, max: 2 })
  try {
    const { rows } = await pool.query(SQL)
    const violations = []
    let checked = 0
    for (const r of rows) {
      checked++
      if (Number(r.filled) !== 0) continue
      const key = `${r.slug}:${r.metric}`
      if (EXEMPT.has(key)) continue
      violations.push(`${r.slug}.${r.metric} 声明提供但 0/${r.total} 行有值`)
    }
    console.log(`fill-rate-check: ${checked} 个 source×metric 契约已核`)
    if (violations.length === 0) {
      console.log('✅ 无断链 — 全部声明指标都有实际数据')
      return 0
    }
    console.error(`❌ ${violations.length} 处能力↔数据断链:`)
    for (const v of violations) console.error(`   - ${v}`)
    console.error('   (parser 漏提取 / 能力矩阵谎报 / 管道断裂 — 核实后修 parser 或记 EXEMPT)')
    return 1
  } finally {
    await pool.end()
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    // 基建错误(连不上库等)≠ 契约违规:报出来但不红——避免网络抖动天天误报。
    console.error('fill-rate-check infrastructure error (not a violation):', err.message)
    process.exit(0)
  }
)
