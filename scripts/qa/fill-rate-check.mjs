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
 * 第 1 层阈值刻意取"恰好为 0":合法稀疏指标(如 bybit_copytrade 的 pnl 仅
 * profile 深抓可得,~9%)不误报;字面 0 = 必然有问题。
 *
 * 第 1.5 层(2026-07-07 新增):低填充比率 + 按 timeframe 拆分。补上「声明提供
 * 却长期近空」(binance sharpe 2%、gate sharpe ~1%、hyperliquid tf7/30 ~5%)——
 * 这类有几行非空、被第 1 层放行、又被 slug 聚合掩盖(tf90 盖 tf7/30)的断裂。
 * 默认只报不红(STRICT_LOW_FILL=1 计入 exit);填充率趋势(60%→20% 回退)属第
 * 3 层趋势哨兵。
 *
 * 豁免:确认"能力矩阵夸大/上游停供"且不修的,记入 EXEMPT 并注明理由。
 *
 * Run: node scripts/qa/fill-rate-check.mjs   (needs DATABASE_URL; unset = skip)
 * Exit: 0 = green/skipped, 1 = violations found.
 */

import pg from 'pg'
import { TREND_METRICS as TREND_METRIC_LIST } from './metric-columns.mjs'

/** slug:metric → 理由。只豁免核实过的,别用来消音。 */
const EXEMPT = new Map([
  // ['example_source:volume', '2026-07-03 核实:上游 2026-06 起停供 volume 字段'],
])

// ── 第 1.5 层:低填充比率哨兵(2026-07-07)──────────────────────────────
// 「仅字面 0」的硬门放行了 binance sharpe(2%)、gate sharpe(~1%)、binance
// mdd(16%)一类「声明提供却长期近空」的断裂 —— 有几行非空就算绿。这一层补上
// 比率维度:声明的指标在「成熟时间框」(行数 ≥ MIN_ROWS)填充率低于 LOW_FILL_PCT
// → 告警。默认只报不红(STRICT_LOW_FILL=1 才计入 exit),因为 series-backfill
// 游标 bug(docs/SERIES_BACKFILL_CURSOR_FIX_PLAN.md)未修前长尾会长期偏低,
// 硬红会天天误报;修复+回填铺满后应开 STRICT 让它守回退。
const LOW_FILL_PCT = Number(process.env.LOW_FILL_PCT ?? 0.2)
const LOW_FILL_MIN_ROWS = Number(process.env.LOW_FILL_MIN_ROWS ?? 200)
const STRICT_LOW_FILL = process.env.STRICT_LOW_FILL === '1'
/** slug:metric → 理由。核实为「合法稀疏」的声明指标,不进低填充告警。 */
const LOW_FILL_EXEMPT = new Map([
  ['bybit_copytrade:pnl', '核实:pnl 仅 profile 深抓可得 ~9%,roi 才是板级 headline'],
])

// "该有"真源优先级(P0 2026-07-04):adapter 代码声明的 expected_metrics
// (reconcile 每小时同步进 sources.meta)> mv cap.metrics 兜底。
// mv 的 metrics 是从 trader_stats count>0 反推的 —— 度量"真有"而非"该有",
// 用它当契约是循环论证(parser 漏提取 → count=0 → 不声明 → 永不违规,
// gate-sharpe 类 bug 隐形)。声明未铺满前,未声明的源回落 mv(弱保护)。
const SQL = `
with caps as (
  select s.slug, m.metric,
         (s.meta ? 'expected_metrics') as declared
  from arena.sources s
  join arena.mv_source_capabilities c on c.slug = s.slug
  cross join lateral jsonb_array_elements_text(
    coalesce(s.meta->'expected_metrics', c.cap->'metrics')
  ) m(metric)
  where s.status = 'active'
    and coalesce(c.cap->>'servingMode','serving') = 'serving'
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
const TREND_METRICS = new Set(TREND_METRIC_LIST) // 单一来源 metric-columns.mjs(P4)
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

/**
 * 第 1.5 层:每 (slug, timeframe, 声明指标) 的填充比率。按 timeframe 拆分
 * 是关键 —— 现有 SQL 按 slug 聚合会让健康的 tf90 掩盖死掉的 tf7/tf30
 * (hyperliquid sharpe tf90 63% 盖住 tf7/30 的 ~5%)。只看声明提供的指标,
 * 只看行数 ≥ MIN_ROWS 的成熟时间框,避免小样本噪声。
 */
const LOW_FILL_SQL = `
with caps as (
  select s.slug, m.metric
  from arena.sources s
  join arena.mv_source_capabilities c on c.slug = s.slug
  cross join lateral jsonb_array_elements_text(
    coalesce(s.meta->'expected_metrics', c.cap->'metrics')
  ) m(metric)
  where s.status = 'active'
    and coalesce(c.cap->>'servingMode','serving') = 'serving'
),
fill as (
  select s.slug, ts.timeframe,
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
  where ts.timeframe in (7, 30, 90)
  group by s.slug, ts.timeframe
)
select c.slug, f.timeframe, c.metric, f.total,
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

async function lowFillWarnings(pool) {
  const { rows } = await pool.query(LOW_FILL_SQL)
  const warns = []
  for (const r of rows) {
    const total = Number(r.total)
    const filled = Number(r.filled)
    if (total < LOW_FILL_MIN_ROWS) continue // 小样本不判
    if (filled === 0) continue // 字面 0 归第 1 层硬门,不在这里重复
    if (LOW_FILL_EXEMPT.has(`${r.slug}:${r.metric}`)) continue
    const ratio = filled / total
    if (ratio < LOW_FILL_PCT) {
      warns.push({
        slug: r.slug,
        timeframe: r.timeframe,
        metric: r.metric,
        pct: (ratio * 100).toFixed(1),
        filled,
        total,
      })
    }
  }
  // 最低填充优先,便于一眼看最坏的
  warns.sort((a, b) => Number(a.pct) - Number(b.pct))
  return warns
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

    // 第 1.5 层:低填充比率(按 timeframe 拆分)。默认只报不红。
    let lowFill = []
    try {
      lowFill = await lowFillWarnings(pool)
    } catch (err) {
      console.error('low-fill scan failed (not a violation):', err.message)
    }
    if (lowFill.length > 0) {
      console.warn(
        `⚠️  ${lowFill.length} 处声明指标填充率 < ${(LOW_FILL_PCT * 100).toFixed(0)}%` +
          `(成熟时间框, ≥${LOW_FILL_MIN_ROWS} 行):`
      )
      for (const w of lowFill) {
        console.warn(
          `   - ${w.slug}.${w.metric} [tf${w.timeframe}] ${w.pct}% (${w.filled}/${w.total})`
        )
      }
      console.warn(
        '   多数系 series-backfill 游标 bug 导致长尾未抓(见 docs/SERIES_BACKFILL_CURSOR_FIX_PLAN.md);' +
          '\n   修复+回填铺满后设 STRICT_LOW_FILL=1 让本层守住回退。真上游稀疏的记入 LOW_FILL_EXEMPT。'
      )
      if (STRICT_LOW_FILL) {
        for (const w of lowFill) {
          violations.push(
            `${w.slug}.${w.metric} [tf${w.timeframe}] 填充仅 ${w.pct}% (${w.filled}/${w.total})`
          )
        }
      }
    }

    if (violations.length === 0) {
      console.log(`✅ 无断链、无回填停滞${lowFill.length ? '(低填充仅告警,未计入)' : ''}`)
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
