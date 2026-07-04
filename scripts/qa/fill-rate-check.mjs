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

/**
 * 第 3 层:每日快照 + 回填趋势哨兵。
 * series-backfill 是数天/周级渐进回填 — 「7 天填充零增长且未接近满」=
 * 回填带被饿死/楔死的早期信号(2026-07-03 事故的预警形态)。
 * 满 7 天数据前静默(建库期不误报);只盯开了 series_backfill 的源的
 * profile-refill 指标(mdd/win_positions/copier_pnl 等),合法稀疏但稳定
 * 的指标(如 bybit_copytrade 的 pnl)不在盯范围。
 */
const TREND_METRICS = new Set(['mdd', 'win_positions', 'copier_pnl', 'sharpe', 'copier_count'])
const TREND_PLATEAU_OK = 0.9 // 填充 ≥90% 视为已完成,平坦不再告警

async function snapshotAndTrend(pool, rows) {
  // 1) upsert 今日快照(幂等,同日重跑覆盖)
  const values = []
  const params = []
  let i = 1
  for (const r of rows) {
    values.push(`(current_date, $${i++}, $${i++}, $${i++}, $${i++})`)
    params.push(r.slug, r.metric, Number(r.filled), Number(r.total))
  }
  if (values.length > 0) {
    await pool.query(
      `insert into arena.metric_fill_trend (taken_on, slug, metric, filled, total)
       values ${values.join(',')}
       on conflict (taken_on, slug, metric)
       do update set filled = excluded.filled, total = excluded.total`,
      params
    )
  }

  // 2) 趋势:回填源 × 盯梢指标,今日 filled ≤ 7 天前 filled 且未达 90% → 停滞
  const { rows: stalled } = await pool.query(
    `with backfill_sources as (
       select slug from arena.sources
       where status = 'active' and (meta->>'series_backfill_topn')::bigint > deep_profile_topn
     )
     select today.slug, today.metric, today.filled, today.total, old.filled as filled_7d_ago
     from arena.metric_fill_trend today
     join arena.metric_fill_trend old
       on old.slug = today.slug and old.metric = today.metric
      and old.taken_on = current_date - 7
     join backfill_sources b on b.slug = today.slug
     where today.taken_on = current_date
       and today.filled <= old.filled
       and today.total > 0
       and today.filled::float / today.total < ${TREND_PLATEAU_OK}`
  )
  return stalled.filter((s) => TREND_METRICS.has(s.metric))
}

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

    // 第 3 层快照+趋势 — 基建性失败不红(表缺失/写失败只打日志)
    let stalled = []
    try {
      stalled = await snapshotAndTrend(pool, rows)
      console.log('📈 今日填充快照已写入 arena.metric_fill_trend')
    } catch (err) {
      console.error('trend snapshot failed (not a violation):', err.message)
    }
    for (const s of stalled) {
      violations.push(
        `${s.slug}.${s.metric} 回填停滞:7 天零增长(${s.filled_7d_ago}→${s.filled}/${s.total})— 查 series-backfill 是否又被饿死`
      )
    }

    if (violations.length === 0) {
      console.log('✅ 无断链、无回填停滞')
      return 0
    }
    console.error(`❌ ${violations.length} 处异常:`)
    for (const v of violations) console.error(`   - ${v}`)
    console.error('   (断链→修 parser 或记 EXEMPT;停滞→查 worker tierbs 日志/队列)')
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
